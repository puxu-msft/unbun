import mmap

import pytest

from cc_patch.binaries import detect_binaries
from cc_patch.features import agent_model, channels, source_exec
from cc_patch.probe import quick_status


VALID_STATES = {"clean", "patched", "mixed", "unsupported"}


def _window(view: mmap.mmap, feature) -> tuple[int, bytes] | None:
    bounds = feature.probe_window(view)
    if bounds is None:
        return None
    lo, hi = bounds
    return lo, bytes(view[lo:hi])


def _live_anchor_ranges(view: mmap.mmap) -> dict[str, list[tuple[int, int]]] | None:
    source_window = _window(view, source_exec.FEATURE)
    agent_window = _window(view, agent_model.FEATURE)
    channels_window = _window(view, channels.FEATURE)
    if source_window is None or agent_window is None or channels_window is None:
        return None

    source_lo, source_data = source_window
    agent_lo, agent_data = agent_window
    channels_lo, channels_data = channels_window
    ranges = {
        "source-exec": [
            (source_lo + site, source_lo + site + len(source_exec.SOURCE_EXEC_CLEAN_SITE))
            for site in source_exec._locate_sites(source_data)
        ],
        "agent-model": [
            (agent_lo + site, agent_lo + site + len(agent_model.ENUM_CORE))
            for site in (
                agent_model._locate_clean_sites(agent_data)
                + agent_model._locate_patched_sites(agent_data)
            )
        ],
        "channels": [],
    }
    decision_bodies = channels.locate_decision_bodies(channels_data)
    patched_bodies = channels.locate_patched_decision_bodies(channels_data)
    ranges["channels"].extend(
        (channels_lo + start + 1, channels_lo + end)
        for start, end, *_rest in decision_bodies + patched_bodies
    )
    for sites, width in (
        (channels.locate_feature_flag_sites(channels_data), 1),
        (channels.locate_permissions_flag_sites(channels_data), 1),
        (channels.locate_capability_strip_sites(channels_data), 2),
    ):
        ranges["channels"].extend(
            (channels_lo + site, channels_lo + site + width) for site in sites
        )
    if any(not feature_ranges for feature_ranges in ranges.values()):
        return None
    return ranges


def test_live_read_only_probe_does_not_crash():
    binaries = detect_binaries()
    if not binaries:
        pytest.skip("本机未检测到 Claude Code 二进制")

    for binary in binaries:
        with binary.open("rb") as handle:
            with mmap.mmap(handle.fileno(), 0, access=mmap.ACCESS_READ) as view:
                statuses = quick_status(view)
        assert set(statuses) == {"source-exec", "agent-model", "channels"}
        assert set(statuses.values()) <= VALID_STATES


def test_live_feature_anchor_ranges_do_not_overlap():
    binaries = detect_binaries()
    if not binaries:
        pytest.skip("本机未检测到 Claude Code 二进制")

    checked = []
    for binary in binaries:
        with binary.open("rb") as handle:
            with mmap.mmap(handle.fileno(), 0, access=mmap.ACCESS_READ) as view:
                ranges = _live_anchor_ranges(view)
        if ranges is None:
            continue
        checked.append(binary)
        named_ranges = [
            (name, start, end)
            for name, feature_ranges in ranges.items()
            for start, end in feature_ranges
        ]
        for index, (left_name, left_start, left_end) in enumerate(named_ranges):
            for right_name, right_start, right_end in named_ranges[index + 1 :]:
                if left_name == right_name:
                    continue
                assert left_end <= right_start or right_end <= left_start, (
                    binary,
                    left_name,
                    (left_start, left_end),
                    right_name,
                    (right_start, right_end),
                )

    if not checked:
        pytest.skip("本机未检测到同时支持三个 feature 的 Claude Code 二进制")
