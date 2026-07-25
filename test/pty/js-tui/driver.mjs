import { appendFile } from 'node:fs/promises'

import { runJsTui } from '../../../lib/patch/tui/run.mjs'

const scenario = process.env.JS_TUI_SCENARIO ?? 'standard'
const trace = process.env.JS_TUI_TRACE
const features = (source = 'clean', agent = 'clean', channels = 'clean') => ({
  'source-exec': { state: source, details: [] },
  'agent-model': { state: agent, details: [] },
  channels: { state: channels, details: channels === 'unsupported' ? ['missing_anchor'] : [] },
})

let generation = 0
let rows = scenario === 'mixed'
  ? [{ path: '/tmp/fixtures/stable/claude', version: '2.1.217', hasBaseline: true, entryDigest: 'mixed-0', features: features('mixed') }]
  : [
      { path: '/tmp/fixtures/stable/claude', version: '2.1.217', hasBaseline: true, entryDigest: 'stable-0', features: features() },
      { path: '/tmp/fixtures/canary/claude', version: '2.1.218', hasBaseline: false, entryDigest: 'canary-0', features: features('clean', 'clean', 'unsupported') },
    ]

const adapters = {
  loadRows: async () => structuredClone(rows),
  applyTargets: async (plan) => {
    if (trace) await appendFile(trace, `${JSON.stringify(plan)}\n`)
    await Bun.sleep(250)
    if (scenario === 'error') {
      const error = new Error('fixture transaction rejected')
      error.code = 'target_locked'
      error.exitCode = 1
      throw error
    }
    generation++
    rows = rows.map((binary) => binary.path !== plan.binary ? binary : {
      ...binary,
      hasBaseline: true,
      entryDigest: `${binary.path}-${generation}`,
      features: Object.fromEntries(Object.entries(binary.features).map(([feature, status]) => [feature, {
        ...status,
        state: status.state === 'unsupported' ? 'unsupported' : plan.targetFeatures.includes(feature) ? 'patched' : 'clean',
      }])),
    })
    return { binary: plan.binary, applied: plan.targetFeatures, edits: 1, resigned: false }
  },
}

const result = await runJsTui(adapters)
process.exitCode = result.exitCode