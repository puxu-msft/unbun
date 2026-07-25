from pathlib import Path

import pytest

from cc_patch import features
from cc_patch.features import channels
from tests.conftest import DECISION_JS, make_bundle


GOLDEN_DIR = Path(__file__).with_name("golden")
CLEAN_GOLDEN = GOLDEN_DIR / "synthetic-2.1.175-clean.bin"
ALL_PATCHED_GOLDEN = GOLDEN_DIR / "synthetic-2.1.175-all-patched.bin"


def test_registered_as_irreversible_source_exec_dependent_feature():
    feature = features.REGISTRY["channels"]
    assert feature is channels.FEATURE
    assert feature.requires == ["source-exec"]
    assert feature.reversible is False
    assert not hasattr(feature, "reverse")
    assert not any(name.startswith(("reverse", "revert")) for name in dir(channels))


def test_apply_matches_frozen_golden_channels_regions():
    clean = CLEAN_GOLDEN.read_bytes()
    expected = ALL_PATCHED_GOLDEN.read_bytes()
    actual = bytearray(clean)

    assert channels.FEATURE.apply(actual) == 4
    ranges = []
    ranges.extend(
        (start + 1, end) for start, end, _capability_end in channels.locate_decision_bodies(clean)
    )
    for sites, width in (
        (channels.locate_feature_flag_sites(clean), 1),
        (channels.locate_permissions_flag_sites(clean), 1),
        (channels.locate_capability_strip_sites(clean), 2),
    ):
        ranges.extend((site, site + width) for site in sites)
    assert len(ranges) == 4
    for start, end in ranges:
        assert actual[start:end] == expected[start:end]


def test_locator_functions_find_expected_sites():
    data = bytes(make_bundle())
    bodies = channels.locate_decision_bodies(data)

    assert len(channels.locate_feature_flag_sites(data)) == 1
    assert len(channels.locate_permissions_flag_sites(data)) == 1
    assert len(channels.locate_capability_strip_sites(data)) == 1
    assert len(bodies) == 1
    body_start, body_end, capability_end = bodies[0]
    assert body_start < capability_end < body_end
    text = data.decode("latin-1")
    marker = text.index(channels.FEATURE_MESSAGE)
    cap = text.rfind(channels.CAPABILITY_MARKER, 0, marker)
    reg = text.index(channels.REGISTER_RETURN, marker)
    assert channels.find_smallest_enclosing_block(text, marker, cap, reg) == (body_start, body_end)
    assert channels.find_capability_check_end(text, body_start, body_end, cap) == capability_end


def test_locate_patched_body_requires_skip_return_guard():
    data = make_bundle()
    channels.FEATURE.apply(data)
    assert len(channels.locate_patched_decision_bodies(bytes(data))) == 1

    broken = bytes(data).replace(b'return{action:"skip"', b'return{action:"stop"', 1)
    assert channels.locate_patched_decision_bodies(broken) == []
    assert channels.FEATURE.detect(broken).state == "unsupported"


def test_site_classifiers_cover_clean_patched_and_mixed():
    clean = b"a1b1"
    patched = b"a0b0"
    mixed = b"a1b0"
    sites = [1, 3]

    assert channels._classify_sites(clean, sites, channels.BYTE_TRUE, channels.BYTE_FALSE) == "clean"
    assert channels._classify_sites(patched, sites, channels.BYTE_TRUE, channels.BYTE_FALSE) == "patched"
    assert channels._classify_sites(mixed, sites, channels.BYTE_TRUE, channels.BYTE_FALSE) == "mixed"

    clean_strip = b"x||x||"
    patched_strip = b"x&&x&&"
    mixed_strip = b"x||x&&"
    assert channels._classify_capability_strip(clean_strip, [1, 4])[0] == "clean"
    assert channels._classify_capability_strip(patched_strip, [1, 4])[0] == "patched"
    assert channels._classify_capability_strip(mixed_strip, [1, 4])[0] == "mixed"


def test_detect_clean_patched_mixed_and_unsupported_with_details():
    clean = bytes(make_bundle())
    patched = make_bundle()
    channels.FEATURE.apply(patched)
    mixed = bytearray(patched)
    mixed[channels.locate_feature_flag_sites(mixed)[0]] = channels.BYTE_TRUE

    clean_status = channels.FEATURE.detect(clean)
    patched_status = channels.FEATURE.detect(bytes(patched))
    mixed_status = channels.FEATURE.detect(bytes(mixed))

    assert clean_status.state == "clean"
    assert patched_status.state == "patched"
    assert mixed_status.state == "mixed"
    assert channels.FEATURE.detect(b"no channel decision").state == "unsupported"
    details = "\n".join(patched_status.details)
    for label in ("decision", "feature flag", "permissions flag", "capability-strip"):
        assert label in details


def test_apply_is_length_preserving_collapses_gates_and_flips_support_sites():
    data = make_bundle()
    original_len = len(data)

    edits = channels.FEATURE.apply(data)
    text = data.decode("latin-1")

    assert edits == 4
    assert len(data) == original_len
    assert 'kind:"provider"' not in text
    assert 'kind:"allowlist"' not in text
    assert channels.FEATURE_MESSAGE not in text
    assert channels.CAPABILITY_MARKER in text
    assert channels.REGISTER_RETURN in text
    assert all(data[site] == channels.BYTE_FALSE for site in channels.locate_feature_flag_sites(data))
    assert all(data[site] == channels.BYTE_FALSE for site in channels.locate_permissions_flag_sites(data))
    assert "(!oYH()&&!b$q(" in text
    assert 'delete i6["claude/channel"]' in text
    assert "// @bun @bytecode" in text
    assert channels.FEATURE.detect(bytes(data)).state == "patched"


def test_apply_is_idempotent():
    data = make_bundle()
    channels.FEATURE.apply(data)
    snapshot = bytes(data)

    assert channels.FEATURE.apply(data) == 0
    assert bytes(data) == snapshot


def test_apply_unsupported_raises():
    with pytest.raises(ValueError, match="decision"):
        channels.FEATURE.apply(bytearray(b"nothing to patch"))


def test_apply_rejects_missing_essential_feature_flag():
    data = make_bundle()
    data = bytearray(bytes(data).replace(channels.FEATURE_FLAG_PREFIX, b"other_feature!!", 1))

    with pytest.raises(ValueError, match="tengu_harbor default"):
        channels.FEATURE.apply(data)


def test_probe_window_clean_and_patched():
    clean = bytes(make_bundle())
    patched = make_bundle()
    channels.FEATURE.apply(patched)

    for data, expected in ((clean, "clean"), (bytes(patched), "patched")):
        padded = b"x" * 20_000 + data + b"y" * 20_000
        bounds = channels.FEATURE.probe_window(padded)
        assert bounds is not None
        lo, hi = bounds
        assert channels.FEATURE.detect(padded[lo:hi]).state == expected


def test_probe_window_ignores_head_decoy_register():
    decoy = channels.REGISTER_RETURN_BYTES
    gap = b"x" * (channels.DECISION_WINDOW * 2)
    data = decoy + gap + bytes(make_bundle())

    lo, hi = channels.FEATURE.probe_window(data)
    assert channels.FEATURE.detect(data[lo:hi]).state == "clean"


def test_probe_window_skips_one_or_multiple_trailing_decoys():
    decoy = channels.REGISTER_RETURN_BYTES
    gap = b"x" * (channels.DECISION_WINDOW * 2)
    for suffix in (gap + decoy, gap + decoy + gap + decoy + gap + decoy):
        data = bytes(make_bundle()) + suffix
        lo, hi = channels.FEATURE.probe_window(data)
        assert channels.FEATURE.detect(data[lo:hi]).state == "clean"


def test_probe_window_returns_none_without_register():
    assert channels.FEATURE.probe_window(b"no decision function") is None
