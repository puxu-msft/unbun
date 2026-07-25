import hashlib
import errno
import os
import stat
import threading
import uuid
from pathlib import Path

import pytest

from cc_patch import atomicio
from cc_patch.store import StoreError


@pytest.fixture(autouse=True)
def isolated_store(monkeypatch, tmp_path):
    monkeypatch.setenv("UNBUN_CC_STORE", str(tmp_path / "store"))


def snapshot_binary(tmp_path, version: str = "2.1.207") -> Path:
    binary = tmp_path / "versions" / "claude"
    binary.parent.mkdir(exist_ok=True)
    binary.write_bytes(versioned(version, b"entry"))
    return binary


def versioned(version: str, payload: bytes = b"") -> bytes:
    return b'overview",VERSION:"' + version.encode() + b'";' + payload


def test_atomic_write_replaces_content_and_preserves_entry_mode(tmp_path):
    binary = tmp_path / "claude"
    binary.write_bytes(b"old")
    binary.chmod(0o640)

    atomicio.atomic_write(binary, b"new")

    assert binary.read_bytes() == b"new"
    assert stat.S_IMODE(binary.stat().st_mode) == 0o640
    assert not any(path.name.startswith(".claude.tmp.") for path in tmp_path.iterdir())


def test_prepare_atomic_temp_fsyncs_reads_back_and_copies_entry_mode(
    monkeypatch, tmp_path
):
    binary = tmp_path / "claude"
    binary.write_bytes(b"old")
    binary.chmod(0o751)
    fsynced = []
    real_fsync = os.fsync

    def recording_fsync(descriptor):
        fsynced.append(descriptor)
        real_fsync(descriptor)

    monkeypatch.setattr(os, "fsync", recording_fsync)

    temp = atomicio._prepare_atomic_temp(binary, b"new")

    assert fsynced
    assert temp.read_bytes() == b"new"
    assert stat.S_IMODE(temp.stat().st_mode) == 0o751
    assert temp.parent == binary.parent
    assert temp.name.startswith(".claude.tmp.")
    assert uuid.UUID(temp.name.removeprefix(".claude.tmp."), version=4)
    temp.unlink()


def test_prepare_atomic_temp_readback_mismatch_removes_temp(monkeypatch, tmp_path):
    binary = tmp_path / "claude"
    binary.write_bytes(b"old")
    real_read_bytes = Path.read_bytes

    def corrupt_temp_read(target):
        data = real_read_bytes(target)
        return b"corrupt" if target.name.startswith(".claude.tmp.") else data

    monkeypatch.setattr(Path, "read_bytes", corrupt_temp_read)

    with pytest.raises(atomicio.AtomicContentMismatch):
        atomicio._prepare_atomic_temp(binary, b"new")

    assert not any(path.name.startswith(".claude.tmp.") for path in tmp_path.iterdir())


def test_atomic_write_if_unchanged_checks_after_temp_write_before_replace(monkeypatch, tmp_path):
    binary = tmp_path / "claude"
    binary.write_bytes(b"old")
    replacements = []
    original_write_bytes = Path.write_bytes

    real_prepare = atomicio._prepare_atomic_temp

    def upgrading_prepare(target, data):
        temp = real_prepare(target, data)
        original_write_bytes(binary, b"upgraded")
        return temp

    monkeypatch.setattr(atomicio, "_prepare_atomic_temp", upgrading_prepare)
    monkeypatch.setattr(os, "replace", lambda *args: replacements.append(args))

    with pytest.raises(atomicio.ConcurrentFileChange):
        atomicio.atomic_write_if_unchanged(binary, b"new", b"old")

    assert replacements == []
    assert binary.read_bytes() == b"upgraded"
    assert not any(path.name.startswith(".claude.tmp.") for path in tmp_path.iterdir())


def test_atomic_write_runs_proof_after_temp_readback_immediately_before_replace(
    monkeypatch, tmp_path
):
    binary = tmp_path / "claude"
    binary.write_bytes(b"old")
    events = []
    real_prepare = atomicio._prepare_atomic_temp
    real_replace = atomicio._replace_atomic_temp

    def recording_prepare(target, data):
        temp = real_prepare(target, data)
        events.append("prepared")
        return temp

    def recording_replace(target, temp):
        events.append("replace")
        real_replace(target, temp)

    monkeypatch.setattr(atomicio, "_prepare_atomic_temp", recording_prepare)
    monkeypatch.setattr(atomicio, "_replace_atomic_temp", recording_replace)

    atomicio.atomic_write_if_unchanged(
        binary,
        b"new",
        b"old",
        before_replace=lambda observed: events.append(("proof", observed)),
    )

    assert events == ["prepared", ("proof", b"old"), "replace"]


def test_concurrent_writes_use_unique_temps_without_cross_contamination(monkeypatch, tmp_path):
    binary = tmp_path / "claude"
    binary.write_bytes(b"old")
    prepared = threading.Barrier(2)
    replaced_sources = []
    original_replace = os.replace

    def synchronized_replace(source, target):
        replaced_sources.append(Path(source))
        prepared.wait(timeout=5)
        original_replace(source, target)

    monkeypatch.setattr(os, "replace", synchronized_replace)
    errors = []

    def writer(data):
        try:
            atomicio.atomic_write(binary, data)
        except Exception as error:
            errors.append(error)

    first = threading.Thread(target=writer, args=(b"first",))
    second = threading.Thread(target=writer, args=(b"second",))
    first.start()
    second.start()
    first.join(timeout=5)
    second.join(timeout=5)

    assert errors == []
    assert len(set(replaced_sources)) == 2
    assert all(source.parent == binary.parent for source in replaced_sources)
    assert binary.read_bytes() in {b"first", b"second"}
    assert not any(path.name.startswith(".claude.tmp.") for path in tmp_path.iterdir())


def test_atomic_write_general_replace_error_cleans_unique_temp(monkeypatch, tmp_path):
    binary = tmp_path / "claude"
    binary.write_bytes(b"old")
    monkeypatch.setattr(os, "replace", lambda *_args: (_ for _ in ()).throw(OSError("rename failed")))

    with pytest.raises(OSError, match="rename failed"):
        atomicio.atomic_write(binary, b"new")

    assert binary.read_bytes() == b"old"
    assert not any(path.name.startswith(".claude.tmp.") for path in tmp_path.iterdir())


def test_atomic_write_binary_in_use_exposes_verified_ready_temp(monkeypatch, tmp_path):
    binary = tmp_path / "claude"
    binary.write_bytes(b"old")
    monkeypatch.setattr(os, "replace", lambda _src, _dst: (_ for _ in ()).throw(PermissionError()))

    with pytest.raises(atomicio.BinaryInUse) as error:
        atomicio.atomic_write(binary, b"new")

    temps = list(tmp_path.glob(".claude.tmp.*"))
    assert len(temps) == 1
    assert error.value.ready_temp == temps[0]
    assert temps[0].read_bytes() == b"new"
    assert binary.read_bytes() == b"old"


@pytest.mark.parametrize("error_number", [errno.EACCES, errno.EPERM, errno.EBUSY])
def test_atomic_write_maps_platform_binary_in_use_errnos(
    monkeypatch, tmp_path, error_number
):
    binary = tmp_path / "claude"
    binary.write_bytes(b"old")
    monkeypatch.setattr(
        os,
        "replace",
        lambda _src, _dst: (_ for _ in ()).throw(
            OSError(error_number, "binary in use")
        ),
    )

    with pytest.raises(atomicio.BinaryInUse) as caught:
        atomicio.atomic_write(binary, b"new")

    assert caught.value.ready_temp.read_bytes() == b"new"
    assert binary.read_bytes() == b"old"


def test_version_keyed_baseline_and_snapshot_paths(monkeypatch, tmp_path):
    backups = tmp_path / "backups"
    monkeypatch.setattr(atomicio, "BACKUP_DIR", backups)
    binary = Path("/a/b/claude")
    pathhash = hashlib.sha256(str(binary.resolve()).encode()).hexdigest()[:12]

    assert atomicio.baseline_path(binary, "2.1.207") == (
        backups / f"{pathhash}__claude__2.1.207.ccbak"
    )
    assert atomicio.snapshot_path(binary, "2.1.207", "before-test") == (
        backups / f"{pathhash}__claude__2.1.207--before-test.ccsnap"
    )


@pytest.mark.parametrize("version", ["2.1.207", "1", "12.0"])
def test_valid_version_formats(version):
    assert atomicio.is_valid_version_format(version)


@pytest.mark.parametrize("version", ["", "2.1.", ".2.1", "2.a.1", "2..1", "v2.1"])
def test_invalid_version_formats(version):
    assert not atomicio.is_valid_version_format(version)


@pytest.mark.parametrize("slug", ["before-test", "v1", "release-2026-07"])
def test_valid_snapshot_slugs(slug):
    assert atomicio.is_valid_snapshot_slug(slug)


@pytest.mark.parametrize(
    "slug",
    ["", "Before-test", "before_test", "before--test", "before__test", "../test", "a/b", r"a\\b", "测试"],
)
def test_invalid_snapshot_slugs(slug):
    assert not atomicio.is_valid_snapshot_slug(slug)


def test_path_helpers_reject_invalid_version_or_slug(tmp_path):
    binary = tmp_path / "claude"

    with pytest.raises(ValueError, match="version format"):
        atomicio.baseline_path(binary, "2.1.")
    with pytest.raises(ValueError, match="snapshot name"):
        atomicio.snapshot_path(binary, "2.1.207", "../escape")


def test_same_parent_and_filename_at_distinct_absolute_paths_do_not_share_baseline(
    monkeypatch, tmp_path
):
    monkeypatch.setattr(atomicio, "BACKUP_DIR", tmp_path / "backups")
    first = tmp_path / "a" / "versions" / "claude"
    second = tmp_path / "b" / "versions" / "claude"
    first.parent.mkdir(parents=True)
    second.parent.mkdir(parents=True)
    first.write_bytes(b"first")
    second.write_bytes(b"second")

    first_path = atomicio.establish_baseline(first, b"first", "2.1.207")
    second_path = atomicio.establish_baseline(second, b"second", "2.1.207")

    assert first_path != second_path
    assert first_path.read_bytes() == b"first"
    assert second_path.read_bytes() == b"second"


def test_same_parent_and_filename_at_distinct_paths_do_not_share_snapshots(
    monkeypatch, tmp_path
):
    monkeypatch.setattr(atomicio, "BACKUP_DIR", tmp_path / "backups")
    first = tmp_path / "a" / "versions" / "claude"
    second = tmp_path / "b" / "versions" / "claude"
    first.parent.mkdir(parents=True)
    second.parent.mkdir(parents=True)
    first.write_bytes(b"first")
    second.write_bytes(b"second")

    first_snapshot = atomicio.save_snapshot(first, versioned("2.1.207", b"first"), "2.1.207", "same")
    second_snapshot = atomicio.save_snapshot(second, versioned("2.1.207", b"second"), "2.1.207", "same")

    assert first_snapshot != second_snapshot
    assert [info.path for info in atomicio.list_snapshots(first, "2.1.207")] == [first_snapshot]
    assert [info.path for info in atomicio.list_snapshots(second, "2.1.207")] == [second_snapshot]


def test_find_baseline_returns_matching_version_only(monkeypatch, tmp_path):
    monkeypatch.setattr(atomicio, "BACKUP_DIR", tmp_path / "backups")
    binary = tmp_path / "versions" / "claude"
    binary.parent.mkdir()
    binary.write_bytes(b"current")

    assert atomicio.find_baseline(binary, "2.1.207") is None
    old = atomicio.baseline_path(binary, "2.1.206")
    old.parent.mkdir()
    old.write_bytes(b"old")
    assert atomicio.find_baseline(binary, "2.1.207") is None

    current = atomicio.baseline_path(binary, "2.1.207")
    current.write_bytes(b"clean")
    assert atomicio.find_baseline(binary, "2.1.207") == current


def test_prepare_and_publish_baseline_is_hidden_until_no_clobber_publish(monkeypatch, tmp_path):
    monkeypatch.setattr(atomicio, "BACKUP_DIR", tmp_path / "backups")
    binary = tmp_path / "versions" / "claude"
    binary.parent.mkdir()
    final = atomicio.baseline_path(binary, "2.1.207")

    temp = atomicio.prepare_baseline(binary, b"clean", "2.1.207")

    assert temp.read_bytes() == b"clean"
    assert final.exists() is False
    assert atomicio.find_baseline(binary, "2.1.207") is None

    atomicio.publish_baseline_noreplace(temp, final)

    assert final.read_bytes() == b"clean"
    assert temp.exists() is False


def test_publish_baseline_noreplace_preserves_existing_bytes(monkeypatch, tmp_path):
    monkeypatch.setattr(atomicio, "BACKUP_DIR", tmp_path / "backups")
    binary = tmp_path / "versions" / "claude"
    binary.parent.mkdir()
    final = atomicio.establish_baseline(binary, b"first", "2.1.207")
    temp = atomicio.prepare_baseline(binary, b"second", "2.1.207")

    with pytest.raises(atomicio.BaselineExists):
        atomicio.publish_baseline_noreplace(temp, final)

    assert final.read_bytes() == b"first"
    temp.unlink(missing_ok=True)


def test_establish_baseline_round_trip_and_refuses_overwrite(monkeypatch, tmp_path):
    monkeypatch.setattr(atomicio, "BACKUP_DIR", tmp_path / "backups")
    binary = tmp_path / "versions" / "claude"
    binary.parent.mkdir()
    binary.write_bytes(b"current")

    path = atomicio.establish_baseline(binary, b"clean", "2.1.207")

    assert path == atomicio.find_baseline(binary, "2.1.207")
    assert path.read_bytes() == b"clean"
    with pytest.raises(atomicio.BaselineExists):
        atomicio.establish_baseline(binary, b"different", "2.1.207")
    assert path.read_bytes() == b"clean"


def test_version_drift_carries_expected_and_actual():
    error = atomicio.VersionDrift("2.1.206", "2.1.207")

    assert error.expected == "2.1.206"
    assert error.actual == "2.1.207"
    assert "2.1.206" in str(error)
    assert "2.1.207" in str(error)


def test_save_snapshot_rejects_embedded_version_mismatch(monkeypatch, tmp_path, make_bundle):
    binary = snapshot_binary(tmp_path)
    data = bytes(make_bundle())

    with pytest.raises(StoreError) as caught:
        atomicio.save_snapshot(binary, data, "2.1.174", "mismatch")

    assert caught.value.code == "snapshot_invalid"


def test_force_snapshot_save_uses_unique_temp_files(monkeypatch, tmp_path):
    binary = snapshot_binary(tmp_path)
    original = versioned("2.1.207", b"original")
    atomicio.save_snapshot(binary, original, "2.1.207", "force")
    sources = []
    real_replace = os.replace

    def recording_replace(source, target):
        sources.append(Path(source))
        real_replace(source, target)

    monkeypatch.setattr(os, "replace", recording_replace)
    atomicio.save_snapshot(binary, versioned("2.1.207", b"one"), "2.1.207", "force", force=True)
    atomicio.save_snapshot(binary, versioned("2.1.207", b"two"), "2.1.207", "force", force=True)

    manifest_replaces = [source for source in sources if source.name.startswith(".snapshot.json.tmp.")]
    assert len(set(manifest_replaces)) == 2
    assert all(source.parent.name == "force" for source in manifest_replaces)
    assert not any(path.name.startswith(".snapshot.json.tmp.") for path in manifest_replaces[0].parent.iterdir())


def test_save_snapshot_validates_slug_and_refuses_implicit_overwrite(monkeypatch, tmp_path):
    binary = snapshot_binary(tmp_path)

    with pytest.raises(StoreError) as invalid:
        atomicio.save_snapshot(binary, b"first", "2.1.207", "../escape")
    assert invalid.value.code == "snapshot_invalid"

    path = atomicio.save_snapshot(binary, versioned("2.1.207", b"first"), "2.1.207", "before-test")
    with pytest.raises(StoreError) as exists:
        atomicio.save_snapshot(binary, versioned("2.1.207", b"second"), "2.1.207", "before-test")
    assert exists.value.code == "snapshot_exists"

    second = versioned("2.1.207", b"second")
    assert atomicio.save_snapshot(binary, second, "2.1.207", "before-test", force=True) == path
    assert atomicio.list_snapshots(binary, "2.1.207")[0].invalid is False


def test_list_snapshots_preserves_slot_version_and_marks_invalid_manifests(
    monkeypatch, tmp_path
):
    binary = snapshot_binary(tmp_path)
    disguised = atomicio.save_snapshot(binary, versioned("2.1.207", b"old"), "2.1.207", "disguised")
    broken = atomicio.save_snapshot(binary, versioned("2.1.207", b"broken"), "2.1.207", "broken")
    import json

    disguised_manifest = json.loads(disguised.read_text(encoding="utf-8"))
    disguised_manifest["embedded_version"] = "2.1.206"
    disguised.write_text(json.dumps(disguised_manifest), encoding="utf-8")
    broken.write_bytes(b"not-json")

    infos = atomicio.list_snapshots(binary, "2.1.207")
    by_slug = {info.slug: info for info in infos}

    assert by_slug["disguised"].version == "2.1.207"
    assert by_slug["disguised"].is_stale is False
    assert by_slug["disguised"].invalid is True
    assert by_slug["broken"].version == "2.1.207"
    assert by_slug["broken"].is_stale is False
    assert by_slug["broken"].invalid is True


def test_list_snapshots_marks_other_versions_stale_and_reads_metadata(monkeypatch, tmp_path):
    binary = snapshot_binary(tmp_path)
    current = atomicio.save_snapshot(binary, versioned("2.1.207", b"current"), "2.1.207", "current")
    stale = atomicio.save_snapshot(binary, versioned("2.1.206", b"stale"), "2.1.206", "old")

    infos = atomicio.list_snapshots(binary, "2.1.207")

    assert [(info.path, info.version, info.slug, info.is_stale) for info in infos] == [
        (stale, "2.1.206", "old", True),
        (current, "2.1.207", "current", False),
    ]
    assert all(info.created_at.tzinfo is not None for info in infos)


def test_remove_snapshot_deletes_only_requested_slug(monkeypatch, tmp_path):
    assert atomicio.BACKUP_DIR == tmp_path / "legacy-backups"
    binary = snapshot_binary(tmp_path)
    baseline = atomicio.establish_baseline(binary, b"clean", "2.1.207")
    target = atomicio.save_snapshot(binary, versioned("2.1.207", b"target"), "2.1.207", "target")
    other = atomicio.save_snapshot(binary, versioned("2.1.206", b"other"), "2.1.206", "other")

    assert atomicio.remove_snapshot(binary, "target") == target

    assert not target.exists()
    assert baseline.read_bytes() == b"clean"
    assert other.exists()


def test_remove_snapshot_requires_version_for_same_slug_across_versions(monkeypatch, tmp_path):
    binary = snapshot_binary(tmp_path)
    old = atomicio.save_snapshot(binary, versioned("2.1.206", b"one"), "2.1.206", "same")
    current = atomicio.save_snapshot(binary, versioned("2.1.207", b"two"), "2.1.207", "same")

    with pytest.raises(StoreError) as ambiguous:
        atomicio.remove_snapshot(binary, "same")
    assert ambiguous.value.code == "snapshot_ambiguous"
    assert atomicio.remove_snapshot(binary, "same", version="2.1.206") == old
    assert not old.exists()
    assert current.exists()
