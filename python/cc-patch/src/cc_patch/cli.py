from __future__ import annotations

import argparse
import json
import mmap
import sys
from pathlib import Path

from cc_patch import atomicio, orchestrate, snapshots
from cc_patch.binaries import detect_binaries
from cc_patch.features import REGISTRY, resolve_closure
from cc_patch.interactive import select_binaries
from cc_patch.lineage import LineageError
from cc_patch.locking import cleanup_lock, inspect_lock
from cc_patch.models import ERROR_EXIT_CODES, BinaryProbe, CliError, WriteOutcome
from cc_patch.probe import detect_features, extract_version, profile_scan
from cc_patch.report import (
    render_check,
    render_json,
    render_snapshots,
    render_write_outcome,
    render_write_outcomes_json,
)
from cc_patch.store import StoreError, resolve_store_root


class UsageParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        self.print_usage(sys.stderr)
        raise ValueError(f"Cannot recognize or parse command-line arguments: {message}")


def _add_common_flags(parser: argparse.ArgumentParser, *, suppress_defaults: bool = False) -> None:
    default = argparse.SUPPRESS if suppress_defaults else None
    parser.add_argument("--binary", default=default, help="Path to the Claude Code binary")
    parser.add_argument("--check", action="store_true", default=default, help="Analyze only, do not modify files")
    parser.add_argument("--json", action="store_true", default=default, help="Output full JSON status")
    parser.add_argument("--profile", action="store_true", default=default, help="Read-only scan timing")
    parser.add_argument("--all", "-a", action="store_true", default=default, help="Skip interaction and process all")
    parser.add_argument("--feature", action="append", default=default, help="Specify feature (repeatable or comma-separated)")
    parser.add_argument("--yes", action="store_true", default=default, help="Skip interactive confirmation")


def build_parser() -> argparse.ArgumentParser:
    parser = UsageParser(description="Unified Claude Code binary patch manager")
    _add_common_flags(parser)
    subparsers = parser.add_subparsers(dest="command")

    patch = subparsers.add_parser("patch", help="Apply features")
    _add_common_flags(patch, suppress_defaults=True)

    revert = subparsers.add_parser("revert", help="Remove features or restore a snapshot")
    _add_common_flags(revert, suppress_defaults=True)
    revert.add_argument("--snapshot", help="Restore a named snapshot wholesale")
    revert.add_argument("--snapshot-version", help="Specify the version for a same-named snapshot")

    snapshot = subparsers.add_parser("snapshot", help="Manage named snapshots")
    snapshot_subparsers = snapshot.add_subparsers(dest="snapshot_command", required=True)
    snapshot_save = snapshot_subparsers.add_parser("save", help="Save the current binary state")
    snapshot_save.add_argument("name")
    snapshot_save.add_argument("--force", action="store_true")
    snapshot_save.add_argument("--binary")
    snapshot_list = snapshot_subparsers.add_parser("list", help="List snapshots")
    snapshot_list.add_argument("--binary")
    snapshot_remove = snapshot_subparsers.add_parser("rm", help="Remove a snapshot")
    snapshot_remove.add_argument("name")
    snapshot_remove.add_argument("--snapshot-version", help="Specify the version for a same-named snapshot")
    snapshot_remove.add_argument("--binary")

    store = subparsers.add_parser("store", help="Inspect the shared store")
    store_subparsers = store.add_subparsers(dest="store_command", required=True)
    store_subparsers.add_parser("root", help="Print the resolved shared store root")

    lock = subparsers.add_parser("lock", help="Inspect or clean a target write lock")
    lock_subparsers = lock.add_subparsers(dest="lock_command", required=True)
    lock_inspect = lock_subparsers.add_parser("inspect", help="Inspect a target write lock")
    lock_inspect.add_argument("--binary", required=True)
    lock_inspect.add_argument("--json", action="store_true")
    lock_cleanup = lock_subparsers.add_parser("cleanup", help="Clean a target write lock")
    lock_cleanup.add_argument("--binary", required=True)
    lock_cleanup.add_argument("--force", action="store_true")
    lock_cleanup.add_argument("--json", action="store_true")
    return parser


def parse_requested_features(values: list[str] | None) -> set[str] | None:
    if values is None:
        return None
    requested = {
        slug.strip()
        for value in values
        for slug in value.split(",")
        if slug.strip()
    }
    unknown = sorted(requested.difference(REGISTRY))
    if unknown:
        raise ValueError(f"Unknown feature: {', '.join(unknown)}")
    return requested


def _ordered_features(features: set[str]) -> list[str]:
    return [slug for slug in REGISTRY if slug in features]


def _target_features_for_patch(
    current: set[str], requested: set[str] | None
) -> list[str]:
    if requested is None:
        return list(REGISTRY)
    return _ordered_features(current | requested)


def _target_features_for_revert(
    current: set[str], requested: set[str] | None
) -> list[str]:
    if requested is None:
        return []
    remaining = current - requested
    required_by_remaining = set(resolve_closure(_ordered_features(remaining)))
    conflicts = requested & required_by_remaining
    if conflicts:
        dependency = _ordered_features(conflicts)[0]
        dependants = [
            slug
            for slug in _ordered_features(remaining)
            if dependency in resolve_closure([slug])
        ]
        raise orchestrate.DependentFeatureStillEnabled(dependency, dependants)
    removed_closure = set(resolve_closure(_ordered_features(requested)))
    remaining_roots = _ordered_features(remaining - removed_closure)
    return resolve_closure(remaining_roots)


def probe_binary(path: Path) -> BinaryProbe:
    try:
        size_bytes = path.stat().st_size
        with path.open("rb") as handle:
            with mmap.mmap(handle.fileno(), 0, access=mmap.ACCESS_READ) as view:
                version = extract_version(view)
                statuses = detect_features(view)
    except (OSError, ValueError) as error:
        return BinaryProbe(path, None, {}, 0, False, {"message": str(error)})
    store = orchestrate._get_store()
    identity = store.identity_for(path)
    has_baseline = version is not None and store.find_active_baseline(identity.path_key, version) is not None
    # L4-03：`status.path` 是公开契约字段，且会经 TUI 回流成写入目标，必须报**实际会被写入的对象**
    # （canonical/realpath），与 JS `status.mjs` 对齐；报用户传入的 symlink 路径会与写入对象不一致。
    return BinaryProbe(Path(identity.canonical_path), version, statuses, size_bytes, has_baseline)


def _select_read_only_binaries(args: argparse.Namespace) -> list[Path] | None:
    return select_binaries(
        args,
        interactive=sys.stdin.isatty(),
        detector=detect_binaries,
    )


def _run_read_only(args: argparse.Namespace, binaries: list[Path]) -> int:
    if args.profile:
        profile_scan(binaries)
        return 0
    probes = [probe_binary(binary) for binary in binaries]
    print(render_json(probes) if args.json else render_check(probes))
    return 0


def _current_features(data: bytes) -> set[str]:
    return {
        slug
        for slug, feature in REGISTRY.items()
        if feature.detect(data).state in {"patched", "mixed"}
    }


def _translate_write_error(error: Exception) -> tuple[str, str, dict[str, object]]:
    # L3C-07: 平台写 gate 的 fail-closed 拒绝（platform_write_disabled/unsupported）必须原样传播。
    # 这些码现已进入冻结 catalog；若在此被重映射成 content_mismatch，gate 的对外可观察行为
    # （exit 1 + 稳定 code）就与文档承诺不符，自动化也无法据此区分「平台不允许写」与「内容损坏」。
    if isinstance(error, LineageError):
        return error.code, str(error), {"category": "platform_write_gate", "platform_error": error.code}
    if isinstance(error, atomicio.SnapshotExists):
        return "snapshot_exists", "A snapshot with this name already exists; add --force to overwrite.", {}
    if isinstance(error, orchestrate.DependentFeatureStillEnabled):
        dependants = ", ".join(error.dependants)
        return (
            "unsupported_or_mixed_no_baseline",
            f"Revert features depending on it first ({dependants})",
            {
                "category": "dependency_conflict",
                "dependency": error.feature,
                "dependants": error.dependants,
            },
        )
    if isinstance(error, orchestrate.VersionDriftRejected):
        return "baseline_stale_build", "Baseline version differs from current binary; downgrade rejected", {}
    if isinstance(error, orchestrate.NoBaselineRejected):
        messages = {
            orchestrate.NoBaselineReason.CHANNELS_PATCHED_NO_BASELINE: "channels is patched but has no clean baseline; reinstall a clean Claude Code",
            orchestrate.NoBaselineReason.VERSION_PROBE_FAILED: "Cannot probe binary version; write rejected",
            orchestrate.NoBaselineReason.REBUILD_ROUNDTRIP_FAILED: "Binary reversibility check failed; data may be corrupted",
            orchestrate.NoBaselineReason.UNSUPPORTED_OR_MIXED_NO_BASELINE: "Inbound binary structure cannot safely establish a baseline; reinstall a clean Claude Code",
            orchestrate.NoBaselineReason.INVALID_BASELINE: "Baseline content or version check failed; reinstall or rebuild the clean baseline",
        }
        return error.code, messages[error.reason], {}
    if isinstance(error, orchestrate.ConcurrentBinaryChange):
        return error.code, "Binary was modified concurrently during the operation (possible auto-upgrade); retry", {}
    if isinstance(error, LineageError):
        if error.code in ERROR_EXIT_CODES:
            return error.code, str(error), {}
        return (
            "content_mismatch",
            str(error),
            {"category": "internal_lineage_error", "internal_code": error.code},
        )
    if isinstance(error, StoreError):
        if error.code in ERROR_EXIT_CODES:
            return error.code, str(error), {}
        return (
            "content_mismatch",
            str(error),
            {"category": "internal_store_error", "internal_code": error.code},
        )
    if isinstance(error, orchestrate.ContentMismatch):
        return "content_mismatch", f"Content consistency check failed: {error}", {}
    if isinstance(error, atomicio.SnapshotNotFound):
        return "snapshot_not_found", str(error), {}
    if isinstance(error, atomicio.AmbiguousSnapshot):
        return "snapshot_ambiguous", str(error), {}
    if isinstance(error, OSError):
        return (
            "baseline_not_found",
            f"Cannot access binary or runtime environment: {error}",
            {"category": "target_access_failed", "error_type": type(error).__name__},
        )
    if isinstance(error, (ValueError, KeyError)):
        if str(error).startswith("Cannot replace "):
            return "binary_in_use", f"Cannot access binary or runtime environment: {error}", {}
        # L3C-08: feature anchor／replay／依赖解析等普通 ValueError/KeyError 与 macOS 签名无关，
        # 过去一律标成 codesign_failed(exit 3)，会误导自动化重试并与 JS 默认行为漂移。
        # 归一到 content_mismatch(exit 2)，与 JS `structuredError` 的默认码一致。
        return (
            "content_mismatch",
            f"Feature action failed: {error}",
            {"category": "feature_action_failed", "error_type": type(error).__name__},
        )
    raise error


def _run_feature_write(
    binary: Path,
    command: str,
    requested: set[str] | None,
    *,
    json_mode: bool,
) -> tuple[int, WriteOutcome | None, CliError | None]:
    try:
        current_data = binary.read_bytes()
        current = _current_features(current_data)
        targets = (
            _target_features_for_patch(current, requested)
            if command == "patch"
            else _target_features_for_revert(current, requested)
        )
        outcome = orchestrate.write_features(
            binary,
            targets,
            current_data=current_data,
            log=lambda message: print(message, file=sys.stderr) if json_mode else print(message),
        )
    except Exception as error:
        error_code, message, details = _translate_write_error(error)
        code = ERROR_EXIT_CODES[error_code]
        print(message, file=sys.stderr)
        return code, None, CliError(error_code, message, binary, details=details)
    if not json_mode:
        print(render_write_outcome(outcome, action="Reverted" if command == "revert" else "Patched"))
    return 0, outcome, None


def _run_many_feature_writes(
    binaries: list[Path],
    command: str,
    requested: set[str] | None,
    *,
    json_mode: bool,
) -> int:
    exit_code = 0
    outcomes: list[WriteOutcome] = []
    errors: list[CliError] = []
    for binary in binaries:
        code, outcome, error = _run_feature_write(
            binary,
            command,
            requested,
            json_mode=json_mode,
        )
        exit_code = max(exit_code, code)
        if outcome is not None:
            outcomes.append(outcome)
        if error is not None:
            errors.append(error)
    if json_mode:
        print(
            render_write_outcomes_json(
                action=command,
                exit_code=exit_code,
                outcomes=outcomes,
                errors=errors,
            )
        )
    return exit_code


def _snapshot_binaries(args: argparse.Namespace) -> list[Path] | None:
    return _select_read_only_binaries(args)


def _run_snapshot_command(args: argparse.Namespace, binaries: list[Path]) -> int:
    exit_code = 0
    outcomes: list[WriteOutcome] = []
    errors: list[CliError] = []
    listed: list[dict[str, object]] = []
    for binary in binaries:
        try:
            if args.snapshot_command == "save":
                saved = orchestrate.save_named_snapshot(binary, args.name, force=args.force)
                outcomes.append(
                    WriteOutcome(
                        binary,
                        resolve_closure(_ordered_features(_current_features(binary.read_bytes()))),
                        0,
                        False,
                    )
                )
                if not args.json:
                    print(f"Snapshot saved -> {saved}")
            elif args.snapshot_command == "list":
                with binary.open("rb") as handle:
                    with mmap.mmap(handle.fileno(), 0, access=mmap.ACCESS_READ) as view:
                        version = extract_version(view)
                if version is None:
                    raise orchestrate.NoBaselineRejected(
                        orchestrate.NoBaselineReason.VERSION_PROBE_FAILED
                    )
                infos = snapshots.list_for_binary(
                    binary, current_version=version, store=orchestrate._get_store()
                )
                listed.extend(
                    {
                        "binary": str(binary),
                        "slug": info.slug,
                        "version": info.version,
                        "invalid": info.invalid,
                    }
                    for info in infos
                )
                if not args.json:
                    print(f"{binary}\n{render_snapshots(infos)}")
            else:
                removed = snapshots.remove(
                    binary,
                    args.name,
                    version=args.snapshot_version,
                    store=orchestrate._get_store(),
                )
                outcomes.append(
                    WriteOutcome(
                        binary,
                        resolve_closure(_ordered_features(_current_features(binary.read_bytes()))),
                        0,
                        False,
                    )
                )
                if not args.json:
                    print(f"Snapshot removed -> {removed}")
        except Exception as error:
            error_code, message, details = _translate_write_error(error)
            code = ERROR_EXIT_CODES[error_code]
            print(message, file=sys.stderr)
            exit_code = max(exit_code, code)
            errors.append(CliError(error_code, message, binary, details=details))
    if args.json:
        if args.snapshot_command == "list":
            print(json.dumps({"schema_version": 1, "snapshots": listed}, indent=2))
        else:
            print(
                render_write_outcomes_json(
                    action=f"snapshot-{args.snapshot_command}",
                    exit_code=exit_code,
                    outcomes=outcomes,
                    errors=errors,
                )
            )
    return exit_code


def run_tui(binaries: list[Path]) -> int | None:
    """惰性加载 Textual TUI；非 TTY 时由其返回 None。"""
    from cc_patch.tui.app import run_tui as _run_tui

    return _run_tui(binaries)


def _snapshot_warning(error: orchestrate.CrossVersionSnapshotWarning) -> str:
    return (
        f"Warning: cross-version snapshot {error.snapshot_version} will overwrite the current version "
        f"{error.current_version}, which may cause a downgrade."
    )


def _run_snapshot_restore(
    binary: Path,
    slug: str,
    *,
    snapshot_version: str | None,
    yes: bool,
    json_mode: bool,
) -> int:
    outcome: WriteOutcome | None = None
    cli_error: CliError | None = None
    exit_code = 0
    try:
        outcome = orchestrate.restore_snapshot(
            binary,
            slug,
            snapshot_version=snapshot_version,
        )
    except orchestrate.CrossVersionSnapshotWarning as warning:
        print(_snapshot_warning(warning), file=sys.stderr)
        confirmed = yes
        if not confirmed and sys.stdin.isatty():
            try:
                confirmed = input("Confirm restore? [y/N] ").strip().lower() in {"y", "yes"}
            except EOFError:
                confirmed = False
        if not confirmed:
            message = "Cross-version restore not confirmed; aborting. Use --yes to skip confirmation."
            print(message, file=sys.stderr)
            exit_code = 1
            cli_error = CliError(
                "snapshot_invalid",
                message,
                binary,
                details={
                    "current_version": warning.current_version,
                    "snapshot_version": warning.snapshot_version,
                    "confirmation_required": True,
                },
            )
        else:
            try:
                outcome = orchestrate.restore_snapshot(
                    binary,
                    slug,
                    snapshot_version=snapshot_version,
                    confirmation=warning.confirmation,
                )
            except Exception as error:
                error_code, message, details = _translate_write_error(error)
                exit_code = ERROR_EXIT_CODES[error_code]
                print(message, file=sys.stderr)
                cli_error = CliError(error_code, message, binary, details=details)
    except Exception as error:
        error_code, message, details = _translate_write_error(error)
        exit_code = ERROR_EXIT_CODES[error_code]
        print(message, file=sys.stderr)
        cli_error = CliError(error_code, message, binary, details=details)
    if json_mode:
        print(
            render_write_outcomes_json(
                action="snapshot-restore",
                exit_code=exit_code,
                outcomes=[] if outcome is None else [outcome],
                errors=[] if cli_error is None else [cli_error],
            )
        )
    elif outcome is not None:
        print(render_write_outcome(outcome, action="Restored snapshot"))
    return exit_code


def main(argv: list[str] | None = None) -> int:
    try:
        args = build_parser().parse_args(argv)
        requested = parse_requested_features(getattr(args, "feature", None))
    except ValueError as error:
        print(error, file=sys.stderr)
        return 1

    command = args.command or "patch"
    if command == "store":
        try:
            print(resolve_store_root())
        except StoreError as error:
            print(error, file=sys.stderr)
            return error.exit_code
        return 0

    if command == "lock":
        try:
            store = orchestrate._get_store()
            identity = store.identity_for(Path(args.binary))
            lock_path = store.target_dir(identity.path_key) / "write.lock"
            if args.lock_command == "inspect":
                diagnosis = inspect_lock(lock_path)
                payload = {
                    "locked": diagnosis.locked,
                    "owner": diagnosis.owner,
                    "owner_known": diagnosis.owner_known,
                    "pid_exists": diagnosis.pid_exists,
                    "message": diagnosis.message,
                }
                print(json.dumps(payload, indent=2) if args.json else diagnosis.message)
            else:
                cleanup_lock(lock_path, force=args.force)
                if args.json:
                    data = Path(args.binary).read_bytes()
                    outcome = WriteOutcome(
                        Path(args.binary),
                        resolve_closure(_ordered_features(_current_features(data))),
                        0,
                        False,
                    )
                    print(
                        render_write_outcomes_json(
                            action="lock-cleanup",
                            exit_code=0,
                            outcomes=[outcome],
                            errors=[],
                        )
                    )
                else:
                    print(f"Lock cleaned -> {lock_path}")
        except StoreError as error:
            message = str(error)
            if error.code == "target_locked" and not getattr(args, "force", False):
                message = f"{message}; retry with --force"
            print(message, file=sys.stderr)
            if getattr(args, "json", False):
                print(
                    render_write_outcomes_json(
                        action="lock-cleanup",
                        exit_code=error.exit_code,
                        outcomes=[],
                        errors=[CliError(error.code, message, Path(args.binary))],
                    )
                )
            return error.exit_code
        return 0
    if args.check and command == "revert":
        # 旧脚本返回 2；spec §6 有意把所有用法冲突统一映射为退出码 1。
        print("Cannot use --check together with revert.", file=sys.stderr)
        return 1

    if args.check or args.profile:
        binaries = _select_read_only_binaries(args)
        if binaries is None:
            return 1
        return _run_read_only(args, binaries)

    if command == "snapshot":
        binaries = _snapshot_binaries(args)
        if binaries is None:
            return 1
        return _run_snapshot_command(args, binaries)

    default_tui_mode = args.command is None and not any(
        (args.all, args.binary, args.feature, args.json, args.yes)
    )
    if default_tui_mode:
        binaries = detect_binaries()
        if not binaries:
            print(
                "Could not auto-detect a Claude Code binary. Use --binary <path> to specify.",
                file=sys.stderr,
            )
            return 1
        if not (sys.stdin.isatty() and sys.stdout.isatty()):
            return _run_read_only(args, binaries)
        exit_code = run_tui(binaries)
        if exit_code is None:
            return _run_read_only(args, binaries)
        return exit_code

    # L3C-01 (Blocker): 写权限只能由**显式 mutating 子命令**授予，绝不能由「有没有带某个选项」推导。
    # 旧逻辑 `command = args.command or "patch"` 让 `ccpatch --binary X`（无子命令）在非 TTY 下
    # 直接 patch 全部 feature——实测把 clean golden 从 0a067e… 改写成 3a8abf…。JS 侧同形调用是只读
    # status。故：无子命令 ⇒ 一律走只读路径（TTY 下开 TUI，由 TUI 显式提交才写）。
    if args.command is None:
        binaries = _select_read_only_binaries(args)
        if binaries is None:
            return 1
        if sys.stdin.isatty() and sys.stdout.isatty() and not args.json:
            exit_code = run_tui(binaries)
            if exit_code is not None:
                return exit_code
        return _run_read_only(args, binaries)

    binaries = _select_read_only_binaries(args)
    if binaries is None:
        return 1

    if command == "revert" and args.snapshot is not None:
        exit_code = 0
        for binary in binaries:
            exit_code = max(
                exit_code,
                _run_snapshot_restore(
                    binary,
                    args.snapshot,
                    snapshot_version=args.snapshot_version,
                    yes=args.yes,
                    json_mode=args.json,
                ),
            )
        return exit_code
    return _run_many_feature_writes(
        binaries,
        command,
        requested,
        json_mode=args.json,
    )


def main_entry() -> None:
    raise SystemExit(main())
