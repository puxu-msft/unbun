import mmap
import time
from pathlib import Path

from cc_patch import features
from cc_patch.models import FeatureStatus, ProbeSlice


VERSION_ANCHOR = b'overview",VERSION:"'
VERSION_MAX_LEN = 24  # 版本字符串够长就行，避免误吞后续内容
VERSION_CHARS = set("0123456789.")


def extract_version(data: bytes | mmap.mmap) -> str | None:
    """从二进制字节里**只读**抽取自报版本（如 ``2.1.175``）；取不到返回 None。

    ``data`` 可为 ``bytes`` 或 ``mmap`` 视图（二者都支持 ``rfind`` 与切片）。
    锚定内嵌文档 URL 后紧跟的 ``VERSION:"<ver>"`` 字面量。

    用 ``rfind`` **从文件尾部往前扫**：SEA 二进制的 JS bundle 位于尾部(实测版本
    锚点稳定在 ~99% 处)，故从尾扫只触及最后约 1% 字节，比从头 ``find`` 整扫
    240MB 快约一个数量级。该锚点在 bundle 里重复出现且**值全相同**（都是 CLI
    自报版本），故取末处与取首处等价。文件名可能与自报版本不符（安装器原地覆盖
    不改名），此处取的是二进制**真实**自报的版本。
    """
    idx = data.rfind(VERSION_ANCHOR)
    if idx == -1:
        return None
    start = idx + len(VERSION_ANCHOR)
    end = data.find(b'"', start, start + VERSION_MAX_LEN)
    if end == -1:
        return None
    ver = data[start:end].decode("latin-1")  # latin-1 是全集编码，任何字节都可解，不会抛
    # 形如 2.1.175：首尾都是数字、其余只允许数字与点（排除空 / "2.1." / "..." 等残缺值）。
    if not ver or not (ver[0].isdigit() and ver[-1].isdigit()):
        return None
    if any(ch not in VERSION_CHARS for ch in ver):
        return None
    return ver


def _window_slices(view: bytes | mmap.mmap, windows: list[tuple[int, int]]) -> list[ProbeSlice]:
    merged: list[tuple[int, int]] = []
    for lo, hi in sorted(windows):
        if merged and lo <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], hi))
        else:
            merged.append((lo, hi))
    return [ProbeSlice(lo, bytes(view[lo:hi])) for lo, hi in merged]


def detect_features(view: bytes | mmap.mmap) -> dict[str, FeatureStatus]:
    """逐 feature 只复制其探测小窗，并保留完整 ``FeatureStatus``。"""
    statuses = {}
    for name, feature in features.REGISTRY.items():
        windows = feature.probe_windows(view)
        if windows is None:
            statuses[name] = feature.detect_windows([])
            continue
        if hasattr(feature, "candidates_complete") and not feature.candidates_complete(
            view, windows
        ):
            statuses[name] = feature.detect(view)
            continue
        status = feature.detect_windows(_window_slices(view, windows))
        statuses[name] = feature.detect(view) if status is None else status
    return statuses


def quick_status(view: bytes | mmap.mmap) -> dict[str, str]:
    """逐 feature 开小窗快速判级，不把整个二进制复制进内存。"""
    return {name: status.state for name, status in detect_features(view).items()}


def _format_status(statuses: dict[str, str]) -> str:
    return " ".join(f"{name}={state}" for name, state in statuses.items())


def profile_scan(binaries: list[Path], out=print) -> list[tuple[Path, float, float, float]]:
    """**只读**地逐个探测并计时（version / status / 总耗时，毫秒），打印一张表。

    这是常驻的性能量化入口（``--profile``）：扫描慢时直接 ``python3 patch.py
    --profile`` 即可定位是哪台、哪一段慢，不改文件、不弹菜单、不执行二进制。
    返回每个二进制的 ``(path, version_ms, status_ms, total_ms)`` 原始计时。
    """
    out("PROFILE (read-only scan timing, ms, implementation=python)")
    out(f"  {'version':>9} {'status':>9} {'total':>9}   binary")
    rows: list[tuple[Path, float, float, float]] = []
    grand = 0.0
    for binary in binaries:
        t0 = time.perf_counter()
        try:
            with open(binary, "rb") as fh:
                view = mmap.mmap(fh.fileno(), 0, access=mmap.ACCESS_READ)
                try:
                    tv = time.perf_counter()
                    version = extract_version(view)
                    ver_ms = (time.perf_counter() - tv) * 1000
                    ts = time.perf_counter()
                    status = quick_status(view)
                    st_ms = (time.perf_counter() - ts) * 1000
                finally:
                    view.close()
        except (OSError, ValueError):
            out(f"  {'-':>9} {'-':>9} {'-':>9}   {binary}  (unreadable)")
            continue
        total_ms = (time.perf_counter() - t0) * 1000
        grand += total_ms
        rows.append((binary, ver_ms, st_ms, total_ms))
        out(
            f"  {ver_ms:8.1f} {st_ms:8.1f} {total_ms:8.1f}   {binary}  "
            f"[{version or '?'} {_format_status(status)}]"
        )
    if rows:
        out(f"\nTotal {grand:.0f} ms / {len(rows)} (avg {grand / len(rows):.1f} ms)")
    return rows
