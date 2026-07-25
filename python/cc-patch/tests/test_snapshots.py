import json
from pathlib import Path

import pytest

from cc_patch import atomicio, orchestrate, snapshots
from cc_patch.features import REGISTRY
from cc_patch.store import ContentInspection, StoreError, StoreV1


@pytest.fixture
def binary(tmp_path, make_bundle):
    path = tmp_path / "versions" / "claude"
    path.parent.mkdir()
    path.write_bytes(bytes(make_bundle()))
    path.chmod(0o755)
    return path


@pytest.fixture
def store(tmp_path, monkeypatch):
    root = tmp_path / "store"
    monkeypatch.setenv("UNBUN_CC_STORE", str(root))
    return StoreV1(
        root,
        inspect_content=lambda data: ContentInspection(
            snapshots.extract_version(data),
            {slug: feature.detect(data).state for slug, feature in REGISTRY.items()},
        ),
    )


def test_save_publishes_cross_implementation_manifest_while_holding_target_lock(
    monkeypatch, binary, store
):
    lock_checks = []
    real_publish = store.publish_snapshot

    def checked_publish(*args, **kwargs):
        identity = store.identity_for(binary)
        lock_checks.append(
            (store.target_dir(identity.path_key) / "write.lock" / "owner.json").is_file()
        )
        return real_publish(*args, **kwargs)

    monkeypatch.setattr(store, "publish_snapshot", checked_publish)

    manifest_path = snapshots.save(binary, "before-test", store=store)

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    identity = store.identity_for(binary)
    assert lock_checks == [True]
    assert manifest["schema"] == "unbun.cc.snapshot"
    assert manifest["path_key"] == identity.path_key
    assert manifest["embedded_version"] == "2.1.175"
    assert manifest["slug"] == "before-test"
    assert manifest["observed_states"] == {
        slug: feature.detect(binary.read_bytes()).state
        for slug, feature in REGISTRY.items()
    }
    assert store.read_snapshot(identity.path_key, "2.1.175", "before-test").data == binary.read_bytes()


def test_force_atomically_repoints_manifest_and_list_reads_only_active_slots(
    binary, store
):
    first = binary.read_bytes()
    snapshots.save(binary, "same", store=store)
    second = first.replace(b"agentTool=", b"otherTool=")
    binary.write_bytes(second)

    with pytest.raises(StoreError) as caught:
        snapshots.save(binary, "same", store=store)
    assert caught.value.code == "snapshot_exists"

    snapshots.save(binary, "same", force=True, store=store)

    infos = snapshots.list_for_binary(binary, current_version="2.1.175", store=store)
    assert [(info.slug, info.version, info.invalid) for info in infos] == [
        ("same", "2.1.175", False)
    ]
    identity = store.identity_for(binary)
    assert store.read_snapshot(identity.path_key, "2.1.175", "same").data == second


def test_list_marks_invalid_manifest_with_its_slot_version(binary, store):
    manifest_path = snapshots.save(binary, "invalid", store=store)
    manifest_path.write_text("{invalid-json}\n", encoding="utf-8")

    infos = snapshots.list_for_binary(binary, current_version="2.1.175", store=store)

    assert [(info.slug, info.version, info.is_stale, info.invalid) for info in infos] == [
        ("invalid", "2.1.175", False, True)
    ]


def test_remove_holds_lock_and_removes_only_active_manifest(monkeypatch, binary, store):
    manifest_path = snapshots.save(binary, "gone", store=store)
    identity = store.identity_for(binary)
    blob_path = store.read_snapshot(identity.path_key, "2.1.175", "gone").blob_path
    lock_checks = []
    real_unlink = Path.unlink

    def checked_unlink(path, *args, **kwargs):
        if path == manifest_path:
            lock_checks.append(
                (store.target_dir(identity.path_key) / "write.lock" / "owner.json").is_file()
            )
        return real_unlink(path, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", checked_unlink)

    removed = snapshots.remove(binary, "gone", store=store)

    assert removed == manifest_path
    assert lock_checks == [True]
    assert not manifest_path.exists()
    assert blob_path.exists()


def test_restore_uses_target_lock_and_shared_transaction(monkeypatch, binary, store):
    clean = binary.read_bytes()
    patched = bytearray(clean)
    REGISTRY["agent-model"].apply(patched)
    snapshots.save_data(binary, bytes(patched), "2.1.175", "patched", store=store)
    monkeypatch.setattr(orchestrate, "STORE", store)
    lock_checks = []
    real_replace = atomicio._replace_atomic_temp

    def checked_replace(target, temp):
        identity = store.identity_for(binary)
        lock_checks.append(
            (store.target_dir(identity.path_key) / "write.lock" / "owner.json").is_file()
        )
        real_replace(target, temp)

    monkeypatch.setattr(atomicio, "_replace_atomic_temp", checked_replace)

    outcome = orchestrate.restore_snapshot(binary, "patched")

    assert binary.read_bytes() == bytes(patched)
    assert lock_checks == [True]
    assert outcome.applied == ["agent-model"]


def test_restore_cross_version_requires_confirmation_before_temp_write(
    monkeypatch, binary, store
):
    clean = binary.read_bytes()
    old = clean.replace(b'VERSION:"2.1.175"', b'VERSION:"2.1.174"')
    snapshots.save_data(binary, old, "2.1.174", "old", store=store)
    monkeypatch.setattr(orchestrate, "STORE", store)
    temps = []
    monkeypatch.setattr(
        atomicio,
        "_prepare_atomic_temp",
        lambda *_args: temps.append(True),
    )

    with pytest.raises(orchestrate.CrossVersionSnapshotWarning):
        orchestrate.restore_snapshot(binary, "old")

    assert temps == []
    assert binary.read_bytes() == clean