from cc_patch.features import register
from cc_patch.features.bytes_util import find_all
from cc_patch.features.replay import validate_replay
from cc_patch.models import FeatureStatus, FeatureSubstate, ProbeSlice


BUN_TAG_PREFIX = b"// @bun "
BUN_BYTECODE_MARKER = b"@bytecode"
BUN_SOURCE_FALLBACK_MARKER = b"@source__"
SOURCE_EXEC_CLEAN_SITE = b" " + BUN_BYTECODE_MARKER
SOURCE_EXEC_PATCHED_SITE = b" " + BUN_SOURCE_FALLBACK_MARKER
PROBE_WINDOW = 8_000


def _locate_sites(data: bytes) -> list[int]:
    """定位 ``// @bun @bytecode``（或已改过的 ``@source__``）标记位置。"""
    sites = []
    span = len(SOURCE_EXEC_CLEAN_SITE)
    for off in find_all(data, BUN_TAG_PREFIX):
        site = off + len(BUN_TAG_PREFIX) - 1
        tag = data[site : site + span]
        if tag in (SOURCE_EXEC_CLEAN_SITE, SOURCE_EXEC_PATCHED_SITE):
            sites.append(site)
    return sites


def _status_from_substates(substates: list[FeatureSubstate]) -> FeatureStatus:
    if not substates:
        return FeatureStatus(
            "source-exec", "unsupported", ["bun bytecode fallback: absent"], 0
        )
    states = {site.state for site in substates}
    state = states.pop() if len(states) == 1 else "mixed"
    return FeatureStatus(
        "source-exec",
        state,
        [f"bun bytecode fallback: {state} ({len(substates)})"],
        len(substates),
        tuple(substates),
    )


def _normalize_slices(windows: list[ProbeSlice | bytes]) -> list[ProbeSlice]:
    return [
        window if isinstance(window, ProbeSlice) else ProbeSlice(0, window)
        for window in windows
    ]


class SourceExecFeature:
    name = "source-exec"
    title = "Source execution"
    description = "Force the Bun runtime to execute the patchable JavaScript source copy."
    requires: list[str] = []
    reversible = True

    def observe_substates(self, data: bytes, base_offset: int = 0) -> list[FeatureSubstate]:
        substates = []
        span = len(SOURCE_EXEC_CLEAN_SITE)
        for index, site in enumerate(_locate_sites(data)):
            value = data[site : site + span]
            state = "clean" if value == SOURCE_EXEC_CLEAN_SITE else "patched"
            substates.append(
                FeatureSubstate(
                    f"source-exec:tag:{index}", base_offset + site, span, state
                )
            )
        return substates

    def detect(self, data: bytes) -> FeatureStatus:
        return _status_from_substates(self.observe_substates(data))

    def probe_windows(self, view: bytes) -> list[tuple[int, int]] | None:
        """全文件锚点 census：对每个有效 `// @bun` 命中开一个 ±8,000 的小窗。

        旧实现只扫首尾各 32,000,000 bytes，中段的标记会被**静默漏掉**——而
        ``candidates_complete`` 只检查候选是否跨越 discovery 边界、不检查「有没有从未
        扫过的区域」，所以连 fail-closed 回落都不会触发，直接违反「不允许返回较少站点
        的快速近似」。改为全文件反查：``find`` 走 mmap 只触及页缓存，比回落整读再
        逐字节解码便宜得多。
        """
        windows: list[tuple[int, int]] = []
        tag = 0
        while (tag := view.find(BUN_TAG_PREFIX, tag)) != -1:
            lo = max(0, tag - PROBE_WINDOW)
            hi = min(
                len(view),
                tag + len(BUN_TAG_PREFIX) + len(BUN_BYTECODE_MARKER) + PROBE_WINDOW,
            )
            if _locate_sites(bytes(view[lo:hi])):
                windows.append((lo, hi))
            tag += 1
        return windows or None

    def probe_window(self, view: bytes) -> tuple[int, int] | None:
        """返回最后一个探测窗，兼容只需定位单个锚点的调用方。"""
        windows = self.probe_windows(view)
        return None if windows is None else windows[-1]

    def detect_windows(self, windows: list[ProbeSlice | bytes]) -> FeatureStatus:
        substates: list[FeatureSubstate] = []
        seen: set[tuple[int, int]] = set()
        for window in _normalize_slices(windows):
            for substate in self.observe_substates(window.data, window.offset):
                key = (substate.offset, substate.length)
                if key not in seen:
                    seen.add(key)
                    substates.append(substate)
        substates.sort(key=lambda site: site.offset)
        substates = [
            FeatureSubstate(
                f"source-exec:tag:{index}",
                site.offset,
                site.length,
                site.state,
            )
            for index, site in enumerate(substates)
        ]
        return _status_from_substates(substates)

    def replay_substates(
        self,
        data: bytearray,
        substates: list[FeatureSubstate] | tuple[FeatureSubstate, ...],
        target_state: str | None = None,
    ) -> int:
        replacements = {
            "clean": SOURCE_EXEC_CLEAN_SITE,
            "patched": SOURCE_EXEC_PATCHED_SITE,
        }
        current_substates = self.observe_substates(bytes(data))
        desired_substates = [
            FeatureSubstate(
                site.identity,
                site.offset,
                site.length,
                target_state or site.state,
            )
            for site in substates
        ]
        validate_replay(current_substates, desired_substates)
        edits = 0
        for substate in desired_substates:
            desired = substate.state
            current = bytes(data[substate.offset : substate.offset + substate.length])
            if current not in replacements.values():
                raise ValueError(f"source-exec site mismatch: {substate.identity}")
            replacement = replacements[desired]
            if current != replacement:
                data[substate.offset : substate.offset + substate.length] = replacement
                edits += 1
        return edits

    def apply(self, data: bytearray, log=lambda _message: None) -> int:
        """把 ``// @bun @bytecode`` 改为 ``// @bun @source__``，强制运行时走源码副本。"""
        substates = self.observe_substates(bytes(data))
        edits = self.replay_substates(data, substates, "patched")
        for site in substates:
            log(f"  OK bun bytecode fallback @{site.offset}")
        return edits

    def reverse(self, data: bytearray, log=lambda _message: None) -> int:
        substates = self.observe_substates(bytes(data))
        edits = self.replay_substates(data, substates, "clean")
        for site in substates:
            log(f"  OK bun source fallback reverse @{site.offset}")
        return edits


FEATURE = SourceExecFeature()
register(FEATURE)
