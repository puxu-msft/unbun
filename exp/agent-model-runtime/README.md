# Agent model runtime dependency probe

This experiment runs three temporary copies of a clean Claude Code binary against an isolated localhost Anthropic Messages mock:

1. clean;
2. `agent-model` only, retaining every `@bytecode` marker;
3. `agent-model` plus `@source__`.

The mock emits one `Agent(model="gpt-5.5")` tool call and then returns `end_turn`. The probe records two independent runtime facts:

- the Agent tool's `model` JSON schema in the first outbound request;
- whether a child request with `model=gpt-5.5` reaches the mock.

It never connects to the configured LiteLLM instance and never modifies the source binary.

```bash
uv run --with pytest pytest -q exp/agent-model-runtime
RUN_CLAUDE_RUNTIME_PROBE=1 uv run --with pytest pytest -q \
  exp/agent-model-runtime/test_runtime_probe.py

python3 exp/agent-model-runtime/runtime_probe.py \
  --binary /home/xp/.local/share/claude/versions/2.1.214 \
  --output /tmp/unbun-agent-model-runtime-result.json
```

The decisive 2.1.214 result is `refuted`: the agent-model-only copy retains all five `@bytecode` markers, advertises `model` as an unrestricted string, and sends a child request with `model=gpt-5.5`. `source-exec` is therefore not a required dependency of `agent-model` for the audited build.