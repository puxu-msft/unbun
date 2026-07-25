import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { claudeFeatureRegistry } from '../../lib/patch/targets/claude/index.mjs'
import { PUBLIC_CLI_BOUNDARIES, runCli } from './cli-harness.mjs'

const repositoryRoot = path.resolve(import.meta.dir, '../..')
const goldenPath = path.join(repositoryRoot, 'contract/golden/claude-v1/synthetic-2.1.175-clean.bin')
const temporaryRoots = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unbun-public-baseline-'))
  temporaryRoots.push(root)
  const binary = path.join(root, 'claude')
  const store = path.join(root, 'store')
  const original = await readFile(goldenPath)
  await writeFile(binary, original, { mode: 0o751 })
  return { root, binary, store, original }
}

function argsFor(implementation, action, binary, features = []) {
  if (action === 'status') {
    return implementation === 'javascript'
      ? ['status', '--binary', binary, '--json']
      : ['--check', '--binary', binary, '--json']
  }
  return [action, '--binary', binary, ...features.flatMap((feature) => ['--feature', feature]), '--json']
}

async function invoke(implementation, context, action, features = [], expectedExit = 0) {
  const result = await runCli(PUBLIC_CLI_BOUNDARIES[implementation], {
    args: argsFor(implementation, action, context.binary, features),
    env: { UNBUN_CC_STORE: context.store },
  })
  expect(result.exitCode, result.stderr).toBe(expectedExit)
  return result.output
}

function singleStatus(output) {
  return Array.isArray(output) ? output[0] : output
}

function statesFromStatus(output) {
  return Object.fromEntries(Object.entries(singleStatus(output).features).map(([slug, feature]) => [slug, feature.state]))
}

async function expectStates(implementation, context, expected) {
  expect(statesFromStatus(await invoke(implementation, context, 'status'))).toEqual(expected)
}

async function storeTree(store) {
  const root = path.join(store, 'v1')
  const entries = []
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch((error) => {
      if (error.code === 'ENOENT') return []
      throw error
    })) {
      const candidate = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(candidate)
      else {
        const bytes = await readFile(candidate)
        entries.push({
          path: path.relative(root, candidate),
          size: (await stat(candidate)).size,
          sha256: new Bun.CryptoHasher('sha256').update(bytes).digest('hex'),
        })
      }
    }
  }
  await visit(root)
  return entries.sort((left, right) => left.path.localeCompare(right.path))
}

function replayableChannelsMixed(bytes) {
  const feature = claudeFeatureRegistry.get('channels')
  const substates = feature.observe_substates(bytes)
  const patchable = substates.findIndex((site) => site.id.includes(':feature-flag:'))
  expect(patchable).toBeGreaterThanOrEqual(0)
  const desired = substates.map((site, index) => ({ ...site, state: index === patchable ? 'patched' : 'clean' }))
  const mixed = feature.replay_substates(bytes, desired).bytes
  expect(feature.detect(mixed).state).toBe('mixed')
  return mixed
}

function sameVersionDifferentBuild(bytes) {
  const marker = Buffer.from('code.claude.com', 'latin1')
  const offset = bytes.indexOf(marker)
  expect(offset).toBeGreaterThanOrEqual(0)
  const changed = Buffer.from(bytes)
  changed[offset] = changed[offset] === 0x63 ? 0x43 : 0x63
  return changed
}

describe('public CLI cross-language baseline replay', () => {
  for (const [first, second] of [['javascript', 'python'], ['python', 'javascript']]) {
    test(`${first} creates baseline and ${second} extends, verifies, and reverts it`, async () => {
      const context = await fixture()

      expect((await invoke(first, context, 'patch', ['channels'])).results[0].applied).toEqual(['source-exec', 'channels'])
      await expectStates(second, context, { 'source-exec': 'patched', 'agent-model': 'clean', channels: 'patched' })

      expect((await invoke(second, context, 'patch', ['agent-model'])).results[0].applied).toEqual(['source-exec', 'agent-model', 'channels'])
      await expectStates(first, context, { 'source-exec': 'patched', 'agent-model': 'patched', channels: 'patched' })

      expect((await invoke(first, context, 'revert', ['channels'])).results[0].applied).toEqual(['agent-model'])
      await expectStates(second, context, { 'source-exec': 'clean', 'agent-model': 'patched', channels: 'clean' })

      expect((await invoke(second, context, 'revert')).results[0].applied).toEqual([])
      expect(await readFile(context.binary)).toEqual(context.original)
      await expectStates(first, context, { 'source-exec': 'clean', 'agent-model': 'clean', channels: 'clean' })
      expect(await storeTree(context.store)).not.toEqual([])
    }, 30_000)
  }

  for (const [baselineOwner, repairer] of [['javascript', 'python'], ['python', 'javascript']]) {
    test(`${baselineOwner} baseline accepts replayable mixed bytes repaired by public ${repairer}`, async () => {
      const context = await fixture()
      await invoke(baselineOwner, context, 'patch', ['agent-model'])
      await invoke(baselineOwner, context, 'revert')
      const beforeStore = await storeTree(context.store)
      await writeFile(context.binary, replayableChannelsMixed(context.original), { mode: 0o751 })

      await invoke(repairer, context, 'patch', ['channels'])
      await expectStates(baselineOwner, context, { 'source-exec': 'patched', 'agent-model': 'clean', channels: 'patched' })
      expect(await storeTree(context.store)).toEqual(beforeStore)
    }, 30_000)
  }

  for (const [baselineOwner, rejecter] of [['javascript', 'python'], ['python', 'javascript']]) {
    test(`${baselineOwner} baseline is rejected by public ${rejecter} for a same-version different build`, async () => {
      const context = await fixture()
      await invoke(baselineOwner, context, 'patch', ['agent-model'])
      await invoke(baselineOwner, context, 'revert')
      const beforeStore = await storeTree(context.store)
      const differentBuild = sameVersionDifferentBuild(context.original)
      await writeFile(context.binary, differentBuild, { mode: 0o751 })

      const rejected = await invoke(rejecter, context, 'patch', ['agent-model'], 2)
      expect(rejected).toMatchObject({ success: false, exit_code: 2, errors: [{ code: 'baseline_stale_build' }] })
      expect(await readFile(context.binary)).toEqual(differentBuild)
      expect(await storeTree(context.store)).toEqual(beforeStore)
    }, 30_000)
  }
})
