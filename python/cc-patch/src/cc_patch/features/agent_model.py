from cc_patch.features import register
from cc_patch.features.bytes_util import find_all
from cc_patch.models import FeatureStatus, FeatureSubstate, ProbeSlice


# Agent 工具 model 参数的真实结构（实测 2.1.214~2.1.217）形如：
#   <VAR>.enum(["sonnet","opus","haiku","fable"]).optional().describe(`Optional model override for this agent. ...`)
# 其中 <VAR> 是 bun 每次 build 都会重命名的 minified 变量（实测 S/E/A 轮换），
# **绝不**把它纳入锚点——旧实现把 `E` 写死在锚点与替换串里，一旦 bun 换名整个
# feature 就静默降级为 unsupported。改为：
#   - 锚点用其后紧跟的**稳定 describe 文本**（`DESCRIBE_SUFFIX`），跨版本不变且全局唯一；
#   - 只把 `enum([...])` 段等长替换为 `string()`，`<VAR>.` 前缀原样保留、无需知道它是什么。
ENUM_CORE = b'enum(["sonnet","opus","haiku","fable"])'
REPLACE_CORE_BASE = b"string()"
# describe 文本紧跟在 enum(...) 之后，clean 与 patched 两态共有，作为定位/探测锚点。
# 只取到 `agent` 为止，避免把易变的后续产品文案纳入锚点。
DESCRIBE_SUFFIX = b".optional().describe(`Optional model override for this agent"
PROBE_WINDOW = 8_000
UNKNOWN_VARIANT_CODE = "agent_model_variant_unsupported"
UNKNOWN_LOOKBACK = 512


def build_replacement() -> bytes:
    """构造与 ``ENUM_CORE`` **等长**的替换串：``string()`` + 块注释补齐。

    形如 ``string()/* any model ... */`` 并用点号补足，保证等长替换（偏移不变）。
    """
    pad_len = len(ENUM_CORE) - len(REPLACE_CORE_BASE)
    if pad_len < 4:  # 至少放得下 /* */
        raise RuntimeError("Anchor shorter than replacement; equal-length swap impossible")
    inner = b" any model "  # 注释内容
    fill = pad_len - len(b"/*") - len(b"*/")
    if len(inner) > fill:
        inner = b""
    comment = b"/*" + inner + b"." * (fill - len(inner)) + b"*/"
    rep = REPLACE_CORE_BASE + comment
    assert len(rep) == len(ENUM_CORE), (len(rep), len(ENUM_CORE))
    return rep


REPLACE_CORE = build_replacement()
# 完整锚点（含变量无关的 core + 稳定 describe 后缀），供探测与断言使用。
ENUM_ANCHOR = ENUM_CORE + DESCRIBE_SUFFIX
PATCHED_ANCHOR = REPLACE_CORE + DESCRIBE_SUFFIX


def _locate_clean_sites(data: bytes) -> list[int]:
    """返回未补丁站点 ``enum([...])`` 核心的起始偏移（以稳定 describe 后缀反向定位）。"""
    sites = []
    for suffix_off in find_all(data, DESCRIBE_SUFFIX):
        core = suffix_off - len(ENUM_CORE)
        if core >= 0 and data[core:suffix_off] == ENUM_CORE:
            sites.append(core)
    return sites


def _locate_patched_sites(data: bytes) -> list[int]:
    """返回已被替换为 ``string()...`` 的站点核心起始偏移。"""
    sites = []
    for suffix_off in find_all(data, DESCRIBE_SUFFIX):
        core = suffix_off - len(REPLACE_CORE)
        if core >= 0 and data[core:suffix_off] == REPLACE_CORE:
            sites.append(core)
    return sites


def _locate_unknown_sites(data: bytes) -> list[tuple[int, int]]:
    known_suffixes = set(_locate_clean_sites(data)) | set(_locate_patched_sites(data))
    sites: list[tuple[int, int]] = []
    for suffix_off in find_all(data, DESCRIBE_SUFFIX):
        if suffix_off - len(ENUM_CORE) in known_suffixes:
            continue
        start = data.rfind(b"enum([", max(0, suffix_off - UNKNOWN_LOOKBACK), suffix_off)
        if start != -1 and data[start:suffix_off].endswith(b"])"):
            sites.append((start, suffix_off - start))
    return sites


def _status_from_substates(substates: list[FeatureSubstate]) -> FeatureStatus:
    unsupported = [site for site in substates if site.state == "unsupported"]
    recognized = [site for site in substates if site.state in ("clean", "patched")]
    if unsupported:
        return FeatureStatus(
            "agent-model",
            "unsupported",
            ["model enum: audited variant not found"],
            0,
            tuple(substates),
            (UNKNOWN_VARIANT_CODE,),
        )
    if not recognized:
        return FeatureStatus(
            "agent-model",
            "unsupported",
            ["model enum: anchor not found (version structure may have changed)"],
            0,
        )
    states = {site.state for site in recognized}
    state = states.pop() if len(states) == 1 else "mixed"
    if state == "mixed":
        detail = "model enum: mixed (clean={}, patched={})".format(
            sum(site.state == "clean" for site in recognized),
            sum(site.state == "patched" for site in recognized),
        )
    else:
        detail = f"model enum: {state} ({len(recognized)})"
    return FeatureStatus(
        "agent-model", state, [detail], len(recognized), tuple(recognized)
    )


def _normalize_slices(windows: list[ProbeSlice | bytes]) -> list[ProbeSlice]:
    return [
        window if isinstance(window, ProbeSlice) else ProbeSlice(0, window)
        for window in windows
    ]


class AgentModelFeature:
    name = "agent-model"
    title = "Agent model name"
    description = "Open up the enum whitelist of the Agent tool model parameter."
    requires: list[str] = []
    reversible = True

    def observe_substates(self, data: bytes, base_offset: int = 0) -> list[FeatureSubstate]:
        found: list[tuple[int, int, str, str | None]] = []
        found.extend((site, len(ENUM_CORE), "clean", None) for site in _locate_clean_sites(data))
        found.extend(
            (site, len(REPLACE_CORE), "patched", None)
            for site in _locate_patched_sites(data)
        )
        found.extend(
            (site, length, "unsupported", UNKNOWN_VARIANT_CODE)
            for site, length in _locate_unknown_sites(data)
        )
        found.sort(key=lambda item: item[0])
        return [
            FeatureSubstate(
                f"agent-model:schema:{index}",
                base_offset + site,
                length,
                state,
                code,
            )
            for index, (site, length, state, code) in enumerate(found)
        ]

    def detect(self, data: bytes) -> FeatureStatus:
        return _status_from_substates(self.observe_substates(data))

    def probe_windows(self, view: bytes) -> list[tuple[int, int]] | None:
        """在 describe 后缀两态共有，故单次反向定位即可覆盖 clean/patched。

        用无界 ``rfind``（与 channels 一致）：反向搜索命中即止，仅触及尾部至锚点
        （实测锚点在 ~93%，距尾 ~18MB），不整读整个二进制；只有真正 unsupported 的
        版本才会反扫全程。旧实现的 16MB 尾窗过窄、够不到 ~93% 处的锚点，是导致误判
        unsupported 的第二重原因，此处一并修掉。
        """
        windows: list[tuple[int, int]] = []
        end = len(view)
        while (idx := view.rfind(DESCRIBE_SUFFIX, 0, end)) != -1:
            lo = max(0, idx - PROBE_WINDOW)
            hi = min(len(view), idx + len(DESCRIBE_SUFFIX) + PROBE_WINDOW)
            if self.observe_substates(bytes(view[lo:hi])):
                windows.append((lo, hi))
            end = idx
        return windows or None

    def probe_window(self, view: bytes) -> tuple[int, int] | None:
        """返回最后一个有效探测窗，兼容只需定位单个锚点的调用方。"""
        windows = self.probe_windows(view)
        if windows is None:
            return None
        for lo, hi in windows:
            if self.detect(bytes(view[lo:hi])).state != "unsupported":
                return lo, hi
        return None

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
                f"agent-model:schema:{index}",
                site.offset,
                site.length,
                site.state,
                site.detail_code,
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
        replacements = {"clean": ENUM_CORE, "patched": REPLACE_CORE}
        edits = 0
        for substate in substates:
            desired = target_state or substate.state
            if desired not in replacements or substate.length != len(ENUM_CORE):
                raise ValueError(f"{UNKNOWN_VARIANT_CODE}: {substate.identity}")
            current = bytes(data[substate.offset : substate.offset + substate.length])
            if current not in replacements.values():
                raise ValueError(f"agent-model site mismatch: {substate.identity}")
            replacement = replacements[desired]
            if current != replacement:
                data[substate.offset : substate.offset + substate.length] = replacement
                edits += 1
        return edits

    def apply(self, data: bytearray, log=lambda _message: None) -> int:
        status = self.detect(bytes(data))
        if status.state == "unsupported":
            if status.detail_codes:
                raise ValueError(f"FAIL: {status.detail_codes[0]}")
            raise ValueError("FAIL: model enum anchor not found (version structure may have changed again)")
        if status.state == "patched":
                log("  already patched, no change needed")
                return 0
        edits = self.replay_substates(data, status.substates, "patched")
        for site in status.substates:
            log(f"  OK model enum -> string() @{site.offset}")
        # 后验
        if _locate_clean_sites(bytes(data)):
            raise ValueError("FAIL: unreplaced enum remains after rewrite; refusing to write")
        return edits

    def reverse(self, data: bytearray, log=lambda _message: None) -> int:
        status = self.detect(bytes(data))
        patched = [site for site in status.substates if site.state == "patched"]
        if not patched:
            log("  no patch traces from this tool found")
            return 0
        edits = self.replay_substates(data, patched, "clean")
        for site in patched:
            log(f"  OK reverted model enum @{site.offset}")
        return edits


FEATURE = AgentModelFeature()
register(FEATURE)
