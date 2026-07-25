from __future__ import annotations

import hashlib
import platform
import stat
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path

from cc_patch import atomicio, snapshots, transaction
from cc_patch.codesign import maybe_resign_macos
from cc_patch.features import REGISTRY, resolve_closure
from cc_patch.lineage import ExactReplayAdapter, PlatformGate, assert_platform_write_enabled, prove_exact_replay
from cc_patch.locking import DirectoryLock
from cc_patch.models import FeatureSubstate, WriteOutcome
from cc_patch.probe import extract_version
from cc_patch.store import ContentInspection, StoreError, StoreV1, resolve_store_root


STORE: StoreV1 | None = None
MACOS_NORMALIZE = lambda data: data
MACOS_EXECUTABLE_CHECK = lambda path: path.is_file() and bool(
    stat.S_IMODE(path.stat().st_mode) & (stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
)


def _contract_root() -> Path | None:
    candidate = Path(__file__).resolve().parents[4] / "contract"
    return candidate if (candidate / "vectors/platform-writes-v1.json").is_file() else None


def _current_platform_name() -> str:
    system_name = platform.system()
    return {"Linux": "linux", "Windows": "windows", "Darwin": "macos"}.get(
        system_name,
        system_name.lower(),
    )


def _resolve_write_gate() -> PlatformGate:
    return assert_platform_write_enabled(_contract_root(), _current_platform_name())


class NoBaselineReason(StrEnum):
    CHANNELS_PATCHED_NO_BASELINE = "channels_patched_no_baseline"
    VERSION_PROBE_FAILED = "version_probe_failed"
    REBUILD_ROUNDTRIP_FAILED = "rebuild_roundtrip_failed"
    UNSUPPORTED_OR_MIXED_NO_BASELINE = "unsupported_or_mixed_no_baseline"
    INVALID_BASELINE = "invalid_baseline"


class DependentFeatureStillEnabled(ValueError):
    def __init__(self, feature: str, dependants: list[str]):
        self.feature = feature
        self.dependants = dependants
        super().__init__(f"Cannot remove {feature}: still-enabled dependants are {', '.join(dependants)}")


class VersionDriftRejected(atomicio.VersionDrift):
    pass


class NoBaselineRejected(StoreError):
    def __init__(self, reason: NoBaselineReason):
        self.reason = reason
        code, exit_code = {
            NoBaselineReason.CHANNELS_PATCHED_NO_BASELINE: (
                "channels_patched_no_baseline",
                1,
            ),
            NoBaselineReason.VERSION_PROBE_FAILED: ("version_probe_failed", 1),
            NoBaselineReason.REBUILD_ROUNDTRIP_FAILED: (
                "unsupported_or_mixed_no_baseline",
                1,
            ),
            NoBaselineReason.UNSUPPORTED_OR_MIXED_NO_BASELINE: (
                "unsupported_or_mixed_no_baseline",
                1,
            ),
            NoBaselineReason.INVALID_BASELINE: ("baseline_invalid", 2),
        }[reason]
        super().__init__(code, exit_code, reason.value)


class ContentMismatch(RuntimeError):
    pass


class ConcurrentBinaryChange(StoreError):
    def __init__(self, message: str):
        super().__init__("concurrent_binary_change", 1, message)


@dataclass(frozen=True)
class SnapshotRestoreConfirmation:
    entry_sha256: str
    current_version: str
    snapshot_version: str
    snapshot_slug: str
    snapshot_sha256: str
    snapshot_manifest_path: str


class CrossVersionSnapshotWarning(RuntimeError):
    def __init__(self, confirmation: SnapshotRestoreConfirmation):
        self.confirmation = confirmation
        self.snapshot_version = confirmation.snapshot_version
        self.current_version = confirmation.current_version
        super().__init__(
            f"Snapshot version {self.snapshot_version} differs from current binary version {self.current_version}; confirmation required"
        )


def _states(data: bytes) -> dict[str, str]:
    return {slug: feature.detect(data).state for slug, feature in REGISTRY.items()}


def _lineage_normalize(data: bytes) -> bytes:
    return MACOS_NORMALIZE(data) if platform.system() == "Darwin" else data


def _inspect_content(data: bytes) -> ContentInspection:
    return ContentInspection(extract_version(data), _states(data))


def _get_store() -> StoreV1:
    global STORE
    if STORE is None:
        STORE = StoreV1(resolve_store_root(), inspect_content=_inspect_content)
    return STORE


class _FeatureReplayAdapter(ExactReplayAdapter):
    def observe_substates(self, current: bytes) -> dict[str, tuple[FeatureSubstate, ...]]:
        statuses = {slug: feature.detect(current) for slug, feature in REGISTRY.items()}
        if any(status.state == "unsupported" for status in statuses.values()):
            raise ValueError("unsupported feature state")
        return {slug: status.substates for slug, status in statuses.items()}

    def replay_substates(self, baseline: bytes, substates: object) -> bytes:
        if not isinstance(substates, dict) or set(substates) != set(REGISTRY):
            raise ValueError("incomplete feature substate vector")
        replayed = bytearray(baseline)
        for slug, feature in REGISTRY.items():
            feature.replay_substates(replayed, substates[slug])
        return bytes(replayed)


_FEATURE_REPLAY = _FeatureReplayAdapter()


def _patched_features(states: dict[str, str]) -> list[str]:
    return [slug for slug in REGISTRY if states[slug] == "patched"]


def _check_removed_dependencies(
    current_states: dict[str, str],
    requested_targets: list[str],
) -> None:
    requested = set(requested_targets)
    currently_enabled = {
        slug for slug, state in current_states.items() if state in {"patched", "mixed"}
    }
    for dependency in REGISTRY:
        if dependency not in currently_enabled or dependency in requested:
            continue
        dependants = [
            slug
            for slug in REGISTRY
            if slug in requested
            and slug in currently_enabled
            and dependency in REGISTRY[slug].requires
        ]
        if dependants:
            raise DependentFeatureStillEnabled(dependency, dependants)


def _rebuild_baseline_via_reverse(
    data: bytes,
    patched_features: list[str],
) -> bytes | None:
    if not patched_features or any(not REGISTRY[slug].reversible for slug in patched_features):
        return None
    observed = {
        slug: REGISTRY[slug].observe_substates(data)
        for slug in patched_features
    }
    rebuilt = bytearray(data)
    for slug in reversed(resolve_closure(patched_features)):
        if slug in patched_features:
            REGISTRY[slug].reverse(rebuilt)
    clean = bytes(rebuilt)
    replayed = bytearray(clean)
    try:
        for slug in resolve_closure(patched_features):
            if slug in patched_features:
                REGISTRY[slug].replay_substates(replayed, observed[slug])
    except ValueError:
        return None
    return clean if bytes(replayed) == data else None


def _validate_clean_baseline(data: bytes, version: str) -> None:
    if extract_version(data) != version or any(
        state != "clean" for state in _states(data).values()
    ):
        raise NoBaselineRejected(NoBaselineReason.INVALID_BASELINE)


def _baseline_manifest(
    path_key: str,
    baseline: bytes,
    version: str,
) -> dict:
    digest = hashlib.sha256(baseline).hexdigest()
    lineage_digest = hashlib.sha256(_lineage_normalize(baseline)).hexdigest()
    return {
        "schema": "unbun.cc.baseline",
        "schema_version": 1,
        "feature_contract": "claude-v1",
        "path_key": path_key,
        "embedded_version": version,
        "blob": f"blobs/{digest}.ccbak",
        "sha256": digest,
        "lineage_algorithm": "claude-v1-exact-replay",
        "lineage_sha256": lineage_digest,
        "size": len(baseline),
        "states": {slug: "clean" for slug in REGISTRY},
        "created_at": StoreV1.utc_now(),
        "created_by": "python",
    }


def _baseline_for_write(
    store: StoreV1,
    path_key: str,
    current_data: bytes,
    version: str,
    states: dict[str, str],
) -> tuple[bytes, bool]:
    if store.find_active_baseline(path_key, version) is not None:
        asset = store.read_active_baseline(path_key, version)
        _validate_clean_baseline(asset.data, version)
        prove_exact_replay(
            asset.data,
            current_data,
            adapter=_FEATURE_REPLAY,
            normalize=_lineage_normalize,
            baseline_lineage_sha256=asset.manifest["lineage_sha256"],
        )
        return asset.data, False

    if all(state == "clean" for state in states.values()):
        return current_data, True

    if states.get("channels") == "patched":
        raise NoBaselineRejected(NoBaselineReason.CHANNELS_PATCHED_NO_BASELINE)

    if any(state in {"mixed", "unsupported"} for state in states.values()):
        raise NoBaselineRejected(NoBaselineReason.UNSUPPORTED_OR_MIXED_NO_BASELINE)

    patched = _patched_features(states)
    rebuilt = _rebuild_baseline_via_reverse(current_data, patched)
    if rebuilt is None:
        raise NoBaselineRejected(NoBaselineReason.REBUILD_ROUNDTRIP_FAILED)
    return rebuilt, True


def _verify_target(data: bytes, effective_targets: list[str]) -> None:
    expected = set(effective_targets)
    actual_states = _states(data)
    mismatches = {
        slug: state
        for slug, state in actual_states.items()
        if (slug in expected and state != "patched")
        or (slug not in expected and state != "clean")
    }
    if mismatches:
        formatted = ", ".join(f"{slug}={state}" for slug, state in mismatches.items())
        raise ContentMismatch(f"Feature states inconsistent with target set: {formatted}")


def _count_changed_substates(entry_data: bytes, result: bytes) -> int:
    edits = 0
    for slug, feature in REGISTRY.items():
        before = feature.observe_substates(entry_data)
        after = feature.observe_substates(result)
        if len(before) != len(after):
            raise ContentMismatch(f"Feature {slug} changed substate count")
        edits += sum(
            before_site.state != after_site.state
            for before_site, after_site in zip(before, after, strict=True)
        )
    return edits


def _verify_committed(
    binary: Path,
    committed: bytes,
    result: bytes,
    baseline: bytes,
    baseline_lineage_sha256: str,
    version: str,
    effective_targets: list[str],
    *,
    signed: bool,
) -> None:
    if not signed and committed != result:
        raise ContentMismatch("Written-back bytes inconsistent with in-memory result")
    _verify_target(committed, effective_targets)
    if extract_version(committed) != version:
        raise ContentMismatch("Binary version after write inconsistent with entry version")
    if not effective_targets and not signed and committed != baseline:
        raise ContentMismatch("Bytes after revert --all inconsistent with clean baseline")
    prove_exact_replay(
        baseline,
        committed,
        adapter=_FEATURE_REPLAY,
        normalize=_lineage_normalize,
        baseline_lineage_sha256=baseline_lineage_sha256,
    )
    if signed and not MACOS_EXECUTABLE_CHECK(binary):
        raise ContentMismatch("macOS binary is not executable after codesign")


def save_named_snapshot(binary: Path, slug: str, *, force: bool = False) -> Path:
    if not atomicio.is_valid_snapshot_slug(slug):
        raise ValueError(f"Invalid snapshot name: {slug!r}")
    try:
        return snapshots.save(binary, slug, force=force, store=_get_store())
    except StoreError as error:
        if error.code == "version_probe_failed":
            raise NoBaselineRejected(NoBaselineReason.VERSION_PROBE_FAILED) from error
        if error.code == "snapshot_exists":
            raise atomicio.SnapshotExists(slug) from error
        raise


def _find_snapshot(
    binary: Path,
    slug: str,
    current_version: str,
    snapshot_version: str | None = None,
):
    if snapshot_version is not None and not atomicio.is_valid_version_format(snapshot_version):
        raise ValueError(f"Invalid version format: {snapshot_version!r}")
    return snapshots.select(
        binary,
        slug,
        current_version=current_version,
        version=snapshot_version,
        store=_get_store(),
    )


def _assert_binary_unchanged(
    binary: Path,
    expected_current: bytes,
) -> None:
    if binary.read_bytes() != expected_current:
        raise ConcurrentBinaryChange(
            f"Binary changed, please retry: {binary}"
        )


def _write_features_locked(
    binary: Path,
    target_features: list[str],
    *,
    entry_data: bytes,
    current_states: dict[str, str],
    version: str,
    store: StoreV1,
    path_key: str,
    log,
) -> WriteOutcome:
    baseline, baseline_pending = _baseline_for_write(
        store, path_key, entry_data, version, current_states
    )

    effective_targets = resolve_closure(target_features)
    replayed = bytearray(baseline)
    for slug in effective_targets:
        REGISTRY[slug].apply(replayed, log=log)
    result = bytes(replayed)
    _verify_target(result, effective_targets)
    if len(result) != len(baseline) or len(result) != len(entry_data):
        raise ContentMismatch("In-memory result length differs from baseline or entry")
    if extract_version(result) != version:
        raise ContentMismatch("In-memory result version differs from transaction entry")
    edits = _count_changed_substates(entry_data, result)

    if baseline_pending:
        store.publish_baseline(
            path_key,
            version,
            baseline,
            _baseline_manifest(path_key, baseline, version),
        )

    asset = store.read_active_baseline(path_key, version)
    _validate_clean_baseline(asset.data, version)
    prove_exact_replay(
        asset.data,
        entry_data,
        adapter=_FEATURE_REPLAY,
        normalize=_lineage_normalize,
        baseline_lineage_sha256=asset.manifest["lineage_sha256"],
    )
    try:
        _assert_binary_unchanged(binary, entry_data)
    except StoreError as error:
        if baseline_pending and error.code == "concurrent_binary_change":
            store.quarantine(
                path_key,
                asset.manifest_path,
                reason="concurrent_binary_change",
                discovered_by="python",
            )
        raise

    if result == entry_data:
        return WriteOutcome(binary, effective_targets, 0, False)

    macos = platform.system() == "Darwin"
    resigned = transaction.commit(
        binary,
        result,
        entry_data,
        store=store,
        path_key=path_key,
        verify_before_replace=lambda observed: prove_exact_replay(
            asset.data,
            observed,
            adapter=_FEATURE_REPLAY,
            normalize=_lineage_normalize,
            baseline_lineage_sha256=asset.manifest["lineage_sha256"],
        ),
        verify_committed=lambda committed, signed: _verify_committed(
            binary,
            committed,
            result,
            baseline,
            asset.manifest["lineage_sha256"],
            version,
            effective_targets,
            signed=signed,
        ),
        codesign=(lambda: maybe_resign_macos(binary, log)) if macos else None,
    )
    return WriteOutcome(binary, effective_targets, edits, resigned)


def restore_snapshot(
    binary: Path,
    slug: str,
    *,
    snapshot_version: str | None = None,
    confirmation: SnapshotRestoreConfirmation | None = None,
    confirmed: bool = False,
) -> WriteOutcome:
    if confirmed and confirmation is None:
        raise ValueError(
            "cross-version confirmation requires a bound confirmation payload"
        )
    _resolve_write_gate()
    store = _get_store()
    identity = store.identity_for(binary)
    lock_path = store.target_dir(identity.path_key) / "write.lock"
    with DirectoryLock(lock_path, implementation="python", command="snapshot-restore"):
        entry_data = binary.read_bytes()
        current_version = extract_version(entry_data)
        if current_version is None:
            raise NoBaselineRejected(NoBaselineReason.VERSION_PROBE_FAILED)
        asset = _find_snapshot(binary, slug, current_version, snapshot_version)
        restored = asset.data
        restored_version = extract_version(restored)
        if restored_version is None:
            raise StoreError("snapshot_invalid", 2, "snapshot version probe failed")
        requested_confirmation = SnapshotRestoreConfirmation(
            entry_sha256=hashlib.sha256(entry_data).hexdigest(),
            current_version=current_version,
            snapshot_version=restored_version,
            snapshot_slug=asset.manifest["slug"],
            snapshot_sha256=asset.manifest["sha256"],
            snapshot_manifest_path=str(asset.manifest_path),
        )
        if confirmation is not None and confirmation != requested_confirmation:
            raise ConcurrentBinaryChange(
                "Binary or snapshot changed after cross-version confirmation; retry"
            )
        if restored_version != current_version and confirmation is None:
            raise CrossVersionSnapshotWarning(requested_confirmation)
        applied = _patched_features(_states(restored))
        effective = resolve_closure(applied)
        if restored == entry_data:
            _assert_binary_unchanged(binary, entry_data)
            return WriteOutcome(binary, effective, 0, False)

        expected_states = _states(restored)
        macos = platform.system() == "Darwin"

        def verify_restored(committed: bytes, signed: bool) -> None:
            if signed:
                if MACOS_NORMALIZE(committed) != MACOS_NORMALIZE(restored):
                    raise ContentMismatch("Normalized bytes differ after snapshot restore")
                if not MACOS_EXECUTABLE_CHECK(binary):
                    raise ContentMismatch("macOS binary is not executable after snapshot restore")
            elif committed != restored:
                raise ContentMismatch("Readback bytes inconsistent after snapshot restore")
            if extract_version(committed) != restored_version:
                raise ContentMismatch("Snapshot version differs after restore")
            if _states(committed) != expected_states:
                raise ContentMismatch("Snapshot feature states differ after restore")

        resigned = transaction.commit(
            binary,
            restored,
            entry_data,
            store=store,
            path_key=identity.path_key,
            verify_before_replace=lambda _observed: None,
            verify_committed=verify_restored,
            codesign=(lambda: maybe_resign_macos(binary, print)) if macos else None,
        )
        return WriteOutcome(binary, effective, 1, resigned)


def write_features(
    binary: Path,
    target_features: list[str],
    *,
    current_data: bytes | None = None,
    entry_digest: str | None = None,
    log=print,
) -> WriteOutcome:
    """Replay an effective feature set from a clean, version-keyed baseline."""
    unknown = [slug for slug in target_features if slug not in REGISTRY]
    if unknown:
        raise KeyError(unknown[0])

    _resolve_write_gate()
    store = _get_store()
    identity = store.identity_for(binary)
    lock_path = store.target_dir(identity.path_key) / "write.lock"
    with DirectoryLock(lock_path, implementation="python", command="write-features"):
        entry_data = binary.read_bytes()
        expected_digest = entry_digest
        if expected_digest is None and current_data is not None:
            expected_digest = hashlib.sha256(current_data).hexdigest()
        if expected_digest is not None and hashlib.sha256(entry_data).hexdigest() != expected_digest:
            raise ConcurrentBinaryChange(
                f"Binary differs from caller entry digest: {binary}",
            )
        current_states = _states(entry_data)
        _check_removed_dependencies(current_states, target_features)
        version = extract_version(entry_data)
        if version is None:
            raise NoBaselineRejected(NoBaselineReason.VERSION_PROBE_FAILED)
        store.ensure_target(identity)
        return _write_features_locked(
            binary,
            target_features,
            entry_data=entry_data,
            current_states=current_states,
            version=version,
            store=store,
            path_key=identity.path_key,
            log=log,
        )
