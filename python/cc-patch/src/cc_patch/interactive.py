from __future__ import annotations

import sys
from pathlib import Path
from typing import Callable

from cc_patch.binaries import detect_binaries
from cc_patch.models import BinaryProbe


def parse_selection(raw: str, count: int) -> list[int] | None:
    """把用户输入解析为 0-based 选中索引列表；非法输入返回 None。"""
    raw = raw.strip().lower()
    if raw in ("", "a", "all"):
        return list(range(count))
    if raw in ("q", "quit", "none"):
        return []

    indices: set[int] = set()
    for token in raw.replace(",", " ").split():
        if "-" in token:
            lo, _, hi = token.partition("-")
            if not (lo.isdigit() and hi.isdigit()):
                return None
            low, high = int(lo), int(hi)
            if low > high:
                low, high = high, low
            if not (1 <= low <= count and 1 <= high <= count):
                return None
            indices.update(range(low - 1, high))
        else:
            if not token.isdigit():
                return None
            number = int(token)
            if not 1 <= number <= count:
                return None
            indices.add(number - 1)
    return sorted(indices)


def _overall_state(probe: BinaryProbe) -> str:
    if probe.probe_error is not None:
        return "error"
    states = {status.state for status in probe.features.values()}
    if len(states) == 1:
        return next(iter(states))
    return "mixed"


def _format_probe_row(index: int, probe: BinaryProbe) -> str:
    version = probe.version or "?"
    size = f"{probe.size_bytes / (1024 * 1024):.0f} MB"
    baseline = " [baseline]" if probe.has_baseline else ""
    head = f"  [{index}] {version:<8} {_overall_state(probe):<11} {size:>7}{baseline}"
    return f"{head}\n      {probe.path}"


def prompt_binary_selection(
    binaries: list[Path],
    action: str,
    reader=input,
    out=print,
    prober: Callable[[Path], BinaryProbe] | None = None,
) -> list[Path]:
    if prober is None:
        from cc_patch.cli import probe_binary

        prober = probe_binary
    out(f"Detected {len(binaries)} Claude Code binaries, probing (version / feature state, read-only)...\n")
    for index, binary in enumerate(binaries, 1):
        out(_format_probe_row(index, prober(binary)))
    out("")
    out(f"Select which to {action}: index (comma/space/range, e.g. 1,3 or 1-2) | enter/all=all | q=cancel")

    while True:
        try:
            raw = reader("> ")
        except EOFError:
            return []
        chosen = parse_selection(raw, len(binaries))
        if chosen is None:
            out("Invalid input, please retry.")
            continue
        return [binaries[index] for index in chosen]


def select_binaries(
    args,
    *,
    interactive: bool,
    detector=None,
    prompter=None,
) -> list[Path] | None:
    """返回 None 表示未检测到二进制；返回 [] 表示用户取消。"""
    if args.binary:
        return [Path(args.binary)]

    detector = detector or detect_binaries
    prompter = prompter or prompt_binary_selection
    binaries = detector()
    if not binaries:
        print("Could not auto-detect a Claude Code binary. Use --binary <path> to specify.", file=sys.stderr)
        return None

    if args.all or args.profile or len(binaries) == 1:
        return binaries
    if not interactive:
        # L4-05：非交互环境下检测到多个目标时，绝不能默认全选——若调用方带的是 mutating 子命令
        # （patch / revert / snapshot restore），那等于静默批量改写多个 live 二进制。这条守卫在 JS
        # 侧是结构性成立的（只解析单个 realpath），Python 侧此前只打印一行提示就 defaulting to all。
        # 只读路径（--check / --profile / 无子命令）不受影响，仍可一次报告全部。
        mutating = getattr(args, "command", None) in {"patch", "revert", "snapshot"} and not getattr(args, "check", False)
        if mutating:
            listed = "\n".join(f"  {binary}" for binary in binaries)
            print(
                f"Refusing to write to {len(binaries)} detected binaries without an explicit choice.\n"
                f"{listed}\n"
                "Re-run with --binary <path> to pick one, or --all to write to every one of them.",
                file=sys.stderr,
            )
            return []
        print(
            "Multiple binaries detected but not an interactive terminal; reporting on all of them "
            "(use --binary or --all to be explicit).",
            file=sys.stderr,
        )
        return binaries
    if getattr(args, "json", False):
        return binaries

    action = "check" if args.check else (args.command or "patch")
    chosen = prompter(binaries, action)
    if not chosen:
        print("No binary selected, exiting.")
    return chosen
