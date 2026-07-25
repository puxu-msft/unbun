from __future__ import annotations

import hashlib
from datetime import UTC, datetime
from pathlib import Path

from cc_patch.features import REGISTRY
from cc_patch.locking import DirectoryLock
from cc_patch.models import SnapshotInfo
from cc_patch.probe import extract_version
from cc_patch.store import ContentInspection, StoreError, StoreV1, resolve_store_root


def _states(data: bytes) -> dict[str, str]:
    return {slug: feature.detect(data).state for slug, feature in REGISTRY.items()}


def _store() -> StoreV1:
    return StoreV1(
        resolve_store_root(),
        inspect_content=lambda data: ContentInspection(extract_version(data), _states(data)),
    )


def _manifest(path_key: str, data: bytes, version: str, slug: str) -> dict:
    digest = hashlib.sha256(data).hexdigest()
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
        "observed_states": _states(data),
        "created_at": StoreV1.utc_now(),
        "created_by": "python",
    }


def save(
    binary: Path,
    slug: str,
    *,
    force: bool = False,
    store: StoreV1 | None = None,
) -> Path:
    active_store = store or _store()
    identity = active_store.identity_for(binary)
    lock_path = active_store.target_dir(identity.path_key) / "write.lock"
    with DirectoryLock(lock_path, implementation="python", command="snapshot-save"):
        data = binary.read_bytes()
        version = extract_version(data)
        if version is None:
            raise StoreError("version_probe_failed", 1, "snapshot version probe failed")
        active_store.ensure_target(identity)
        return active_store.publish_snapshot(
            identity.path_key,
            version,
            slug,
            data,
            _manifest(identity.path_key, data, version, slug),
            force=force,
        )


def save_data(
    binary: Path,
    data: bytes,
    version: str,
    slug: str,
    *,
    force: bool = False,
    store: StoreV1 | None = None,
) -> Path:
    active_store = store or _store()
    identity = active_store.identity_for(binary)
    lock_path = active_store.target_dir(identity.path_key) / "write.lock"
    with DirectoryLock(lock_path, implementation="python", command="snapshot-save"):
        if extract_version(data) != version:
            raise StoreError(
                "snapshot_invalid",
                2,
                "snapshot content version differs from specified version",
            )
        active_store.ensure_target(identity)
        return active_store.publish_snapshot(
            identity.path_key,
            version,
            slug,
            data,
            _manifest(identity.path_key, data, version, slug),
            force=force,
        )


def select(
    binary: Path,
    slug: str,
    *,
    current_version: str,
    version: str | None = None,
    store: StoreV1 | None = None,
):
    active_store = store or _store()
    identity = active_store.identity_for(binary)
    if version is not None:
        return active_store.read_snapshot(identity.path_key, version, slug)
    return active_store.select_snapshot(
        identity.path_key,
        slug,
        current_version=current_version,
    )


def list_for_binary(
    binary: Path,
    *,
    current_version: str,
    store: StoreV1 | None = None,
) -> list[SnapshotInfo]:
    active_store = store or _store()
    identity = active_store.identity_for(binary)
    root = active_store.target_dir(identity.path_key) / "snapshots"
    infos: list[SnapshotInfo] = []
    for manifest_path in root.glob("*/*/snapshot.json"):
        version = manifest_path.parents[1].name
        slug = manifest_path.parent.name
        try:
            asset = active_store.read_snapshot(identity.path_key, version, slug)
            content_version = extract_version(asset.data)
            created_at = datetime.fromisoformat(
                asset.manifest["created_at"].removesuffix("Z") + "+00:00"
            )
            invalid = content_version != version
        except (OSError, StoreError, ValueError):
            content_version = None
            created_at = datetime.fromtimestamp(manifest_path.stat().st_mtime, tz=UTC)
            invalid = True
        listed_version = content_version if content_version is not None else version
        infos.append(
            SnapshotInfo(
                manifest_path,
                listed_version,
                slug,
                created_at,
                listed_version != current_version,
                invalid,
            )
        )
    return sorted(infos, key=lambda info: (info.version, info.slug, str(info.path)))


def remove(
    binary: Path,
    slug: str,
    *,
    version: str | None = None,
    store: StoreV1 | None = None,
) -> Path:
    active_store = store or _store()
    identity = active_store.identity_for(binary)
    lock_path = active_store.target_dir(identity.path_key) / "write.lock"
    with DirectoryLock(lock_path, implementation="python", command="snapshot-rm"):
        if version is None:
            root = active_store.target_dir(identity.path_key) / "snapshots"
            matches = list(root.glob(f"*/{slug}/snapshot.json"))
            if not matches:
                raise StoreError("snapshot_not_found", 1, f"snapshot not found: {slug}")
            if len(matches) > 1:
                versions = ", ".join(sorted(path.parents[1].name for path in matches))
                raise StoreError(
                    "snapshot_ambiguous",
                    1,
                    f"snapshot version is ambiguous: {slug} ({versions})",
                )
            asset = active_store.read_snapshot(
                identity.path_key,
                matches[0].parents[1].name,
                slug,
            )
        else:
            asset = active_store.read_snapshot(identity.path_key, version, slug)
        asset.manifest_path.unlink()
        active_store.durability.fsync_directory(asset.manifest_path.parent)
        return asset.manifest_path