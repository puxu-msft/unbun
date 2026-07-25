from pathlib import Path

from cc_patch import features
from cc_patch.features import agent_model
from tests.conftest import make_bundle


GOLDEN_DIR = Path(__file__).with_name("golden")
CLEAN_GOLDEN = GOLDEN_DIR / "synthetic-2.1.175-clean.bin"
ALL_PATCHED_GOLDEN = GOLDEN_DIR / "synthetic-2.1.175-all-patched.bin"


def test_registered_with_expected_metadata():
    feature = features.REGISTRY["agent-model"]
    assert feature is agent_model.FEATURE
    assert feature.requires == []
    assert feature.reversible is True


def test_replacement_bytes_are_exact_and_length_preserving():
    # 替换串**不含**易变的 minified 变量前缀（旧实现写死 `E.`），只替换 enum(...) 段本身。
    expected = b"string()/* any model ................*/"
    assert agent_model.REPLACE_CORE == expected
    assert agent_model.build_replacement() == expected
    assert len(agent_model.REPLACE_CORE) == len(agent_model.ENUM_CORE)


def test_apply_matches_frozen_golden_agent_region():
    clean = CLEAN_GOLDEN.read_bytes()
    expected = ALL_PATCHED_GOLDEN.read_bytes()
    actual = bytearray(clean)

    assert agent_model.FEATURE.apply(actual) == 1
    sites = agent_model._locate_patched_sites(expected)
    assert len(sites) == 1
    site = sites[0]
    assert actual[site : site + len(agent_model.REPLACE_CORE)] == expected[
        site : site + len(agent_model.REPLACE_CORE)
    ]


def test_detect_clean_patched_unsupported_and_mixed():
    clean = bytes(make_bundle())
    patched = bytearray(clean)
    agent_model.FEATURE.apply(patched)
    mixed = clean + bytes(patched)

    assert agent_model.FEATURE.detect(clean).state == "clean"
    assert agent_model.FEATURE.detect(bytes(patched)).state == "patched"
    assert agent_model.FEATURE.detect(b"no model enum").state == "unsupported"
    assert agent_model.FEATURE.detect(mixed).state == "mixed"


def test_reverse_apply_round_trip():
    original = bytes(make_bundle())
    data = bytearray(original)

    assert agent_model.FEATURE.apply(data) == 1
    assert agent_model.FEATURE.reverse(data) == 1

    assert bytes(data) == original


def test_apply_is_idempotent():
    data = make_bundle()
    agent_model.FEATURE.apply(data)
    snapshot = bytes(data)

    assert agent_model.FEATURE.apply(data) == 0
    assert bytes(data) == snapshot


def assert_window_contains(data: bytes, anchor: bytes) -> None:
    bounds = agent_model.FEATURE.probe_window(data)
    assert bounds is not None
    lo, hi = bounds
    hit = data.index(anchor)
    assert 0 <= lo <= hit
    assert hit + len(anchor) <= hi <= len(data)


def test_probe_window_finds_clean_anchor():
    data = b"x" * 20_000 + bytes(make_bundle()) + b"y" * 20_000
    assert_window_contains(data, agent_model.ENUM_ANCHOR)


def test_probe_window_finds_patched_anchor():
    patched = make_bundle()
    agent_model.FEATURE.apply(patched)
    data = b"x" * 20_000 + bytes(patched) + b"y" * 20_000
    assert_window_contains(data, agent_model.PATCHED_ANCHOR)


def test_probe_window_returns_none_when_both_shapes_absent():
    assert agent_model.FEATURE.probe_window(b"x" * 40_000) is None


def test_probe_window_skips_trailing_decoy_and_finds_real_anchor():
    # describe 后缀若前面不是合法 core（既非 enum 原串也非 string 替换串），该窗判为
    # unsupported，probe_windows 应向前回退到真正可判定的锚点，而非停在诱饵上。
    decoy = b"g" * 64 + agent_model.DESCRIBE_SUFFIX
    real = bytes(make_bundle())
    gap = b"x" * (agent_model.PROBE_WINDOW * 2)
    data = real + gap + decoy

    bounds = agent_model.FEATURE.probe_window(data)

    assert bounds is not None
    lo, hi = bounds
    window = data[lo:hi]
    assert agent_model.FEATURE.detect(window).state == "clean"
    assert b"agentTool={" in window
