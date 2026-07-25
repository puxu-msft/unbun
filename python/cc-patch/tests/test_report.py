import json
from pathlib import Path

from cc_patch.models import BinaryProbe, CliError, FeatureStatus, WriteOutcome
from cc_patch.report import (
    render_check,
    render_json,
    render_write_outcome,
    render_write_outcomes_json,
)


def make_probes() -> list[BinaryProbe]:
    return [
        BinaryProbe(
            Path("/opt/claude"),
            "2.1.175",
            {
                "source-exec": FeatureStatus(
                    "source-exec", "patched", ["bun fallback: patched (1)"], 1
                ),
                "agent-model": FeatureStatus(
                    "agent-model", "mixed", ["model enum: mixed (2)"], 2
                ),
                "channels": FeatureStatus(
                    "channels",
                    "unsupported",
                    ["decision: unsupported", "permissions: absent"],
                    0,
                ),
            },
            250_085_376,
            True,
        ),
        BinaryProbe(
            Path("/tmp/unreadable"),
            None,
            {},
            0,
            False,
            {"message": "Permission denied"},
        ),
    ]


def test_render_check_includes_binary_feature_matrix_and_details():
    text = render_check(make_probes())

    assert "/opt/claude" in text
    assert "Version  : 2.1.175" in text
    assert "Baseline : yes" in text
    assert "source-exec" in text and "patched" in text
    assert "agent-model" in text and "mixed" in text
    assert "channels" in text and "unsupported" in text
    assert "bun fallback: patched (1)" in text
    assert "permissions: absent" in text
    assert "Permission denied" in text


def test_render_json_matches_status_contract_public_fields():
    probes = make_probes()

    payload = json.loads(render_json(probes))

    assert len(payload) == 2
    assert payload[0]["schema_version"] == 1
    assert payload[0]["path"] == "/opt/claude"
    assert payload[0]["size_bytes"] == 250_085_376
    assert set(payload[0]) == {
        "schema_version",
        "path",
        "version",
        "size_bytes",
        "has_baseline",
        "probe_error",
        "features",
    }
    assert set(payload[0]["features"]["channels"]) == {
        "slug",
        "state",
        "details",
        "sites",
        "substates",
    }
    assert payload[0]["features"]["channels"]["substates"] == []


def test_render_write_outcomes_json_preserves_write_outcome_fields_and_envelope():
    outcome = WriteOutcome(Path("/opt/claude"), ["source-exec", "channels"], 3, True)

    payload = json.loads(
        render_write_outcomes_json(
            action="patch",
            exit_code=0,
            outcomes=[outcome],
            errors=[],
        )
    )

    assert payload["success"] is True
    assert payload["schema_version"] == 1
    assert payload["exit_code"] == 0
    assert payload["action"] == "patch"
    assert payload["results"] == [
        {
            "binary": "/opt/claude",
            "applied": ["source-exec", "channels"],
            "edits": 3,
            "resigned": True,
        }
    ]
    assert set(payload["results"][0]) == set(WriteOutcome.__dataclass_fields__)
    assert payload["errors"] == []


def test_render_write_error_matches_contract_shape():
    error = CliError(
        "target_locked",
        "target lock exists",
        Path("/opt/claude"),
        details={"lock": "/store/write.lock"},
    )

    payload = json.loads(
        render_write_outcomes_json(
            action="patch",
            exit_code=1,
            outcomes=[],
            errors=[error],
        )
    )

    assert payload["errors"] == [
        {
            "schema_version": 1,
            "code": "target_locked",
            "message": "target lock exists",
            "binary": "/opt/claude",
            "feature": None,
            "details": {"lock": "/store/write.lock"},
        }
    ]


def test_render_write_outcome_matches_legacy_summary_density():
    outcome = WriteOutcome(
        Path("/opt/claude"), ["source-exec", "channels"], 3, True
    )

    text = render_write_outcome(outcome)

    assert "Patched -> /opt/claude (3 edit block(s))" in text
    assert "source-exec, channels" in text
    assert "codesign" in text


def test_render_write_outcome_reports_noop_and_clean_revert():
    noop = WriteOutcome(Path("/opt/claude"), [], 0, False)

    assert "Already clean -> /opt/claude (0 edit block(s))" in render_write_outcome(noop)
