import hashlib
import json
import os
from pathlib import Path
import stat

import pytest

from runtime_probe import CLEAN_SHA256, build_variants, run_experiment


CLEAN_BINARY = Path("/home/xp/.local/share/claude/versions/2.1.214")


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_build_variants_are_equal_length_and_do_not_modify_original(tmp_path):
    before = sha256(CLEAN_BINARY)

    variants = build_variants(CLEAN_BINARY, tmp_path)

    assert before == CLEAN_SHA256
    assert sha256(CLEAN_BINARY) == before
    assert set(variants) == {"clean", "agent-model", "agent-model-source"}
    assert all(path.stat().st_size == CLEAN_BINARY.stat().st_size for path in variants.values())
    assert all(path.stat().st_mode & stat.S_IXUSR for path in variants.values())

    clean = variants["clean"].read_bytes()
    agent = variants["agent-model"].read_bytes()
    source = variants["agent-model-source"].read_bytes()
    assert clean.count(b"// @bun @bytecode") == 5
    assert agent.count(b"// @bun @bytecode") == 5
    assert agent.count(b"// @bun @source__") == 0
    assert source.count(b"// @bun @bytecode") == 0
    assert source.count(b"// @bun @source__") == 5
    assert clean != agent
    assert agent != source


@pytest.mark.skipif(os.environ.get("RUN_CLAUDE_RUNTIME_PROBE") != "1", reason="explicit real-binary probe")
def test_runtime_oracle_records_decisive_wire_evidence(tmp_path):
    output = tmp_path / "result.json"

    result = run_experiment(CLEAN_BINARY, output, timeout_seconds=30)

    assert output.exists()
    assert json.loads(output.read_text()) == result
    assert result["original"]["sha256_before"] == CLEAN_SHA256
    assert result["original"]["sha256_after"] == CLEAN_SHA256
    assert result["mock"]["host"] == "127.0.0.1"
    assert 0 < result["mock"]["port"] < 65536
    assert result["verdict"] in {"proven", "refuted"}
    assert set(result["variants"]) == {"clean", "agent-model", "agent-model-source"}
    for variant in result["variants"].values():
        assert "requests" in variant
        assert "client" in variant
        assert variant["agent_tool_advertised"] is True
        assert variant["agent_schema"] is not None
        assert variant["tool_use_sent"] is True
        assert variant["tool_use_received_by_client"] is True
        assert variant["client"]["timed_out"] is False
    clean = result["variants"]["clean"]
    agent = result["variants"]["agent-model"]
    source = result["variants"]["agent-model-source"]
    assert clean["agent_schema"]["properties"]["model"]["enum"] == ["sonnet", "opus", "haiku", "fable"]
    assert "InputValidationError" in clean["client"]["stdout"]
    assert "gpt-5.5" in clean["client"]["stdout"]
    assert clean["subagent_request_observed"] is False
    assert clean["binary_state"] == {
        "bytecode_markers": 5,
        "source_markers": 0,
        "clean_agent_model_sites": 1,
        "patched_agent_model_sites": 0,
    }
    assert agent["agent_schema"]["properties"]["model"] == {
        "description": clean["agent_schema"]["properties"]["model"]["description"],
        "type": "string",
    }
    assert agent["subagent_request_observed"] is True
    assert agent["subagent_requests"][0]["body"]["model"] == "gpt-5.5"
    assert agent["binary_state"]["bytecode_markers"] == 5
    assert agent["binary_state"]["source_markers"] == 0
    assert source["subagent_request_observed"] is True
    assert source["subagent_requests"][0]["body"]["model"] == "gpt-5.5"
    assert source["binary_state"]["bytecode_markers"] == 0
    assert source["binary_state"]["source_markers"] == 5
