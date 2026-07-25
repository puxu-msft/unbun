from pathlib import Path

from cc_patch import features
from cc_patch.features import source_exec
from tests.conftest import make_bundle


GOLDEN_DIR = Path(__file__).with_name("golden")
CLEAN_GOLDEN = GOLDEN_DIR / "synthetic-2.1.175-clean.bin"
ALL_PATCHED_GOLDEN = GOLDEN_DIR / "synthetic-2.1.175-all-patched.bin"


def test_registered_with_expected_metadata():
    feature = features.REGISTRY["source-exec"]
    assert feature is source_exec.FEATURE
    assert feature.requires == []
    assert feature.reversible is True


def test_apply_matches_frozen_golden_source_exec_region():
    clean = CLEAN_GOLDEN.read_bytes()
    expected = ALL_PATCHED_GOLDEN.read_bytes()
    actual = bytearray(clean)

    assert source_exec.FEATURE.apply(actual) == 1
    sites = source_exec._locate_sites(clean)
    assert len(sites) == 1
    site = sites[0]
    width = len(source_exec.BUN_BYTECODE_MARKER)
    assert actual[site : site + width] == expected[site : site + width]


def test_detect_clean_patched_and_unsupported():
    clean = bytes(make_bundle())
    patched = bytearray(clean)
    source_exec.FEATURE.apply(patched)

    assert source_exec.FEATURE.detect(clean).state == "clean"
    assert source_exec.FEATURE.detect(bytes(patched)).state == "patched"
    assert source_exec.FEATURE.detect(b"no bun marker").state == "unsupported"


def test_detect_mixed_markers():
    data = b"// @bun @bytecode one // @bun @source__ two"

    status = source_exec.FEATURE.detect(data)

    assert status.state == "mixed"
    assert status.sites == 2


def test_reverse_apply_round_trip():
    original = bytes(make_bundle())
    data = bytearray(original)

    assert source_exec.FEATURE.apply(data) == 1
    assert source_exec.FEATURE.reverse(data) == 1

    assert bytes(data) == original


def test_apply_is_idempotent():
    data = make_bundle()
    source_exec.FEATURE.apply(data)
    snapshot = bytes(data)

    assert source_exec.FEATURE.apply(data) == 0
    assert bytes(data) == snapshot


def test_probe_window_contains_marker_without_exceeding_view():
    marker = b"// @bun @bytecode"
    data = b"x" * 20_000 + marker + b"y" * 20_000

    bounds = source_exec.FEATURE.probe_window(data)

    assert bounds is not None
    lo, hi = bounds
    hit = data.index(marker)
    assert 0 <= lo <= hit
    assert hit + len(marker) <= hi <= len(data)
    assert len(data) > hi - lo


def test_probe_window_returns_none_without_marker():
    assert source_exec.FEATURE.probe_window(b"x" * 40_000) is None
