from cc_patch.features import register
from cc_patch.features.bytes_util import find_all, find_matching_brace
from cc_patch.features.replay import validate_replay
from cc_patch.models import FeatureStatus, FeatureSubstate, ProbeSlice


DECISION_WINDOW = 8_000
PROBE_WINDOW = 8_000
MAX_BLOCK_LOOKBACK = 2_500
MIN_PATCH_SITES = 1

CAPABILITY_MARKER = "claude/channel"
FEATURE_MESSAGE = "channels feature is not currently available"
REGISTER_RETURN = 'return{action:"register"}'
REGISTER_RETURN_BYTES = REGISTER_RETURN.encode("latin-1")
SKIP_RETURN = 'return{action:"skip"'

FEATURE_FLAG_PREFIX = b'tengu_harbor",!'
PERMISSIONS_FLAG_PREFIX = b'tengu_harbor_permissions",!'

BYTE_TRUE = 0x31
BYTE_FALSE = 0x30

CAP_STRIP_ANCHOR = b'["claude/channel"]&&('
CAP_STRIP_TAIL = b")))delete"
CAP_STRIP_WINDOW = 80
PIPE_PAIR = b"||"
AMP_PAIR = b"&&"

DOWNSTREAM_GATES = ('kind:"auth"', 'kind:"allowlist"', 'kind:"provider"')
ESSENTIAL_MISSING_CODE = "channels_essential_site_missing"


def _locate_flag_sites(data: bytes, prefix: bytes) -> list[int]:
    sites = []
    for off in find_all(data, prefix):
        site = off + len(prefix)
        if site < len(data) and data[site] in (BYTE_TRUE, BYTE_FALSE):
            sites.append(site)
    return sites


def locate_feature_flag_sites(data: bytes) -> list[int]:
    """定位 ``tengu_harbor`` 功能开关默认值字节。"""
    return _locate_flag_sites(data, FEATURE_FLAG_PREFIX)


def locate_permissions_flag_sites(data: bytes) -> list[int]:
    """定位 ``tengu_harbor_permissions`` 功能开关默认值字节。"""
    return _locate_flag_sites(data, PERMISSIONS_FLAG_PREFIX)


def locate_capability_strip_sites(data: bytes) -> list[int]:
    """定位能力剥离条件里的 ``||``（改成 ``&&`` 即可让 server: 通道的能力不被剥离）。"""
    sites = []
    alen = len(CAP_STRIP_ANCHOR)
    for off in find_all(data, CAP_STRIP_ANCHOR):
        start = off + alen
        window = data[start : start + CAP_STRIP_WINDOW]
        if CAP_STRIP_TAIL not in window:
            continue
        # 锚点后形如 `!oYH()||!b$q(` —— 找第一个后接 `!` 的 `||`/`&&`
        for j in range(len(window) - 2):
            pair = window[j : j + 2]
            if pair in (PIPE_PAIR, AMP_PAIR) and window[j + 2 : j + 3] == b"!":
                sites.append(start + j)
                break
    return sites


def find_smallest_enclosing_block(
    text: str, marker_pos: int, capability_pos: int, register_pos: int
) -> tuple[int, int] | None:
    """找到同时包住 marker / capability / register 的 **最小** ``{...}`` 块。"""
    start = max(0, capability_pos - MAX_BLOCK_LOOKBACK)
    best: tuple[int, int] | None = None
    for open_idx in range(capability_pos, start - 1, -1):
        if text[open_idx] != "{":
            continue
        close_idx = find_matching_brace(text, open_idx)
        if close_idx is None:
            continue
        if (
            open_idx < capability_pos < close_idx
            and open_idx < marker_pos < close_idx
            and open_idx < register_pos < close_idx
        ):
            if best is None or (close_idx - open_idx) < (best[1] - best[0]):
                best = (open_idx, close_idx)
    return best


def find_capability_check_end(
    text: str, body_start: int, body_end: int, capability_pos: int
) -> int | None:
    """返回 capability 检查块（含其 skip-return 与尾随分号/空白）的结束位置。"""
    if_pos = text.rfind("if(", body_start, capability_pos)
    if if_pos == -1:
        return None

    skip_pos = text.find(SKIP_RETURN, if_pos, body_end)
    if skip_pos == -1:
        return None
    if CAPABILITY_MARKER not in text[if_pos:skip_pos]:
        return None

    object_open = text.find("{", skip_pos, body_end)
    if object_open == -1:
        return None
    object_close = find_matching_brace(text, object_open)
    if object_close is None or object_close >= body_end:
        return None

    end = object_close + 1
    while end < body_end and text[end] in " ;\r\n\t":
        end += 1
    return end


def locate_decision_bodies(data: bytes) -> list[tuple[int, int, int]]:
    """定位所有可塌缩的决策函数体。"""
    text = data.decode("latin-1")
    out: list[tuple[int, int, int]] = []
    seen: set[tuple[int, int]] = set()

    start = 0
    while True:
        marker_pos = text.find(FEATURE_MESSAGE, start)
        if marker_pos == -1:
            break
        start = marker_pos + 1

        window_start = max(0, marker_pos - DECISION_WINDOW)
        window_end = min(len(text), marker_pos + DECISION_WINDOW)

        capability_pos = text.rfind(CAPABILITY_MARKER, window_start, marker_pos)
        if capability_pos == -1:
            continue

        register_pos = text.find(REGISTER_RETURN, marker_pos, window_end)
        if register_pos == -1:
            continue

        bounds = find_smallest_enclosing_block(text, marker_pos, capability_pos, register_pos)
        if bounds is None or bounds in seen:
            continue
        body_start, body_end = bounds

        capability_end = find_capability_check_end(text, body_start, body_end, capability_pos)
        if capability_end is None or capability_end >= register_pos:
            continue

        body = text[body_start + 1 : body_end]
        if (
            CAPABILITY_MARKER not in body
            or FEATURE_MESSAGE not in body
            or REGISTER_RETURN not in body
        ):
            continue

        seen.add(bounds)
        out.append((body_start, body_end, capability_end))
    return out


def locate_patched_decision_bodies(data: bytes) -> list[tuple[int, int]]:
    """定位 **已被塌缩** 的决策函数体。"""
    text = data.decode("latin-1")
    out: list[tuple[int, int]] = []
    seen: set[tuple[int, int]] = set()

    start = 0
    while True:
        capability_pos = text.find(CAPABILITY_MARKER, start)
        if capability_pos == -1:
            break
        start = capability_pos + 1

        window_end = min(len(text), capability_pos + DECISION_WINDOW)
        register_pos = text.find(REGISTER_RETURN, capability_pos, window_end)
        if register_pos == -1:
            continue

        bounds = find_smallest_enclosing_block(text, capability_pos, capability_pos, register_pos)
        if bounds is None or bounds in seen:
            continue
        body_start, body_end = bounds

        body = text[body_start + 1 : body_end]
        if CAPABILITY_MARKER not in body or REGISTER_RETURN not in body:
            continue
        if SKIP_RETURN not in body:
            continue
        if FEATURE_MESSAGE in body or any(g in body for g in DOWNSTREAM_GATES):
            continue

        seen.add(bounds)
        out.append(bounds)
    return out


def apply_decision_rewrite(
    data: bytearray, selected_offsets: set[int] | None = None
) -> int:
    """执行决策函数塌缩。就地修改 data，返回改写的函数体数量。"""
    bodies = locate_decision_bodies(bytes(data))
    if selected_offsets is not None:
        bodies = [body for body in bodies if body[0] + 1 in selected_offsets]
    if not bodies:
        return 0

    text = data.decode("latin-1")
    edits: list[tuple[int, int, str]] = []
    for body_start, body_end, capability_end in bodies:
        preserved = text[body_start + 1 : capability_end]
        replacement = preserved + REGISTER_RETURN
        original_len = body_end - body_start - 1
        if len(replacement) > original_len:
            raise ValueError("decision rewrite would grow the body; refusing to patch")
        replacement = replacement.ljust(original_len, " ")
        edits.append((body_start + 1, body_end, replacement))

    # 从后往前写，避免位移影响前面的偏移。
    for start, end, replacement in reversed(edits):
        data[start:end] = replacement.encode("latin-1")

    verify = data.decode("latin-1")
    for body_start, body_end, _cap in bodies:
        body = verify[body_start + 1 : body_end]
        if (
            CAPABILITY_MARKER not in body
            or REGISTER_RETURN not in body
            or FEATURE_MESSAGE in body
            or any(g in body for g in DOWNSTREAM_GATES)
        ):
            raise ValueError("decision rewrite failed post-verification; refusing to patch")
    return len(bodies)


def _apply_byte_sites(
    data: bytearray,
    sites: list[int],
    expected: int,
    replacement: int,
    desc: str,
    essential: bool,
    log,
) -> int:
    """把一组单字节位点从 expected 改为 replacement；已是目标值则跳过。"""
    if len(sites) < MIN_PATCH_SITES:
        if essential:
            raise ValueError(f"FAIL [{desc}]: anchor not found")
        log(f"  SKIP {desc} (absent in this version)")
        return 0
    edits = 0
    for site in sites:
        actual = data[site]
        if actual == replacement:
            log(f"  OK {desc} @{site} (already target)")
            continue
        if actual != expected:
            raise ValueError(
                f"FAIL [{desc}] @{site}: expected 0x{expected:02x}, got 0x{actual:02x}"
            )
        data[site] = replacement
        edits += 1
        log(f"  OK {desc} @{site}")
    return edits


def apply_capability_strip_patch(data: bytearray, log) -> int:
    """把能力剥离条件的 ``||`` 改成 ``&&``，让 server: 型通道的能力不被剥离。"""
    sites = locate_capability_strip_sites(data)
    edits = 0
    for site in sites:
        cur = bytes(data[site : site + 2])
        if cur == AMP_PAIR:
            log(f"  OK capability-strip neutralize @{site} (already target)")
            continue
        if cur != PIPE_PAIR:
            continue
        data[site : site + 2] = AMP_PAIR
        edits += 1
        log(f"  OK capability-strip neutralize @{site}")
    return edits


def _apply_support_patches(data: bytearray, log) -> int:
    """配套补丁：功能开关（必须）+ 权限开关（尽力）+ 能力剥离（尽力）。"""
    edits = 0
    edits += _apply_byte_sites(
        data,
        locate_feature_flag_sites(data),
        BYTE_TRUE,
        BYTE_FALSE,
        "tengu_harbor default",
        essential=True,
        log=log,
    )
    edits += _apply_byte_sites(
        data,
        locate_permissions_flag_sites(data),
        BYTE_TRUE,
        BYTE_FALSE,
        "tengu_harbor_permissions default",
        essential=False,
        log=log,
    )
    edits += apply_capability_strip_patch(data, log)
    return edits


def _classify_sites(data: bytes, sites: list[int], expected: int, replacement: int) -> str:
    if not sites:
        return "absent"
    values = [data[s] for s in sites]
    if all(v == replacement for v in values):
        return "patched"
    if all(v == expected for v in values):
        return "clean"
    return "mixed"


def _classify_capability_strip(data: bytes, sites: list[int] | None = None) -> tuple[str, str | None]:
    sites = locate_capability_strip_sites(data) if sites is None else sites
    if not sites:
        return "absent", None
    values = [bytes(data[s : s + 2]) for s in sites]
    if all(v == AMP_PAIR for v in values):
        return "patched", f"capability-strip neutralize: patched ({len(sites)})"
    if all(v == PIPE_PAIR for v in values):
        return "clean", f"capability-strip neutralize: clean ({len(sites)})"
    return "mixed", f"capability-strip neutralize: mixed ({len(sites)})"


def _normalize_slices(windows: list[ProbeSlice | bytes]) -> list[ProbeSlice]:
    return [
        window if isinstance(window, ProbeSlice) else ProbeSlice(0, window)
        for window in windows
    ]


def _aggregate_status(substates: list[FeatureSubstate]) -> FeatureStatus:
    decisions = [site for site in substates if site.identity.startswith("channels:decision:")]
    if not decisions:
        return FeatureStatus(
            "channels",
            "unsupported",
            ["channel decision function not found (unsupported version structure)"],
            0,
        )

    details: list[str] = []
    codes: list[str] = []
    effective_states: list[str] = []
    labels = (
        ("decision", "channels:decision:"),
        ("feature flag", "channels:feature-flag:"),
        ("permissions flag", "channels:permissions:"),
        ("capability-strip neutralize", "channels:cap-strip:"),
    )
    for label, prefix in labels:
        sites = [site for site in substates if site.identity.startswith(prefix)]
        present = [site for site in sites if site.state != "absent"]
        if not present:
            essential = any(site.essential for site in sites)
            details.append(f"{label}: {'missing (essential)' if essential else 'absent (optional)'}")
            if essential:
                codes.append(ESSENTIAL_MISSING_CODE)
                effective_states.append("mixed")
            continue
        states = {site.state for site in present}
        state = states.pop() if len(states) == 1 else "mixed"
        details.append(f"{label}: {state} ({len(present)})")
        effective_states.append(state)

    if effective_states and all(state == "patched" for state in effective_states):
        state = "patched"
    elif effective_states and all(state == "clean" for state in effective_states):
        state = "clean"
    else:
        state = "mixed"
    present_count = sum(site.state != "absent" for site in substates)
    return FeatureStatus(
        "channels",
        state,
        details,
        present_count,
        tuple(substates),
        tuple(dict.fromkeys(codes)),
    )


class ChannelsFeature:
    name = "channels"
    title = "Channels"
    description = "Enable plugin: and server: channels, bypassing provider, policy and allowlist gates."
    requires = ["source-exec"]
    reversible = False

    def observe_substates(self, data: bytes, base_offset: int = 0) -> list[FeatureSubstate]:
        grouped: list[tuple[str, list[tuple[int, int, str]], bool]] = []

        decisions: list[tuple[int, int, str]] = []
        decisions.extend(
            (start + 1, end - start - 1, "clean")
            for start, end, _capability_end in locate_decision_bodies(data)
        )
        decisions.extend(
            (start + 1, end - start - 1, "patched")
            for start, end in locate_patched_decision_bodies(data)
        )
        grouped.append(("decision", sorted(set(decisions)), True))

        grouped.append(
            (
                "feature-flag",
                [
                    (
                        site,
                        1,
                        "clean" if data[site] == BYTE_TRUE else "patched",
                    )
                    for site in locate_feature_flag_sites(data)
                ],
                True,
            )
        )
        grouped.append(
            (
                "permissions",
                [
                    (
                        site,
                        1,
                        "clean" if data[site] == BYTE_TRUE else "patched",
                    )
                    for site in locate_permissions_flag_sites(data)
                ],
                False,
            )
        )
        grouped.append(
            (
                "cap-strip",
                [
                    (
                        site,
                        2,
                        "clean"
                        if data[site : site + 2] == PIPE_PAIR
                        else "patched",
                    )
                    for site in locate_capability_strip_sites(data)
                ],
                False,
            )
        )

        substates: list[FeatureSubstate] = []
        for kind, sites, essential in grouped:
            if not sites:
                if kind != "decision":
                    substates.append(
                        FeatureSubstate(
                            f"channels:{kind}:absent",
                            base_offset + len(data),
                            0,
                            "absent",
                            ESSENTIAL_MISSING_CODE if essential else None,
                            essential,
                        )
                    )
                continue
            for index, (offset, length, state) in enumerate(sites):
                substates.append(
                    FeatureSubstate(
                        f"channels:{kind}:{index}",
                        base_offset + offset,
                        length,
                        state,
                        None,
                        essential,
                    )
                )
        return substates

    def detect(self, data: bytes) -> FeatureStatus:
        return _aggregate_status(self.observe_substates(data))

    def probe_windows(self, view: bytes) -> list[tuple[int, int]] | None:
        """为决策体和三个支持锚点各开小窗，避免解码锚点之间的无关字节。"""
        if view.rfind(REGISTER_RETURN_BYTES) == -1:
            return None
        anchors = (
            REGISTER_RETURN_BYTES,
            FEATURE_FLAG_PREFIX,
            PERMISSIONS_FLAG_PREFIX,
            CAP_STRIP_ANCHOR,
        )
        hits = sorted(
            {
                hit
                for anchor in anchors
                for hit in find_all(view, anchor)
            }
        )
        return [
            (max(0, hit - PROBE_WINDOW), min(len(view), hit + PROBE_WINDOW + len(REGISTER_RETURN_BYTES)))
            for hit in hits
        ]

    def probe_window(self, view: bytes) -> tuple[int, int] | None:
        """返回决策体小窗，兼容仅需定位决策锚点的调用方。"""
        windows = self.probe_windows(view)
        if windows is None:
            return None
        for lo, hi in windows:
            window = bytes(view[lo:hi])
            if locate_patched_decision_bodies(window) or locate_decision_bodies(window):
                return lo, hi
        return None

    def detect_windows(self, windows: list[ProbeSlice | bytes]) -> FeatureStatus:
        normalized = _normalize_slices(windows)
        observed_end = max(
            (window.offset + len(window.data) for window in normalized),
            default=0,
        )
        present: dict[tuple[str, int, int], FeatureSubstate] = {}
        for window in normalized:
            for substate in self.observe_substates(window.data, window.offset):
                kind = substate.identity.rsplit(":", 1)[0]
                if substate.state == "absent":
                    continue
                present[(kind, substate.offset, substate.length)] = substate

        substates: list[FeatureSubstate] = []
        kinds = (
            ("channels:decision", True),
            ("channels:feature-flag", True),
            ("channels:permissions", False),
            ("channels:cap-strip", False),
        )
        for kind, essential in kinds:
            sites = sorted(
                (site for (site_kind, _offset, _length), site in present.items() if site_kind == kind),
                key=lambda site: site.offset,
            )
            if not sites:
                if kind != "channels:decision":
                    substates.append(
                        FeatureSubstate(
                            f"{kind}:absent",
                            observed_end,
                            0,
                            "absent",
                            ESSENTIAL_MISSING_CODE if essential else None,
                            essential,
                        )
                    )
                continue
            for index, site in enumerate(sites):
                substates.append(
                    FeatureSubstate(
                        f"{kind}:{index}",
                        site.offset,
                        site.length,
                        site.state,
                        None,
                        essential,
                    )
                )
        return _aggregate_status(substates)

    def replay_substates(
        self,
        data: bytearray,
        substates: list[FeatureSubstate] | tuple[FeatureSubstate, ...],
        target_state: str | None = None,
    ) -> int:
        if target_state not in (None, "clean", "patched"):
            raise ValueError(f"unsupported channels target state: {target_state}")

        current = self.observe_substates(bytes(data))
        desired_substates = [
            FeatureSubstate(
                site.identity,
                site.offset,
                site.length,
                target_state if target_state is not None and site.state != "absent" else site.state,
                site.detail_code,
                site.essential,
            )
            for site in substates
        ]
        replayable_current = [site for site in current if site.state != "absent"]
        replayable_desired = [site for site in desired_substates if site.state != "absent"]
        validate_replay(replayable_current, replayable_desired)
        if len(replayable_desired) != len(desired_substates):
            raise ValueError("substate_unreplayable: unknown state for absent channels site")
        current_by_identity = {site.identity: site for site in current}

        decision_offsets: set[int] = set()
        byte_edits: list[tuple[int, bytes, bytes]] = []
        for site in desired_substates:
            if site.state == "absent":
                continue
            desired = site.state
            actual = current_by_identity[site.identity]
            if site.identity.startswith("channels:decision:"):
                if desired == "clean":
                    if actual.state != "clean":
                        raise ValueError("channels decision body is irreversible")
                else:
                    decision_offsets.add(site.offset)
                continue
            if site.identity.startswith(("channels:feature-flag:", "channels:permissions:")):
                byte_edits.append(
                    (
                        site.offset,
                        bytes([BYTE_TRUE]),
                        bytes([BYTE_TRUE if desired == "clean" else BYTE_FALSE]),
                    )
                )
                continue
            if site.identity.startswith("channels:cap-strip:"):
                byte_edits.append(
                    (
                        site.offset,
                        PIPE_PAIR,
                        PIPE_PAIR if desired == "clean" else AMP_PAIR,
                    )
                )

        edits = apply_decision_rewrite(data, decision_offsets) if decision_offsets else 0
        for offset, clean_value, replacement in byte_edits:
            current_value = bytes(data[offset : offset + len(clean_value)])
            if current_value not in (clean_value, replacement):
                raise ValueError(f"channels site mismatch @{offset}")
            if current_value != replacement:
                data[offset : offset + len(clean_value)] = replacement
                edits += 1
        return edits

    def apply(self, data: bytearray, log=lambda _message: None) -> int:
        """应用 channels 子集补丁（决策改写 + tengu + permissions + cap-strip）。"""
        already = len(locate_patched_decision_bodies(data))
        rewritten = apply_decision_rewrite(data)
        if rewritten == 0 and already == 0:
            raise ValueError("FAIL [decision]: cannot locate channel decision function (version structure may have changed again)")
        return rewritten + _apply_support_patches(data, log)


FEATURE = ChannelsFeature()
register(FEATURE)
