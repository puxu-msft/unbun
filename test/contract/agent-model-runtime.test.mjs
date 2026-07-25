import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const runtimeProbe = fileURLToPath(
  new URL('../../exp/agent-model-runtime/runtime_probe.py', import.meta.url),
)

test('agent-model runtime PoC self-checks patch bytes, SSE, and request oracles', () => {
  const result = spawnSync('python3', [runtimeProbe, '--self-test'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })

  expect(result.status, result.stderr || result.stdout).toBe(0)
  const report = JSON.parse(result.stdout)
  expect(report.equal_length_agent_model_patch).toBe(true)
  expect(report.valid_anthropic_sse).toBe(true)
  expect(report.distinguishes_child_request).toBe(true)
})