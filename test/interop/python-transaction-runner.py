#!/usr/bin/env python3

from __future__ import annotations

import hashlib
import json
import sys
import time
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPOSITORY_ROOT / "python" / "cc-patch" / "src"))

from cc_patch import atomicio, orchestrate, snapshots  # noqa: E402
from cc_patch.features import REGISTRY, resolve_closure  # noqa: E402
from cc_patch.locking import DirectoryLock, cleanup_lock  # noqa: E402
from cc_patch.probe import extract_version  # noqa: E402
from cc_patch.store import StoreError, StoreV1, resolve_store_root  # noqa: E402


def read_request() -> dict:
    request = json.load(sys.stdin)
    if not isinstance(request, dict):
        raise TypeError("request must be a JSON object")
    if Path(request["store"]) != resolve_store_root():
        raise TypeError("request store must equal UNBUN_CC_STORE")
    return request


def states(data: bytes) -> dict[str, str]:
    return {slug: feature.detect(data).state for slug, feature in REGISTRY.items()}


def store_tree(store: Path) -> list[dict]:
    root = store / "v1"
    if not root.exists():
        return []
    entries = []
    for candidate in sorted(path for path in root.rglob("*") if path.is_file()):
        data = candidate.read_bytes()
        entries.append(
            {
                "path": candidate.relative_to(root).as_posix(),
                "sha256": hashlib.sha256(data).hexdigest(),
                "size": len(data),
            }
        )
    return entries


def execute(request: dict) -> dict:
    binary = Path(request["binary"])
    action = request["action"]
    store = StoreV1(resolve_store_root())
    identity = store.identity_for(binary)
    target_directory = store.target_dir(identity.path_key)
    result = None
    if action == "write-features":
        result = orchestrate.write_features(
            binary,
            resolve_closure(request["features"]),
            log=lambda *_args, **_kwargs: None,
        )
    elif action == "snapshot-save":
        result = orchestrate.save_named_snapshot(
            binary,
            request["snapshot"],
            force=request.get("force", False),
        )
    elif action == "snapshot-list":
        current_version = extract_version(binary.read_bytes())
        result = {
            "snapshots": [
                {"slug": info.slug, "version": info.version, "invalid": info.invalid}
                for info in snapshots.list_for_binary(
                    binary,
                    current_version=current_version,
                    store=store,
                )
            ]
        }
    elif action == "snapshot-restore":
        result = orchestrate.restore_snapshot(
            binary,
            request["snapshot"],
            snapshot_version=request.get("version"),
            confirmed=request.get("force", False),
        )
    elif action == "snapshot-rm":
        result = snapshots.remove(
            binary,
            request["snapshot"],
            version=request.get("version"),
            store=store,
        )
    elif action == "lock-hold":
        lock = DirectoryLock(
            target_directory / "write.lock",
            implementation="python",
            command="interop lock hold",
        )
        lock.acquire()
        try:
            release = Path(request["release"])
            while not release.exists():
                time.sleep(0.01)
        finally:
            lock.release()
        result = {"released": True}
    elif action == "lock-cleanup":
        cleanup_lock(
            target_directory / "write.lock",
            force=request.get("force", False),
        )
        result = {"removed": True}
    elif action != "inspect-store":
        raise TypeError(f"unknown action: {action}")

    data = binary.read_bytes()
    payload = {
        "ok": True,
        "action": action,
        "implementation": "python",
        "states": states(data),
        "binarySha256": hashlib.sha256(data).hexdigest(),
        "storeTree": store_tree(Path(request["store"])),
    }
    if hasattr(result, "applied"):
        payload["applied"] = result.applied
        payload["edits"] = result.edits
    if isinstance(result, dict) and "snapshots" in result:
        payload["snapshots"] = result["snapshots"]
    return payload


def main() -> int:
    try:
        request = read_request()
        print(json.dumps(execute(request), sort_keys=True, separators=(",", ":")))
        return 0
    except Exception as error:
        if isinstance(error, atomicio.SnapshotExists):
            code, exit_code = "snapshot_exists", 1
        else:
            code = getattr(error, "code", "runner_error")
            exit_code = getattr(error, "exit_code", 2)
        print(
            json.dumps(
                {
                    "ok": False,
                    "action": request.get("action") if "request" in locals() else None,
                    "implementation": "python",
                    "code": code,
                    "exit": exit_code,
                    "message": str(error),
                },
                sort_keys=True,
                separators=(",", ":"),
            )
        )
        return exit_code


if __name__ == "__main__":
    raise SystemExit(main())