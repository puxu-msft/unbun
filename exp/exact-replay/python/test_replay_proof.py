import copy
import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest


PYTHON_ROOT = Path(__file__).resolve().parent
EXP_ROOT = PYTHON_ROOT.parent
MANIFEST_PATH = EXP_ROOT / "fixtures" / "manifest.json"
PE_MANIFEST_PATH = EXP_ROOT / "fixtures" / "pe" / "manifest.json"
PROOF_PATH = PYTHON_ROOT / "replay_proof.py"


def load_proof_module():
    spec = importlib.util.spec_from_file_location("exact_replay_proof", PROOF_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def proof():
    return load_proof_module()


@pytest.fixture
def manifest():
    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))


def fixture_path(manifest, fixture_name):
    return (MANIFEST_PATH.parent / manifest["fixtures"][fixture_name]["path"]).resolve()


def case_current_path(manifest, case_name, tmp_path):
    scenario = manifest["cases"][case_name]
    if "current_fixture" in scenario:
        return fixture_path(manifest, scenario["current_fixture"])

    current = bytearray(fixture_path(manifest, scenario["base_fixture"]).read_bytes())
    mutation = scenario["mutation"]
    current[mutation["offset"]] = mutation["byte"]
    current_path = tmp_path / f"{case_name}.bin"
    current_path.write_bytes(current)
    return current_path


def run_cli(case_name, current_path, write_expected=None):
    args = [
        sys.executable,
        str(PROOF_PATH),
        "--manifest",
        str(MANIFEST_PATH),
        "--case",
        case_name,
        "--current",
        str(current_path),
    ]
    if write_expected is not None:
        args.extend(["--write-expected", str(write_expected)])
    return subprocess.run(
        args,
        check=False,
        capture_output=True,
        text=True,
    )


@pytest.mark.parametrize("target", json.loads(MANIFEST_PATH.read_text())["target_sets"])
def test_replays_every_target_dependency_closure(proof, manifest, target):
    baseline = fixture_path(manifest, "clean").read_bytes()
    expected = fixture_path(manifest, target["fixture"]).read_bytes()

    replayed = proof.replay_substates(baseline, manifest["cases"][target["fixture"]]["substates"])

    assert replayed == expected


def test_replays_complete_mixed_substates_byte_for_byte(proof, manifest):
    scenario = manifest["cases"]["mixed-replayable"]
    baseline = fixture_path(manifest, "clean").read_bytes()
    expected = fixture_path(manifest, scenario["current_fixture"]).read_bytes()

    assert proof.replay_substates(baseline, scenario["substates"]) == expected


@pytest.mark.parametrize(
    ("case_name", "exit_code"),
    [
        ("clean", 0),
        ("target-source-exec", 0),
        ("target-agent-model", 0),
        ("target-source-exec-agent-model", 0),
        ("target-channels", 0),
        ("target-all", 0),
        ("mixed-replayable", 0),
        ("mixed-unreplayable", 3),
        ("same-version-different-build", 4),
        ("feature-owned-clean-drift", 4),
    ],
)
def test_cli_matches_every_frozen_case(manifest, tmp_path, case_name, exit_code):
    current_path = case_current_path(manifest, case_name, tmp_path)
    completed = run_cli(case_name, current_path)

    assert completed.returncode == exit_code
    assert completed.stdout.count("\n") == 1
    result = json.loads(completed.stdout)
    assert result == {
        "implementation": "python",
        "format": manifest["format"],
        "supported": manifest["cases"][case_name]["expected"]["supported"],
        "normalized_size": manifest["normalized_size"],
        "baseline_lineage_sha256": manifest["baseline"]["sha256"],
        "expected_sha256": manifest["cases"][case_name]["expected"]["expected_sha256"],
        "current_sha256": manifest["cases"][case_name]["current_sha256"],
        "byte_equal": manifest["cases"][case_name]["expected"]["byte_equal"],
        "error": manifest["cases"][case_name]["expected"]["error"],
    }
    if exit_code == 0:
        assert completed.stderr == ""
    else:
        assert completed.stderr.strip()


def test_cli_writes_exact_expected_bytes_without_extra_stdout(manifest, tmp_path):
    expected_path = tmp_path / "expected.bin"
    current_path = fixture_path(manifest, "target-all")

    completed = run_cli("target-all", current_path, expected_path)

    assert completed.returncode == 0
    assert completed.stdout.count("\n") == 1
    assert completed.stderr == ""
    assert expected_path.read_bytes() == current_path.read_bytes()


def test_cli_does_not_write_expected_bytes_for_rejection(manifest, tmp_path):
    expected_path = tmp_path / "expected.bin"
    current_path = fixture_path(manifest, "mixed-unreplayable")

    completed = run_cli("mixed-unreplayable", current_path, expected_path)

    assert completed.returncode == 3
    assert not expected_path.exists()


def test_rejects_missing_replay_site(proof, manifest):
    baseline = fixture_path(manifest, "clean").read_bytes()
    sites = copy.deepcopy(proof.SITE_SPECS)
    del sites["channels"]["decision"]

    with pytest.raises(proof.SubstateUnreplayable, match="missing site: channels.decision"):
        proof.replay_substates(baseline, manifest["cases"]["target-channels"]["substates"], sites)


def test_rejects_out_of_bounds_replay_site(proof, manifest):
    baseline = fixture_path(manifest, "clean").read_bytes()
    sites = copy.deepcopy(proof.SITE_SPECS)
    sites["channels"]["decision"] = proof.ReplaySite(
        offset=len(baseline),
        clean=sites["channels"]["decision"].clean,
        patched=sites["channels"]["decision"].patched,
    )

    with pytest.raises(proof.SubstateUnreplayable, match="site out of bounds: channels.decision"):
        proof.replay_substates(baseline, manifest["cases"]["target-channels"]["substates"], sites)


def test_rejects_unknown_substate(proof, manifest):
    baseline = fixture_path(manifest, "clean").read_bytes()
    substates = copy.deepcopy(manifest["cases"]["mixed-replayable"]["substates"])
    substates["channels"]["permissions"] = "unknown"

    with pytest.raises(proof.SubstateUnreplayable, match="unknown state: channels.permissions"):
        proof.replay_substates(baseline, substates)


def test_rejects_unknown_feature(proof, manifest):
    baseline = fixture_path(manifest, "clean").read_bytes()
    substates = copy.deepcopy(manifest["cases"]["clean"]["substates"])
    substates["unknown-feature"] = "clean"

    with pytest.raises(proof.SubstateUnreplayable, match="unknown feature: unknown-feature"):
        proof.replay_substates(baseline, substates)


def test_rejects_unreplayable_mixed_without_expected_hash(proof, manifest):
    scenario = manifest["cases"]["mixed-unreplayable"]
    baseline = fixture_path(manifest, "clean").read_bytes()

    with pytest.raises(proof.SubstateUnreplayable, match="unknown state: agent-model"):
        proof.replay_substates(baseline, scenario["substates"])


def test_full_byte_compare_is_load_bearing(proof, manifest):
    baseline = fixture_path(manifest, "clean").read_bytes()
    current = fixture_path(manifest, "clean").read_bytes()
    original_replay = proof.replay_substates

    def replay_with_middle_byte_drift(*args, **kwargs):
        replayed = bytearray(original_replay(*args, **kwargs))
        replayed[30] ^= 1
        return bytes(replayed)

    proof.replay_substates = replay_with_middle_byte_drift
    proof.sha256 = lambda _data: manifest["baseline"]["sha256"]
    result, exit_code = proof.evaluate_case(manifest, "clean", current)

    assert baseline[30] == current[30]
    assert exit_code == 4
    assert result["supported"] is True
    assert result["byte_equal"] is False
    assert result["error"] == "baseline_stale_build"
    assert result["expected_sha256"] == result["current_sha256"]


def test_rejects_wrong_normalized_size_before_success(proof, manifest):
    current = fixture_path(manifest, "clean").read_bytes() + b"x"

    result, exit_code = proof.evaluate_case(manifest, "clean", current)

    assert exit_code == 4
    assert result["normalized_size"] == len(current)
    assert result["supported"] is True
    assert result["byte_equal"] is False
    assert result["error"] == "baseline_stale_build"


@pytest.fixture
def pe_manifest():
    return json.loads(PE_MANIFEST_PATH.read_text(encoding="utf-8"))


def pe_fixture_path(pe_manifest, fixture_name):
    return (PE_MANIFEST_PATH.parent / pe_manifest["fixtures"][fixture_name]["path"]).resolve()


def test_pe_identity_normalization_validates_structure_and_preserves_every_byte(proof, pe_manifest):
    clean = pe_fixture_path(pe_manifest, "clean").read_bytes()

    assert proof.normalize_pe(clean) is clean
    assert proof.normalize_pe(clean) == clean


@pytest.mark.parametrize(
    ("name", "mutate"),
    [
        ("DOS magic", lambda data: b"ZZ" + data[2:]),
        ("PE magic", lambda data: data[:0x80] + b"NOPE" + data[0x84:]),
        ("truncated PE header", lambda data: data[:0x90]),
        ("contradictory optional header", lambda data: data[:0x98] + b"\x0b\x01" + data[0x9A:]),
    ],
)
def test_pe_parser_rejects_invalid_headers_before_replay(proof, pe_manifest, name, mutate):
    clean = pe_fixture_path(pe_manifest, "clean").read_bytes()

    with pytest.raises(proof.UnsupportedFormat, match="PE"):
        proof.normalize_pe(mutate(clean))


def test_python_cli_dispatches_valid_pe_manifest(pe_manifest):
    completed = subprocess.run(
        [
            sys.executable,
            str(PROOF_PATH),
            "--manifest",
            str(PE_MANIFEST_PATH),
            "--case",
            "clean",
            "--current",
            str(pe_fixture_path(pe_manifest, "clean")),
        ],
        check=False,
        capture_output=True,
        text=True,
    )

    assert completed.returncode == 0
    assert completed.stderr == ""
    assert json.loads(completed.stdout) == {
        "implementation": "python",
        "format": "pe",
        "supported": True,
        "normalized_size": pe_manifest["normalized_size"],
        "baseline_lineage_sha256": pe_manifest["baseline"]["sha256"],
        "expected_sha256": pe_manifest["cases"]["clean"]["expected"]["expected_sha256"],
        "current_sha256": pe_manifest["cases"]["clean"]["current_sha256"],
        "byte_equal": True,
        "error": None,
    }