import json
import os
import socket
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from cc_patch.store import StoreError, parse_manifest


@dataclass(frozen=True)
class LockDiagnosis:
    locked: bool
    owner: dict | None
    owner_known: bool
    pid_exists: bool | None
    message: str


def _utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _pid_exists(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


class DirectoryLock:
    def __init__(self, path: Path, *, implementation: str, command: str):
        self.path = Path(path)
        self.implementation = implementation
        self.command = command
        self.token: str | None = None

    def acquire(self) -> dict:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        try:
            self.path.mkdir()
        except FileExistsError as error:
            raise StoreError("target_locked", 1, f"target lock exists: {self.path}") from error
        token = str(uuid.uuid4())
        owner = {
            "schema": "unbun.cc.lock-owner",
            "schema_version": 1,
            "token": token,
            "implementation": self.implementation,
            "pid": os.getpid(),
            "hostname": socket.gethostname(),
            "started_at": _utc_now(),
            "command": self.command,
        }
        parse_manifest(json.dumps(owner).encode(), kind="lock-owner")
        try:
            with (self.path / "owner.json").open("x", encoding="utf-8") as stream:
                json.dump(owner, stream, sort_keys=True)
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
        except Exception:
            (self.path / "owner.json").unlink(missing_ok=True)
            self.path.rmdir()
            raise
        self.token = token
        return owner

    def release(self) -> None:
        if self.token is None:
            raise StoreError("lock_owner_mismatch", 2, "lock was not acquired by this object")
        try:
            owner = parse_manifest((self.path / "owner.json").read_bytes(), kind="lock-owner")
        except (OSError, StoreError) as error:
            raise StoreError("lock_owner_mismatch", 2, "lock owner cannot be verified") from error
        if owner["token"] != self.token:
            raise StoreError("lock_owner_mismatch", 2, "lock owner token changed")
        entries = set(self.path.iterdir())
        owner_path = self.path / "owner.json"
        if entries != {owner_path}:
            raise StoreError("lock_cleanup_unsafe", 2, "lock contains unknown entries")
        owner_path.unlink()
        self.path.rmdir()
        self.token = None

    def __enter__(self) -> "DirectoryLock":
        self.acquire()
        return self

    def __exit__(self, exc_type, exc_value, traceback) -> None:
        self.release()


def inspect_lock(path: Path) -> LockDiagnosis:
    lock_path = Path(path)
    if not lock_path.is_dir():
        return LockDiagnosis(False, None, False, None, "unlocked")
    owner_path = lock_path / "owner.json"
    try:
        owner = parse_manifest(owner_path.read_bytes(), kind="lock-owner")
    except (OSError, StoreError):
        return LockDiagnosis(True, None, False, None, "lock exists but owner unknown")
    alive = _pid_exists(owner["pid"])
    return LockDiagnosis(True, owner, True, alive, "lock owner process exists" if alive else "lock owner process not found")


def cleanup_lock(path: Path, *, force: bool) -> None:
    lock_path = Path(path)
    if not lock_path.exists():
        return
    if not force:
        raise StoreError("target_locked", 1, f"explicit force is required to clean lock: {lock_path}")
    if not lock_path.is_dir():
        raise StoreError("lock_cleanup_unsafe", 2, "lock path is not a directory")
    entries = set(lock_path.iterdir())
    owner_path = lock_path / "owner.json"
    if entries not in (set(), {owner_path}):
        raise StoreError("lock_cleanup_unsafe", 2, "lock contains unknown entries")
    if owner_path in entries:
        owner_path.unlink()
    lock_path.rmdir()