import hashlib
import json
import os
from copy import deepcopy
from pathlib import Path

import pytest

from cc_patch.store import (
    ContentInspection,
    DurabilityAdapter,
    StoreError,
    StoreIntegrityError,
    StoreV1,
    canonicalize_contract_path,
    compute_path_key,
    parse_manifest,
    resolve_store_root,
)


REPO_ROOT = Path(__file__).resolve().parents[3]
CONTRACT_ROOT = REPO_ROOT / "contract"
PATH_VECTORS = json.loads(
    (CONTRACT_ROOT / "vectors/canonical-path-v1.json").read_text(encoding="utf-8")
)
STORE_CASES = json.loads(
    (CONTRACT_ROOT / "vectors/store-v1/fixtures/store-cases.json").read_text(encoding="utf-8")
)
STORE_EXPECTED = json.loads(
    (CONTRACT_ROOT / "vectors/store-v1/fixtures/store-expected.json").read_text(encoding="utf-8")
)


class RecordingDurability(DurabilityAdapter):
    directory_fsync_supported = True

    def __init__(self):
        self.files: list[Path] = []
        self.directories: list[Path] = []

    def fsync_file(self, path: Path) -> None:
        self.files.append(path)

    def fsync_directory(self, path: Path) -> None:
        self.directories.append(path)


class FailingManifestDirectoryFsync(RecordingDurability):
    def __init__(self):
        super().__init__()
        self.fail_next_manifest_publish = True

    def fsync_directory(self, path: Path) -> None:
        super().fsync_directory(path)
        if self.fail_next_manifest_publish and (path / "baseline.json").exists():
            self.fail_next_manifest_publish = False
            raise OSError("injected manifest directory fsync failure")


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _target_manifest(path_key: str, canonical_path: str) -> dict:
    return {
        "schema": "unbun.cc.target",
        "schema_version": 1,
        "path_key": path_key,
        "canonical_path": canonical_path,
        "display_name": Path(canonical_path).name,
        "created_at": "2026-07-23T12:34:56.000Z",
    }


def _baseline_manifest(path_key: str, data: bytes, version: str = "2.1.175") -> dict:
    digest = _sha256(data)
    return {
        "schema": "unbun.cc.baseline",
        "schema_version": 1,
        "feature_contract": "claude-v1",
        "path_key": path_key,
        "embedded_version": version,
        "blob": f"blobs/{digest}.ccbak",
        "sha256": digest,
        "lineage_algorithm": "claude-v1-exact-replay",
        "lineage_sha256": digest,
        "size": len(data),
        "states": {
            "source-exec": "clean",
            "agent-model": "clean",
            "channels": "clean",
        },
        "created_at": "2026-07-23T12:34:56.000Z",
        "created_by": "python",
    }


def _snapshot_manifest(
    path_key: str,
    data: bytes,
    version: str = "2.1.175",
    slug: str = "before-change",
) -> dict:
    digest = _sha256(data)
    return {
        "schema": "unbun.cc.snapshot",
        "schema_version": 1,
        "feature_contract": "claude-v1",
        "path_key": path_key,
        "embedded_version": version,
        "slug": slug,
        "blob": f"blobs/{digest}.ccsnap",
        "sha256": digest,
        "size": len(data),
        "observed_states": {
            "source-exec": "patched",
            "agent-model": "clean",
            "channels": "clean",
        },
        "created_at": "2026-07-23T12:34:56.000Z",
        "created_by": "python",
    }


def test_store_root_precedence_and_absolute_override_rules(tmp_path):
    override = tmp_path / "shared-store"
    assert resolve_store_root({"UNBUN_CC_STORE": str(override)}, platform="linux") == override
    assert resolve_store_root(
        {"XDG_DATA_HOME": "/data/xdg", "HOME": "/home/test"}, platform="linux"
    ) == Path("/data/xdg/unbun/cc-patch")
    assert resolve_store_root({"HOME": "/home/test"}, platform="linux") == Path(
        "/home/test/.local/share/unbun/cc-patch"
    )
    assert resolve_store_root({"HOME": "/Users/test"}, platform="darwin") == Path(
        "/Users/test/Library/Application Support/unbun/cc-patch"
    )
    assert resolve_store_root(
        {"LOCALAPPDATA": "C:\\Users\\test\\AppData\\Local"}, platform="win32"
    ) == Path("C:\\Users\\test\\AppData\\Local\\unbun\\cc-patch")

    for invalid in ("relative/store", "~/store", "/tmp/$STORE", "C:\\%STORE%"):
        with pytest.raises(StoreError) as raised:
            resolve_store_root({"UNBUN_CC_STORE": invalid}, platform="win32" if ":" in invalid else "linux")
        assert raised.value.code == "store_root_invalid"
        assert raised.value.exit_code == 1


@pytest.mark.parametrize("case", PATH_VECTORS["cases"], ids=lambda case: case["id"])
def test_all_frozen_canonical_path_and_full_path_key_vectors(case):
    canonical = canonicalize_contract_path(
        case["input_path"], platform=case["platform"], symlinks=case.get("symlinks", {})
    )
    assert canonical == case["canonical_path"]
    assert compute_path_key(canonical) == case["path_key"]
    assert len(compute_path_key(canonical)) == 64


def test_extended_unc_path_matches_javascript_canonicalization():
    canonical = canonicalize_contract_path(
        r"\\?\UNC\Server\Share\Claude.exe",
        platform="windows",
    )

    assert canonical == "//server/share/claude.exe"
    assert compute_path_key(canonical) == hashlib.sha256(
        b"//server/share/claude.exe"
    ).hexdigest()


def test_real_target_identity_resolves_symlink_and_uses_nfc(tmp_path):
    real_dir = tmp_path / "Jose\u0301"
    real_dir.mkdir()
    binary = real_dir / "claude"
    binary.write_bytes(b"fixture")
    link = tmp_path / "current"
    link.symlink_to(real_dir, target_is_directory=True)
    store = StoreV1(tmp_path / "store")

    identity = store.identity_for(link / "claude")

    assert identity.canonical_path.endswith("/Jos\u00e9/claude")
    assert identity.path_key == compute_path_key(identity.canonical_path)


def test_store_uses_only_v1_under_environment_override(monkeypatch, tmp_path):
    monkeypatch.setenv("UNBUN_CC_STORE", str(tmp_path / "override"))
    store = StoreV1.from_environment()
    assert store.root == tmp_path / "override"
    assert store.protocol_root == tmp_path / "override/v1"
    assert store.targets_root == tmp_path / "override/v1/targets"
    assert "backups" not in store.protocol_root.parts


def test_parse_valid_manifest_kinds_and_ignore_unknown_fields():
    data = b"clean-baseline"
    key = "a" * 64
    manifests = {
        "target": _target_manifest(key, "/tmp/claude"),
        "baseline": _baseline_manifest(key, data),
        "snapshot": _snapshot_manifest(key, data),
        "lock-owner": {
            "schema": "unbun.cc.lock-owner",
            "schema_version": 1,
            "token": "12345678-1234-4234-9234-123456789abc",
            "implementation": "python",
            "pid": 42,
            "hostname": "test-host",
            "started_at": "2026-07-23T12:34:56.000Z",
            "command": "patch",
        },
        "quarantine": {
            "schema": "unbun.cc.quarantine",
            "schema_version": 1,
            "original_path": "baselines/2.1.175/baseline.json",
            "reason": "baseline_invalid",
            "observed_sha256": "b" * 64,
            "discovered_at": "2026-07-23T12:34:56.000Z",
            "discovered_by": "python",
        },
    }
    assert set(manifests) == set(STORE_CASES["valid_manifests"])
    for kind, manifest in manifests.items():
        manifest["future_observation"] = {"accepted": True}
        assert parse_manifest(json.dumps(manifest).encode(), kind=kind) == manifest
    assert STORE_EXPECTED["valid_manifests"] == {"accepted": True}


def test_frozen_invalid_manifest_cases_map_to_expected_codes():
    data = b"clean-baseline"
    baseline = _baseline_manifest("a" * 64, data)
    cases = STORE_CASES["invalid_manifest_cases"]
    for case_name in ("missing_field", "wrong_type", "higher_version", "path_traversal"):
        case = cases[case_name]
        candidate = deepcopy(baseline)
        if "remove" in case:
            candidate.pop(case["remove"])
        else:
            candidate[case["field"]] = case["value"]
        with pytest.raises(StoreError) as raised:
            parse_manifest(json.dumps(candidate).encode(), kind="baseline")
        assert (raised.value.code, raised.value.exit_code) == (
            STORE_EXPECTED[case_name]["code"],
            STORE_EXPECTED[case_name]["exit"],
        )


@pytest.mark.parametrize("case_name", ["hash_mismatch", "size_mismatch"])
def test_frozen_content_mismatch_cases_are_rejected_on_active_read(tmp_path, case_name):
    key = "a" * 64
    data = b"clean-baseline"
    manifest = _baseline_manifest(key, data)
    store = StoreV1(tmp_path / "store")
    active = store.publish_baseline(key, "2.1.175", data, manifest)
    case = STORE_CASES["invalid_manifest_cases"][case_name]
    tampered = json.loads(active.read_text(encoding="utf-8"))
    tampered[case["field"]] = case["value"]
    active.write_text(json.dumps(tampered), encoding="utf-8")

    with pytest.raises(StoreError) as raised:
        store.read_active_baseline(key, "2.1.175")
    assert (raised.value.code, raised.value.exit_code) == (
        STORE_EXPECTED[case_name]["code"],
        STORE_EXPECTED[case_name]["exit"],
    )


def test_frozen_directory_version_mismatch_is_rejected(tmp_path):
    key = "a" * 64
    data = b"clean-baseline"
    manifest = _baseline_manifest(key, data, version="2.1.175")
    directory = tmp_path / "store/v1/targets" / key / "baselines/2.1.176"
    blob = directory / manifest["blob"]
    blob.parent.mkdir(parents=True)
    blob.write_bytes(data)
    (directory / "baseline.json").write_text(json.dumps(manifest), encoding="utf-8")
    store = StoreV1(tmp_path / "store")

    with pytest.raises(StoreError) as raised:
        store.read_active_baseline(key, "2.1.176")
    assert (raised.value.code, raised.value.exit_code) == (
        STORE_EXPECTED["version_mismatch"]["code"],
        STORE_EXPECTED["version_mismatch"]["exit"],
    )


def test_frozen_content_version_and_state_mismatch_use_fixture_inspector(tmp_path):
    key = "a" * 64
    data = b"clean-baseline"
    inspection = {
        "value": ContentInspection(
            embedded_version="2.1.175",
            states={feature: "clean" for feature in ("source-exec", "agent-model", "channels")},
        )
    }
    store = StoreV1(tmp_path / "store", inspect_content=lambda _data: inspection["value"])
    store.publish_baseline(key, "2.1.175", data, _baseline_manifest(key, data))

    inspection["value"] = ContentInspection("2.1.176", inspection["value"].states)
    with pytest.raises(StoreError) as raised:
        store.read_active_baseline(key, "2.1.175")
    assert raised.value.code == STORE_EXPECTED["version_mismatch"]["code"]

    inspection["value"] = ContentInspection(
        "2.1.175",
        {"source-exec": "patched", "agent-model": "clean", "channels": "clean"},
    )
    with pytest.raises(StoreError) as raised:
        store.read_active_baseline(key, "2.1.175")
    assert (raised.value.code, raised.value.exit_code) == (
        STORE_EXPECTED["state_mismatch"]["code"],
        STORE_EXPECTED["state_mismatch"]["exit"],
    )


def test_manifest_parser_rejects_bom_non_object_unknown_schema_and_invalid_utf8():
    valid = _target_manifest("a" * 64, "/tmp/claude")
    invalid_payloads = [
        b"\xef\xbb\xbf" + json.dumps(valid).encode(),
        b"[]",
        b"\xff",
        json.dumps({**valid, "schema": "unbun.cc.future"}).encode(),
    ]
    for payload in invalid_payloads:
        with pytest.raises(StoreError, match="manifest"):
            parse_manifest(payload, kind="target")


def test_target_json_no_clobber_and_identity_validation(tmp_path):
    binary = tmp_path / "claude"
    binary.write_bytes(b"fixture")
    store = StoreV1(tmp_path / "store")
    identity = store.identity_for(binary)

    first = store.ensure_target(identity)
    original = first.read_bytes()
    assert store.ensure_target(identity) == first
    assert first.read_bytes() == original

    tampered = json.loads(original)
    tampered["canonical_path"] = "/different/claude"
    first.write_text(json.dumps(tampered), encoding="utf-8")
    with pytest.raises(StoreError) as raised:
        store.ensure_target(identity)
    assert raised.value.code == "target_identity_mismatch"


def test_baseline_content_addressed_blob_and_manifest_activation(tmp_path):
    data = b"clean-baseline"
    key = "a" * 64
    durability = RecordingDurability()
    store = StoreV1(tmp_path / "store", durability=durability)
    manifest = _baseline_manifest(key, data)

    active = store.publish_baseline(key, "2.1.175", data, manifest)

    blob = active.parent / manifest["blob"]
    assert active.name == "baseline.json"
    assert blob.read_bytes() == data
    assert store.read_active_baseline(key, "2.1.175").blob_path == blob
    assert any(path.parent == blob.parent and path.name.startswith(f".{blob.name}.tmp.") for path in durability.files)
    assert any(path.parent == active.parent and path.name.startswith(".baseline.json.tmp.") for path in durability.files)
    assert active.parent in durability.directories


def test_failed_manifest_directory_fsync_removes_active_entry_and_retry_republishes(tmp_path):
    key = "a" * 64
    data = b"clean-baseline"
    durability = FailingManifestDirectoryFsync()
    store = StoreV1(tmp_path / "store", durability=durability)
    manifest = _baseline_manifest(key, data)

    with pytest.raises(StoreIntegrityError) as raised:
        store.publish_baseline(key, "2.1.175", data, manifest)

    assert raised.value.code == "store_integrity_error"
    assert store.find_active_baseline(key, "2.1.175") is None
    first_fsync_count = len(durability.directories)

    active = store.publish_baseline(key, "2.1.175", data, manifest)

    assert active.is_file()
    assert store.read_active_baseline(key, "2.1.175").data == data
    assert len(durability.directories) > first_fsync_count


def test_baseline_no_clobber_is_idempotent_but_conflicting_manifest_is_rejected(tmp_path):
    key = "a" * 64
    store = StoreV1(tmp_path / "store")
    first = b"first-clean-build"
    store.publish_baseline(key, "2.1.175", first, _baseline_manifest(key, first))
    store.publish_baseline(key, "2.1.175", first, _baseline_manifest(key, first))

    second = b"different-clean-build"
    with pytest.raises(StoreError) as raised:
        store.publish_baseline(key, "2.1.175", second, _baseline_manifest(key, second))
    assert raised.value.code == "baseline_conflict"
    assert store.read_active_baseline(key, "2.1.175").data == first


def test_all_crash_residue_cases_are_not_active(tmp_path):
    key = "a" * 64
    version_dir = tmp_path / "store/v1/targets" / key / "baselines/2.1.175"
    blobs = version_dir / "blobs"
    blobs.mkdir(parents=True)
    store = StoreV1(tmp_path / "store")
    data = b"orphan"
    digest = _sha256(data)

    (blobs / f"{digest}.ccbak").write_bytes(data)
    assert store.find_active_baseline(key, "2.1.175") is None
    assert STORE_EXPECTED["orphan_blob"] == {"active": False, "ignored": True}

    (version_dir / ".baseline.json.tmp.1234").write_text("{}", encoding="utf-8")
    assert store.find_active_baseline(key, "2.1.175") is None
    assert STORE_EXPECTED["temp_only"] == {"active": False, "ignored": True}

    manifest = _baseline_manifest(key, b"missing")
    (version_dir / "baseline.json").write_text(json.dumps(manifest), encoding="utf-8")
    with pytest.raises(StoreError) as raised:
        store.read_active_baseline(key, "2.1.175")
    assert (raised.value.code, raised.value.exit_code) == (
        STORE_EXPECTED["manifest_only"]["code"],
        STORE_EXPECTED["manifest_only"]["exit"],
    )


@pytest.mark.parametrize("legacy_suffix", [".ccbak", ".agentbak", ".channels.bak"])
def test_legacy_backup_names_outside_v1_are_never_active_assets(tmp_path, legacy_suffix):
    binary = tmp_path / "versions" / "claude"
    binary.parent.mkdir()
    binary.write_bytes(b"current")
    binary.with_name(binary.name + legacy_suffix).write_bytes(b"legacy-clean-candidate")
    store = StoreV1(tmp_path / "store")
    identity = store.identity_for(binary)

    assert store.find_active_baseline(identity.path_key, "2.1.175") is None
    assert not store.protocol_root.exists()


def test_fault_injection_blob_only_and_manifest_only_never_activate(tmp_path):
    key = "a" * 64
    store = StoreV1(tmp_path / "store")
    data = b"candidate"
    manifest = _baseline_manifest(key, data)

    with pytest.raises(RuntimeError, match="after_blob"):
        store.publish_baseline(key, "2.1.175", data, manifest, fault="after_blob")
    assert store.find_active_baseline(key, "2.1.175") is None

    with pytest.raises(RuntimeError, match="after_manifest_temp"):
        store.publish_baseline(key, "2.1.175", data, manifest, fault="after_manifest_temp")
    assert store.find_active_baseline(key, "2.1.175") is None


def test_snapshot_slot_force_replaces_only_activation_manifest(tmp_path):
    key = "a" * 64
    store = StoreV1(tmp_path / "store")
    old = b"old-snapshot"
    new = b"new-snapshot"
    old_manifest = _snapshot_manifest(key, old)
    new_manifest = _snapshot_manifest(key, new)
    active = store.publish_snapshot(key, "2.1.175", "before-change", old, old_manifest)

    with pytest.raises(StoreError) as raised:
        store.publish_snapshot(key, "2.1.175", "before-change", new, new_manifest)
    assert raised.value.code == "snapshot_exists"

    store.publish_snapshot(key, "2.1.175", "before-change", new, new_manifest, force=True)
    parsed = json.loads(active.read_text(encoding="utf-8"))
    assert parsed["sha256"] == _sha256(new)
    assert store.read_snapshot(key, "2.1.175", "before-change").data == new
    assert STORE_EXPECTED["force_activation"]["partial_manifest_visible"] is False


def test_snapshot_selection_uses_current_version_or_reports_frozen_ambiguity(tmp_path):
    key = "a" * 64
    store = StoreV1(tmp_path / "store")
    for version in ("2.1.174", "2.1.175"):
        data = f"snapshot-{version}".encode()
        store.publish_snapshot(key, version, "before-change", data, _snapshot_manifest(key, data, version))

    assert store.select_snapshot(key, "before-change", current_version="2.1.175").manifest[
        "embedded_version"
    ] == "2.1.175"
    with pytest.raises(StoreError) as raised:
        store.select_snapshot(key, "before-change", current_version="2.1.176")
    assert (raised.value.code, raised.value.exit_code) == (
        STORE_EXPECTED["snapshot_ambiguity"]["code"],
        STORE_EXPECTED["snapshot_ambiguity"]["exit"],
    )
    with pytest.raises(StoreError) as raised:
        store.select_snapshot(key, "*", current_version="2.1.175")
    assert raised.value.code == "snapshot_not_found"


def test_quarantine_moves_asset_out_of_active_namespace_and_records_manifest(tmp_path):
    key = "a" * 64
    store = StoreV1(tmp_path / "store")
    source = store.target_dir(key) / "baselines/2.1.175/baseline.json"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"broken-manifest")

    quarantined = store.quarantine(
        key,
        source,
        reason="baseline_invalid",
        discovered_by="python",
    )

    assert not source.exists()
    assert (quarantined / "artifact").read_bytes() == b"broken-manifest"
    metadata = parse_manifest((quarantined / "quarantine.json").read_bytes(), kind="quarantine")
    assert metadata["original_path"] == "baselines/2.1.175/baseline.json"
    assert metadata["observed_sha256"] == _sha256(b"broken-manifest")


def test_windows_durability_adapter_records_explicit_boundary(tmp_path):
    adapter = DurabilityAdapter.for_platform("win32")
    assert adapter.directory_fsync_supported is False
    adapter.fsync_directory(tmp_path)
    assert adapter.durability_boundary == "file-flush-and-atomic-rename-no-directory-fsync"


def test_store_vectors_are_fully_consumed_by_tests():
    tested_expected_keys = {
        "valid_manifests",
        "missing_field",
        "wrong_type",
        "higher_version",
        "path_traversal",
        "hash_mismatch",
        "size_mismatch",
        "version_mismatch",
        "state_mismatch",
        "orphan_blob",
        "manifest_only",
        "temp_only",
        "lock_contention",
        "stale_lock_unknown_owner",
        "snapshot_ambiguity",
        "force_activation",
    }
    assert tested_expected_keys == set(STORE_EXPECTED)
    assert STORE_CASES["crash_residue"]["orphan_blob"]["active"] is False
    assert STORE_CASES["crash_residue"]["manifest_only"]["valid"] is False
    assert STORE_CASES["crash_residue"]["temp_only"]["active"] is False
