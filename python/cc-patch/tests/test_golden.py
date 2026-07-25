from pathlib import Path

from cc_patch import features
from cc_patch.features import agent_model, channels, source_exec
from tests.conftest import make_bundle


GOLDEN_DIR = Path(__file__).with_name("golden")
GOLDEN_VERSION = "2.1.175"
CLEAN_GOLDEN = GOLDEN_DIR / f"synthetic-{GOLDEN_VERSION}-clean.bin"
ALL_PATCHED_GOLDEN = GOLDEN_DIR / f"synthetic-{GOLDEN_VERSION}-all-patched.bin"


def test_cross_feature_apply_matches_frozen_golden_bytes():
    clean = CLEAN_GOLDEN.read_bytes()
    expected = ALL_PATCHED_GOLDEN.read_bytes()
    assert clean == bytes(make_bundle())

    actual = bytearray(clean)
    for feature in features.REGISTRY.values():
        feature.apply(actual)

    assert bytes(actual) == expected
    assert [feature.detect(bytes(actual)).state for feature in features.REGISTRY.values()] == [
        "patched",
        "patched",
        "patched",
    ]


def test_feature_anchor_ranges_do_not_overlap_on_synthetic_bundle():
    data = bytes(make_bundle())
    ranges = {
        "source-exec": [
            (site, site + len(source_exec.BUN_BYTECODE_MARKER))
            for site in source_exec._locate_sites(data)
        ],
        "agent-model": [
            (site, site + len(agent_model.ENUM_CORE))
            for site in agent_model._locate_clean_sites(data)
        ],
        "channels": [],
    }
    for start, end, _capability_end in channels.locate_decision_bodies(data):
        ranges["channels"].append((start + 1, end))
    for sites, width in (
        (channels.locate_feature_flag_sites(data), 1),
        (channels.locate_permissions_flag_sites(data), 1),
        (channels.locate_capability_strip_sites(data), 2),
    ):
        ranges["channels"].extend((site, site + width) for site in sites)

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
                left_name,
                (left_start, left_end),
                right_name,
                (right_start, right_end),
            )


def test_reversible_features_rebuild_frozen_clean_golden():
    clean = CLEAN_GOLDEN.read_bytes()
    for feature in (source_exec.FEATURE, agent_model.FEATURE):
        data = bytearray(clean)
        feature.apply(data)
        patched = bytes(data)
        feature.reverse(data)
        assert bytes(data) == clean
        feature.apply(data)
        assert bytes(data) == patched

    assert channels.FEATURE.reversible is False
    assert not hasattr(channels.FEATURE, "reverse")
