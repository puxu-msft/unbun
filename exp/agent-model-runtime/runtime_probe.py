#!/usr/bin/env python3
import argparse
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import mmap
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import time
from typing import Any
from urllib.parse import urlsplit


CLEAN_BINARY = Path("/home/xp/.local/share/claude/versions/2.1.214")
CLEAN_SHA256 = "3c029136f7c81f54ed4a38e9d52e655aad536433dbbde50519c8c31bb646ad14"
ENUM_CORE = b'enum(["sonnet","opus","haiku","fable"])'
REPLACE_CORE = b"string()/* any model ................*/"
DESCRIBE_SUFFIX = b".optional().describe(`Optional model override for this agent"
BYTECODE_MARKER = b"// @bun @bytecode"
SOURCE_MARKER = b"// @bun @source__"
TARGET_MODEL = "gpt-5.5"
AGENT_INPUT = {
    "description": "probe",
    "prompt": "return probe result",
    "subagent_type": "general-purpose",
    "model": TARGET_MODEL,
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def find_all(view: mmap.mmap, needle: bytes) -> list[int]:
    offsets: list[int] = []
    start = 0
    while (offset := view.find(needle, start)) != -1:
        offsets.append(offset)
        start = offset + 1
    return offsets


def patch_agent_model(path: Path) -> list[int]:
    with path.open("r+b") as handle, mmap.mmap(handle.fileno(), 0) as view:
        suffixes = find_all(view, DESCRIBE_SUFFIX)
        sites = [offset - len(ENUM_CORE) for offset in suffixes if offset >= len(ENUM_CORE) and view[offset - len(ENUM_CORE) : offset] == ENUM_CORE]
        if len(sites) != 1:
            raise RuntimeError(f"expected one clean agent-model site, found {sites}")
        for site in sites:
            view[site : site + len(ENUM_CORE)] = REPLACE_CORE
        view.flush()
        if any(view[site : site + len(REPLACE_CORE)] != REPLACE_CORE for site in sites):
            raise RuntimeError("agent-model postcondition failed")
        return sites


def patch_source_markers(path: Path) -> list[int]:
    with path.open("r+b") as handle, mmap.mmap(handle.fileno(), 0) as view:
        sites = find_all(view, BYTECODE_MARKER)
        if len(sites) != 5:
            raise RuntimeError(f"expected five bytecode markers, found {sites}")
        for site in sites:
            view[site : site + len(BYTECODE_MARKER)] = SOURCE_MARKER
        view.flush()
        if view.find(BYTECODE_MARKER) != -1 or len(find_all(view, SOURCE_MARKER)) != 5:
            raise RuntimeError("source marker postcondition failed")
        return sites


def build_variants(original: Path, destination: Path) -> dict[str, Path]:
    if sha256(original) != CLEAN_SHA256:
        raise RuntimeError(f"clean binary hash mismatch: {sha256(original)}")
    destination.mkdir(parents=True, exist_ok=True)
    variants = {
        "clean": destination / "claude-clean",
        "agent-model": destination / "claude-agent-model",
        "agent-model-source": destination / "claude-agent-model-source",
    }
    for path in variants.values():
        shutil.copy2(original, path)
    patch_agent_model(variants["agent-model"])
    patch_agent_model(variants["agent-model-source"])
    patch_source_markers(variants["agent-model-source"])
    if any(path.stat().st_size != original.stat().st_size for path in variants.values()):
        raise RuntimeError("variant size changed")
    if sha256(original) != CLEAN_SHA256:
        raise RuntimeError("original changed while building variants")
    return variants


def inspect_variant(path: Path) -> dict[str, int]:
    with path.open("rb") as handle, mmap.mmap(handle.fileno(), 0, access=mmap.ACCESS_READ) as view:
        suffixes = find_all(view, DESCRIBE_SUFFIX)
        return {
            "bytecode_markers": len(find_all(view, BYTECODE_MARKER)),
            "source_markers": len(find_all(view, SOURCE_MARKER)),
            "clean_agent_model_sites": sum(offset >= len(ENUM_CORE) and view[offset - len(ENUM_CORE) : offset] == ENUM_CORE for offset in suffixes),
            "patched_agent_model_sites": sum(offset >= len(REPLACE_CORE) and view[offset - len(REPLACE_CORE) : offset] == REPLACE_CORE for offset in suffixes),
        }


def message_start(message_id: str) -> dict[str, Any]:
    return {
        "type": "message_start",
        "message": {
            "id": message_id,
            "type": "message",
            "role": "assistant",
            "model": "claude-sonnet-4-5",
            "content": [],
            "stop_reason": None,
            "stop_sequence": None,
            "usage": {"input_tokens": 1, "output_tokens": 1},
        },
    }


def tool_use_events() -> list[dict[str, Any]]:
    return [
        message_start("msg_agent_probe"),
        {"type": "content_block_start", "index": 0, "content_block": {"type": "tool_use", "id": "toolu_agent_probe", "name": "Agent", "input": {}}},
        {"type": "content_block_delta", "index": 0, "delta": {"type": "input_json_delta", "partial_json": json.dumps(AGENT_INPUT, separators=(",", ":"))}},
        {"type": "content_block_stop", "index": 0},
        {"type": "message_delta", "delta": {"stop_reason": "tool_use", "stop_sequence": None}, "usage": {"output_tokens": 10}},
        {"type": "message_stop"},
    ]


def end_turn_events(request_number: int) -> list[dict[str, Any]]:
    text = f"probe complete request={request_number}"
    return [
        message_start(f"msg_end_{request_number}"),
        {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
        {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": text}},
        {"type": "content_block_stop", "index": 0},
        {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": None}, "usage": {"output_tokens": 5}},
        {"type": "message_stop"},
    ]


def encode_sse(events: list[dict[str, Any]]) -> bytes:
    return b"".join(f"event: {event['type']}\ndata: {json.dumps(event, separators=(',', ':'))}\n\n".encode() for event in events)


class MockState:
    def __init__(self) -> None:
        self.active_variant = ""
        self.requests: dict[str, list[dict[str, Any]]] = {}
        self.lock = threading.Lock()

    def activate(self, variant: str) -> None:
        with self.lock:
            self.active_variant = variant
            self.requests[variant] = []

    def record(self, path: str, headers: dict[str, str], body: Any) -> tuple[str, int]:
        with self.lock:
            variant = self.active_variant
            records = self.requests[variant]
            number = 1 + sum(1 for record in records if urlsplit(record["path"]).path.endswith("/messages"))
            records.append({"path": path, "headers": headers, "body": body})
            return variant, number


class MockHandler(BaseHTTPRequestHandler):
    server_version = "AgentModelRuntimeMock/1"
    protocol_version = "HTTP/1.1"

    @property
    def state(self) -> MockState:
        return self.server.state  # type: ignore[attr-defined]

    def log_message(self, _format: str, *_args: Any) -> None:
        return

    def do_POST(self) -> None:
        length = int(self.headers.get("content-length", "0"))
        raw = self.rfile.read(length)
        try:
            body = json.loads(raw)
        except json.JSONDecodeError:
            body = {"_invalid_json": raw.decode(errors="replace")}
        headers = {key.lower(): ("<redacted>" if key.lower() in {"x-api-key", "authorization"} else value) for key, value in self.headers.items()}
        _variant, number = self.state.record(self.path, headers, body)
        request_path = urlsplit(self.path).path
        if request_path.endswith("/messages/count_tokens"):
            payload = json.dumps({"input_tokens": 1}).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        if not request_path.endswith("/messages"):
            payload = json.dumps({"error": {"type": "not_found_error", "message": self.path}}).encode()
            self.send_response(404)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        events = tool_use_events() if number == 1 else end_turn_events(number)
        with self.state.lock:
            self.state.requests[self.state.active_variant][-1]["response_events"] = events
        payload = encode_sse(events)
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("cache-control", "no-cache")
        self.send_header("connection", "close")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)
        self.close_connection = True


def find_agent_schema(requests: list[dict[str, Any]]) -> tuple[bool, Any]:
    for request in requests:
        body = request.get("body")
        if not isinstance(body, dict):
            continue
        for tool in body.get("tools", []):
            if isinstance(tool, dict) and tool.get("name") == "Agent":
                return True, tool.get("input_schema")
    return False, None


def parse_stream_json(stdout: str) -> list[Any]:
    parsed: list[Any] = []
    for line in stdout.splitlines():
        try:
            parsed.append(json.loads(line))
        except json.JSONDecodeError:
            parsed.append({"_raw": line})
    return parsed


def saw_agent_tool_use(client_events: list[Any]) -> bool:
    return "toolu_agent_probe" in json.dumps(client_events, separators=(",", ":"))


def run_variant(binary: Path, variant: str, state: MockState, base_url: str, root: Path, timeout_seconds: int) -> dict[str, Any]:
    state.activate(variant)
    home = root / f"home-{variant}"
    config = root / f"config-{variant}"
    cwd = root / f"cwd-{variant}"
    for directory in (home, config, cwd):
        directory.mkdir()
    env = os.environ.copy()
    for key in list(env):
        if key.startswith("ANTHROPIC_") or key.startswith("CLAUDE_CODE_USE_") or key in {"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"}:
            env.pop(key, None)
    env.update(
        {
            "HOME": str(home),
            "CLAUDE_CONFIG_DIR": str(config),
            "ANTHROPIC_API_KEY": "sk-ant-fake-agent-model-runtime",
            "ANTHROPIC_BASE_URL": base_url,
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
            "DISABLE_TELEMETRY": "1",
            "DISABLE_ERROR_REPORTING": "1",
            "DISABLE_AUTOUPDATER": "1",
            "CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY": "1",
            "NO_PROXY": "127.0.0.1,localhost",
            "no_proxy": "127.0.0.1,localhost",
        }
    )
    command = [
        str(binary),
        "-p",
        "Return the mock response. Do not invoke tools unless instructed by the API response.",
        "--output-format",
        "stream-json",
        "--verbose",
        "--safe-mode",
        "--no-session-persistence",
        "--disable-slash-commands",
        "--strict-mcp-config",
        "--mcp-config",
        '{"mcpServers":{}}',
        "--tools",
        "Agent",
        "--allowedTools",
        "Agent",
        "--permission-mode",
        "dontAsk",
        "--max-budget-usd",
        "0.10",
    ]
    started = time.monotonic()
    timed_out = False
    try:
        completed = subprocess.run(command, cwd=cwd, env=env, text=True, capture_output=True, timeout=timeout_seconds, check=False)
        exit_code = completed.returncode
        stdout = completed.stdout
        stderr = completed.stderr
    except subprocess.TimeoutExpired as error:
        timed_out = True
        exit_code = None
        stdout = error.stdout.decode(errors="replace") if isinstance(error.stdout, bytes) else (error.stdout or "")
        stderr = error.stderr.decode(errors="replace") if isinstance(error.stderr, bytes) else (error.stderr or "")
    elapsed = time.monotonic() - started
    with state.lock:
        requests = json.loads(json.dumps(state.requests[variant]))
    advertised, schema = find_agent_schema(requests)
    client_events = parse_stream_json(stdout)
    messages_requests = [request for request in requests if urlsplit(request["path"]).path.endswith("/messages")]
    tool_use_sent = any(event.get("content_block", {}).get("name") == "Agent" for request in messages_requests for event in request.get("response_events", []))
    subagent_requests = [request for request in messages_requests[1:] if isinstance(request.get("body"), dict) and request["body"].get("model") == TARGET_MODEL]
    return {
        "binary_sha256": sha256(binary),
        "binary_state": inspect_variant(binary),
        "command": command,
        "environment": {key: env[key] for key in ["HOME", "CLAUDE_CONFIG_DIR", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "DISABLE_TELEMETRY", "DISABLE_ERROR_REPORTING", "DISABLE_AUTOUPDATER", "NO_PROXY"]},
        "requests": requests,
        "agent_tool_advertised": advertised,
        "agent_schema": schema,
        "tool_use_sent": tool_use_sent,
        "tool_use_received_by_client": saw_agent_tool_use(client_events),
        "subagent_request_observed": bool(subagent_requests),
        "subagent_requests": subagent_requests,
        "client": {"exit_code": exit_code, "timed_out": timed_out, "elapsed_seconds": elapsed, "stdout": stdout, "stderr": stderr, "stream_events": client_events},
    }


def decide_verdict(variants: dict[str, dict[str, Any]]) -> tuple[str, str]:
    clean = variants["clean"]
    agent = variants["agent-model"]
    source = variants["agent-model-source"]
    protocol_reached = all(item["agent_tool_advertised"] and item["tool_use_received_by_client"] and not item["client"]["timed_out"] for item in variants.values())
    clean_rejected = not clean["subagent_request_observed"]
    if not protocol_reached:
        return "not-proven", "At least one run did not advertise Agent, receive the injected tool_use, or finish before timeout."
    if not clean_rejected:
        return "not-proven", "The clean binary also emitted a gpt-5.5 child request, so the baseline rejection oracle failed."
    if agent["subagent_request_observed"]:
        return "refuted", "The agent-model-only copy retained every @bytecode marker and emitted a gpt-5.5 child request."
    if source["subagent_request_observed"]:
        return "proven", "Only the agent-model plus @source__ copy emitted a gpt-5.5 child request."
    return "not-proven", "Neither patched copy emitted a gpt-5.5 child request; wire/output must identify the protocol or CLI blocker."


def self_test() -> dict[str, bool]:
    payload = encode_sse(tool_use_events())
    frames = [frame for frame in payload.decode().split("\n\n") if frame]
    parsed_events = [json.loads(next(line[6:] for line in frame.splitlines() if line.startswith("data: "))) for frame in frames]
    base = {
        "agent_tool_advertised": True,
        "tool_use_received_by_client": True,
        "client": {"timed_out": False},
    }
    refuted, _ = decide_verdict(
        {
            "clean": {**base, "subagent_request_observed": False},
            "agent-model": {**base, "subagent_request_observed": True},
            "agent-model-source": {**base, "subagent_request_observed": True},
        }
    )
    proven, _ = decide_verdict(
        {
            "clean": {**base, "subagent_request_observed": False},
            "agent-model": {**base, "subagent_request_observed": False},
            "agent-model-source": {**base, "subagent_request_observed": True},
        }
    )
    return {
        "equal_length_agent_model_patch": len(ENUM_CORE) == len(REPLACE_CORE),
        "valid_anthropic_sse": parsed_events == tool_use_events(),
        "distinguishes_child_request": refuted == "refuted" and proven == "proven",
    }


def run_experiment(original: Path, output: Path, timeout_seconds: int = 45) -> dict[str, Any]:
    before = sha256(original)
    if before != CLEAN_SHA256:
        raise RuntimeError(f"refusing non-clean original: {before}")
    state = MockState()
    server = ThreadingHTTPServer(("127.0.0.1", 0), MockHandler)
    server.state = state  # type: ignore[attr-defined]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address
    try:
        with tempfile.TemporaryDirectory(prefix="agent-model-runtime-") as temporary:
            root = Path(temporary)
            variants_paths = build_variants(original, root / "variants")
            variants = {name: run_variant(path, name, state, f"http://{host}:{port}", root, timeout_seconds) for name, path in variants_paths.items()}
            verdict, reason = decide_verdict(variants)
            result = {
                "verdict": verdict,
                "reason": reason,
                "original": {"path": str(original), "sha256_before": before, "sha256_after": sha256(original)},
                "mock": {"host": host, "port": port, "base_url": f"http://{host}:{port}"},
                "patch_contract": {"agent_model_clean": ENUM_CORE.decode(), "agent_model_patched": REPLACE_CORE.decode(), "source_clean": BYTECODE_MARKER.decode(), "source_patched": SOURCE_MARKER.decode()},
                "variants": variants,
            }
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
            return result
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
        if sha256(original) != before:
            raise RuntimeError("original binary changed during experiment")


def main() -> int:
    parser = argparse.ArgumentParser(description="Runtime oracle for agent-model -> source-exec dependency")
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--binary", type=Path, default=CLEAN_BINARY)
    parser.add_argument("--output", type=Path, default=Path("/tmp/unbun-agent-model-runtime-result.json"))
    parser.add_argument("--timeout", type=int, default=45)
    args = parser.parse_args()
    if args.self_test:
        result = self_test()
        print(json.dumps(result, sort_keys=True))
        return 0 if all(result.values()) else 2
    result = run_experiment(args.binary, args.output, args.timeout)
    print(json.dumps({"verdict": result["verdict"], "reason": result["reason"], "output": str(args.output)}, indent=2))
    return 0 if result["verdict"] in {"proven", "refuted"} else 2


if __name__ == "__main__":
    raise SystemExit(main())
