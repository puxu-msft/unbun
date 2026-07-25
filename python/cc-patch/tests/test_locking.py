import json
from pathlib import Path

import pytest

from cc_patch.locking import DirectoryLock, inspect_lock, cleanup_lock
from cc_patch.store import StoreError, parse_manifest


REPO_ROOT = Path(__file__).resolve().parents[3]
STORE_EXPECTED = json.loads(
    (REPO_ROOT / "contract/vectors/store-v1/fixtures/store-expected.json").read_text(encoding="utf-8")
)


def test_atomic_mkdir_lock_writes_valid_owner_and_blocks_contention(tmp_path):
    lock_path = tmp_path / "write.lock"
    first = DirectoryLock(lock_path, implementation="python", command="patch")
    owner = first.acquire()

    assert lock_path.is_dir()
    assert parse_manifest((lock_path / "owner.json").read_bytes(), kind="lock-owner") == owner
    with pytest.raises(StoreError) as raised:
        DirectoryLock(lock_path, implementation="other", command="snapshot").acquire()
    assert (raised.value.code, raised.value.exit_code) == (
        STORE_EXPECTED["lock_contention"]["code"],
        STORE_EXPECTED["lock_contention"]["exit"],
    )

    first.release()
    assert not lock_path.exists()


def test_release_requires_matching_owner_token(tmp_path):
    lock_path = tmp_path / "write.lock"
    lock = DirectoryLock(lock_path, implementation="python", command="patch")
    lock.acquire()
    owner_path = lock_path / "owner.json"
    owner = json.loads(owner_path.read_text(encoding="utf-8"))
    owner["token"] = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    owner_path.write_text(json.dumps(owner), encoding="utf-8")

    with pytest.raises(StoreError) as raised:
        lock.release()
    assert raised.value.code == "lock_owner_mismatch"
    assert lock_path.exists()


def test_unknown_owner_is_still_locked_and_never_auto_removed(tmp_path):
    lock_path = tmp_path / "write.lock"
    lock_path.mkdir()

    diagnosis = inspect_lock(lock_path)

    assert diagnosis.locked is True
    assert diagnosis.owner is None
    assert diagnosis.owner_known is False
    assert diagnosis.message == "lock exists but owner unknown"
    assert diagnosis.locked is STORE_EXPECTED["stale_lock_unknown_owner"]["locked"]
    assert lock_path.exists()
    with pytest.raises(StoreError) as raised:
        cleanup_lock(lock_path, force=False)
    assert raised.value.code == "target_locked"
    assert STORE_EXPECTED["stale_lock_unknown_owner"]["requires_explicit_force"] is True
    assert lock_path.exists()


def test_stale_cleanup_requires_force_and_removes_only_known_layout(tmp_path):
    lock_path = tmp_path / "write.lock"
    lock = DirectoryLock(lock_path, implementation="python", command="patch")
    lock.acquire()

    with pytest.raises(StoreError):
        cleanup_lock(lock_path, force=False)
    cleanup_lock(lock_path, force=True)
    assert not lock_path.exists()


def test_force_cleanup_refuses_recursive_deletion_of_unknown_content(tmp_path):
    lock_path = tmp_path / "write.lock"
    lock_path.mkdir()
    (lock_path / "unexpected").write_text("do not delete", encoding="utf-8")

    with pytest.raises(StoreError) as raised:
        cleanup_lock(lock_path, force=True)
    assert raised.value.code == "lock_cleanup_unsafe"
    assert (lock_path / "unexpected").read_text(encoding="utf-8") == "do not delete"


def test_owner_pid_liveness_is_diagnostic_only(tmp_path, monkeypatch):
    lock_path = tmp_path / "write.lock"
    lock = DirectoryLock(lock_path, implementation="python", command="patch")
    owner = lock.acquire()
    monkeypatch.setattr("cc_patch.locking._pid_exists", lambda pid: False)

    diagnosis = inspect_lock(lock_path)

    assert diagnosis.owner == owner
    assert diagnosis.pid_exists is False
    assert diagnosis.locked is True
    assert lock_path.exists()
