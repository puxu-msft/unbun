import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { PUBLIC_CLI_BOUNDARIES, runCli } from './cli-harness.mjs'

const repositoryRoot = path.resolve(import.meta.dir, '../..')
const goldenPath = path.join(repositoryRoot, 'contract/golden/claude-v1/synthetic-2.1.175-clean.bin')
const temporaryRoots = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(label) {
  const root = await mkdtemp(path.join(os.tmpdir(), `unbun-cli-${label}-`))
  temporaryRoots.push(root)
  const binary = path.join(root, 'claude')
  const original = await readFile(goldenPath)
  await writeFile(binary, original, { mode: 0o751 })
  return { root, binary, original, store: path.join(root, 'store') }
}

function commandArgs(implementation, action, binary, features = []) {
  if (action === 'status') {
    return implementation === 'javascript'
      ? ['status', '--binary', binary, '--json']
      : ['--check', '--binary', binary, '--json']
  }
  return [action, '--binary', binary, ...features.flatMap((feature) => ['--feature', feature]), '--json']
}

async function invoke(implementation, context, action, features = []) {
  const result = await runCli(PUBLIC_CLI_BOUNDARIES[implementation], {
    args: commandArgs(implementation, action, context.binary, features),
    env: { UNBUN_CC_STORE: context.store },
  })
  expect(result.exitCode, result.stderr).toBe(0)
  return result.output
}

function singleStatus(output) {
  return Array.isArray(output) ? output[0] : output
}

function states(status) {
  return Object.fromEntries(Object.entries(status.features).map(([slug, feature]) => [slug, feature.state]))
}

function expectWrite(envelope, { action, applied, edits }) {
  expect(envelope).toMatchObject({
    schema_version: 1,
    success: true,
    exit_code: 0,
    action,
    results: [{ applied, edits, resigned: false }],
    errors: [],
  })
}

async function expectStatus(implementation, context, expected, { hasBaseline = true } = {}) {
  const status = singleStatus(await invoke(implementation, context, 'status'))
  expect(status.has_baseline).toBe(hasBaseline)
  expect(states(status)).toEqual(expected)
  for (const feature of Object.values(status.features)) {
    expect(feature.substates.map((substate) => substate.state)).toEqual(
      Array(feature.sites).fill(feature.state),
    )
  }
  return status
}

describe('alternating public CLIs on one shared store', () => {
  for (const [label, first, second] of [
    ['scenario A', 'javascript', 'python'],
    ['scenario B', 'python', 'javascript'],
  ]) {
    test(`${label}: ${first} channels, ${second} agent-model, then alternating reverts`, async () => {
      const context = await fixture(label.replace(' ', '-').toLowerCase())

      const channels = await invoke(first, context, 'patch', ['channels'])
      expectWrite(channels, {
        action: 'patch',
        applied: ['source-exec', 'channels'],
        edits: 5,
      })
      await expectStatus(second, context, {
        'source-exec': 'patched',
        'agent-model': 'clean',
        channels: 'patched',
      })

      const agent = await invoke(second, context, 'patch', ['agent-model'])
      expectWrite(agent, {
        action: 'patch',
        applied: ['source-exec', 'agent-model', 'channels'],
        edits: 1,
      })
      await expectStatus(first, context, {
        'source-exec': 'patched',
        'agent-model': 'patched',
        channels: 'patched',
      })

      const agentOnly = await invoke(first, context, 'revert', ['channels'])
      expectWrite(agentOnly, {
        action: 'revert',
        applied: ['agent-model'],
        edits: 5,
      })
      await expectStatus(second, context, {
        'source-exec': 'clean',
        'agent-model': 'patched',
        channels: 'clean',
      })
      expect((await readFile(context.binary)).toString('latin1')).toContain('@bytecode')

      const clean = await invoke(second, context, 'revert')
      expectWrite(clean, { action: 'revert', applied: [], edits: 1 })
      await expectStatus(first, context, {
        'source-exec': 'clean',
        'agent-model': 'clean',
        channels: 'clean',
      })
      expect(await readFile(context.binary)).toEqual(context.original)
    }, 30_000)
  }
})