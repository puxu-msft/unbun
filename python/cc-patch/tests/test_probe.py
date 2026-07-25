from pathlib import Path

from cc_patch import cli, features, probe
from tests.conftest import make_bundle


VERSION_BYTES = b'X={URL:"https://code.claude.com/docs/en/overview",VERSION:"2.1.175"};'


def test_extracts_from_bundle():
    assert probe.extract_version(VERSION_BYTES) == "2.1.175"


def test_returns_none_when_absent():
    assert probe.extract_version(b"no version anchor here") is None


def test_returns_none_on_non_numeric_value():
    assert probe.extract_version(b'overview",VERSION:"abc"') is None


def test_returns_none_on_truncated_trailing_dot():
    assert probe.extract_version(b'overview",VERSION:"2.1."') is None
    assert probe.extract_version(b'overview",VERSION:"..."') is None


def test_returns_none_when_unterminated():
    data = b'overview",VERSION:"2.1.175' + b"0" * 40
    assert probe.extract_version(data) is None


def test_takes_last_occurrence():
    data = b'overview",VERSION:"2.1.83" ... overview",VERSION:"9.9.9"'
    assert probe.extract_version(data) == "9.9.9"


def test_quick_status_matches_full_detect_for_clean_and_patched_bundles():
    clean = bytes(make_bundle())
    patched = make_bundle()
    for feature in features.REGISTRY.values():
        feature.apply(patched)

    for data in (clean, bytes(patched)):
        quick = probe.quick_status(data)
        assert set(quick) == set(features.REGISTRY)
        for name, feature in features.REGISTRY.items():
            assert quick[name] == feature.detect(data).state


def test_quick_status_reports_unsupported_when_feature_window_is_absent():
    assert probe.quick_status(VERSION_BYTES) == {
        name: "unsupported" for name in features.REGISTRY
    }


def _spread_channels_sub_anchors(gap: int) -> bytes:
    compact = bytes(make_bundle())
    separators = (
        b"function oYH",
        b"function hV4",
        b'if(i6["claude/channel"]',
        b"function x7$",
    )
    chunks: list[bytes] = []
    start = 0
    for separator in separators:
        offset = compact.index(separator, start)
        chunks.extend((compact[start:offset], b"x" * gap))
        start = offset
    chunks.append(compact[start:])
    return b"".join(chunks)


def test_quick_status_channels_covers_sub_anchors_far_from_decision_body():
    distant = _spread_channels_sub_anchors(20_000)

    assert features.REGISTRY["channels"].detect(distant).state == "clean"
    assert probe.quick_status(distant)["channels"] == "clean"


def test_quick_status_channels_covers_sub_anchors_seven_megabytes_apart():
    distant = _spread_channels_sub_anchors(7_000_000)
    full = features.REGISTRY["channels"].detect(distant)

    assert probe.detect_features(distant)["channels"] == full
    windows = features.REGISTRY["channels"].probe_windows(distant)
    assert windows is not None
    assert sum(hi - lo for lo, hi in windows) <= 80_000


def test_probe_binary_windowed_status_matches_full_detect(make_bundle, tmp_path):
    clean = bytes(make_bundle())
    patched = make_bundle()
    for feature in features.REGISTRY.values():
        feature.apply(patched)

    for index, data in enumerate((clean, bytes(patched))):
        binary = tmp_path / f"claude-{index}"
        binary.write_bytes(data)
        result = cli.probe_binary(binary)

        assert result.features == {
            name: feature.detect(data) for name, feature in features.REGISTRY.items()
        }


def test_profile_scan_times_real_files_and_returns_rows(tmp_path):
    first = tmp_path / "claude1"
    second = tmp_path / "claude2"
    first.write_bytes(bytes(make_bundle()))
    second.write_bytes(bytes(make_bundle()))
    output = []

    rows = probe.profile_scan([first, second], out=output.append)

    assert len(rows) == 2
    for path, version_ms, status_ms, total_ms in rows:
        assert path in (first, second)
        assert version_ms >= 0.0
        assert status_ms >= 0.0
        assert total_ms >= 0.0
    text = "\n".join(output)
    assert "PROFILE" in text
    assert "source-exec=clean" in text
    assert "agent-model=clean" in text
    assert "channels=clean" in text
    assert "Total" in text


def test_profile_scan_skips_unreadable_binary_without_failing():
    output = []
    rows = probe.profile_scan([Path("/nonexistent/claude")], out=output.append)
    assert rows == []
    assert "unreadable" in "\n".join(output)
