import hashlib
import json
from pathlib import Path

import pytest

from cc_patch.lineage import (
    ExactReplayAdapter,
    LineageError,
    load_platform_gate,
    prove_exact_replay,
)


REPO_ROOT = Path(__file__).resolve().parents[3]
CONTRACT_ROOT = REPO_ROOT / "contract"
LINEAGE_CASES = json.loads(
    (CONTRACT_ROOT / "vectors/lineage-v1/fixtures/lineage-cases.json").read_text(encoding="utf-8")
)
LINEAGE_EXPECTED = json.loads(
    (CONTRACT_ROOT / "vectors/lineage-v1/fixtures/lineage-expected.json").read_text(encoding="utf-8")
)


class FixtureAdapter(ExactReplayAdapter):
    def __init__(self, expected: bytes, substates: object, *, complete: bool = True):
        self.expected = expected
        self.substates = substates
        self.complete = complete
        self.observe_calls = 0
        self.replay_calls = 0

    def observe_substates(self, current: bytes) -> object:
        self.observe_calls += 1
        if not self.complete:
            raise LineageError("baseline_stale_build", 2, "incomplete fixture substates")
        return self.substates

    def replay_substates(self, baseline: bytes, substates: object) -> bytes:
        self.replay_calls += 1
        assert substates == self.substates
        return self.expected


def test_platform_gate_reads_all_frozen_platform_records_without_aggregation_shortcut():
    for platform in ("linux", "windows", "macos"):
        gate = load_platform_gate(CONTRACT_ROOT, platform)
        assert gate.lineage_algorithm == "claude-v1-exact-replay"
        assert gate.format in {"elf", "pe", "macho"}
        assert "writes" not in gate.capabilities
        if platform == "linux":
            assert gate.production_write_gate["status"] == "enabled"
            assert gate.production_write_gate["implementation"] == "implemented"
        else:
            assert gate.production_write_gate["status"].startswith("disabled")


def test_platform_gate_rejects_unknown_platform():
    with pytest.raises(LineageError) as raised:
        load_platform_gate(CONTRACT_ROOT, "plan9")
    assert (raised.value.code, raised.value.exit_code) == ("platform_write_unsupported", 1)


def test_exact_replay_fixture_adapter_proves_full_byte_equality_and_lineage_hash():
    baseline = b"clean-fixture-build"
    current = b"patched-fixture-build"
    adapter = FixtureAdapter(current, LINEAGE_CASES["cases"]["mixed_replayable"]["substates"])

    proof = prove_exact_replay(
        baseline,
        current,
        adapter=adapter,
        normalize=lambda data: data,
        baseline_lineage_sha256=hashlib.sha256(baseline).hexdigest(),
    )

    assert proof.accepted is LINEAGE_EXPECTED["mixed_replayable"]["accepted"]
    assert proof.byte_equal is True
    assert proof.baseline_lineage_sha256 == hashlib.sha256(baseline).hexdigest()
    assert proof.current_sha256 == hashlib.sha256(current).hexdigest()
    assert adapter.observe_calls == 1
    assert adapter.replay_calls == 1


def test_exact_replay_rejects_same_version_different_build_even_when_hash_is_spoofed():
    baseline = b"clean-fixture-build"
    current = b"patched-fixture-build-with-non-feature-drift"
    replayed = b"patched-fixture-build-without-that-drift"
    adapter = FixtureAdapter(replayed, {"source-exec": "patched"})

    with pytest.raises(LineageError) as raised:
        prove_exact_replay(
            baseline,
            current,
            adapter=adapter,
            normalize=lambda data: data,
            baseline_lineage_sha256=hashlib.sha256(baseline).hexdigest(),
        )

    assert (raised.value.code, raised.value.exit_code) == (
        LINEAGE_EXPECTED["same_path_version_different_build"]["code"],
        LINEAGE_EXPECTED["same_path_version_different_build"]["exit"],
    )


def test_exact_replay_rejects_incomplete_mixed_fixture():
    baseline = b"clean"
    current = b"mixed"
    case = LINEAGE_CASES["cases"]["mixed_unreplayable"]
    adapter = FixtureAdapter(current, case["substates"], complete=case["complete"])

    with pytest.raises(LineageError) as raised:
        prove_exact_replay(
            baseline,
            current,
            adapter=adapter,
            normalize=lambda data: data,
            baseline_lineage_sha256=hashlib.sha256(baseline).hexdigest(),
        )
    assert (raised.value.code, raised.value.exit_code) == (
        LINEAGE_EXPECTED["mixed_unreplayable"]["code"],
        LINEAGE_EXPECTED["mixed_unreplayable"]["exit"],
    )


def test_exact_replay_rejects_baseline_lineage_manifest_mismatch_before_replay():
    baseline = b"clean"
    adapter = FixtureAdapter(b"clean", {"source-exec": "clean"})

    with pytest.raises(LineageError) as raised:
        prove_exact_replay(
            baseline,
            baseline,
            adapter=adapter,
            normalize=lambda data: data,
            baseline_lineage_sha256="f" * 64,
        )
    assert raised.value.code == "baseline_invalid"
    assert adapter.observe_calls == 0
    assert adapter.replay_calls == 0


def test_normalization_is_applied_to_baseline_expected_and_current():
    baseline = b"clean|signature-original"
    current = b"patched|signature-adhoc"
    expected = b"patched|signature-expected"
    calls: list[bytes] = []

    def normalize(data: bytes) -> bytes:
        calls.append(data)
        return data.split(b"|", 1)[0]

    adapter = FixtureAdapter(expected, {"channels": "patched"})
    proof = prove_exact_replay(
        baseline,
        current,
        adapter=adapter,
        normalize=normalize,
        baseline_lineage_sha256=hashlib.sha256(b"clean").hexdigest(),
    )

    assert proof.byte_equal is True
    assert calls == [baseline, expected, current]


def test_lineage_vectors_are_consumed_without_calling_javascript():
    assert LINEAGE_CASES["algorithm"] == "claude-v1-exact-replay"
    assert set(LINEAGE_CASES["cases"]) == {
        "clean",
        "mixed_replayable",
        "mixed_unreplayable",
        "same_path_version_different_build",
    }
    assert set(LINEAGE_EXPECTED) == {
        "clean",
        "target_sets",
        "mixed_replayable",
        "mixed_unreplayable",
        "same_path_version_different_build",
    }