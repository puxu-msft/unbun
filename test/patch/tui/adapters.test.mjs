import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { applyFeatureTargets } from '../../../lib/patch/cli/actions.mjs'
import { createProductionTuiAdapters } from '../../../lib/patch/tui/adapters.mjs'

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')

describe('production TUI adapters', () => {
  test('loads stable status and entry digest without writing store state', async () => {
    const bytes = Buffer.from('stable fixture')
    let reads = 0
    const adapters = createProductionTuiAdapters({
      binaries: ['/tmp/fixture/claude'],
      readStatus: async () => ({
        path: '/tmp/fixture/claude',
        version: '2.1.217',
        has_baseline: false,
        features: {
          'source-exec': { state: 'clean', details: [] },
          'agent-model': { state: 'mixed', details: ['partial'] },
          channels: { state: 'unsupported', details: ['missing'] },
        },
      }),
      readBinary: async () => { reads++; return bytes },
      applyFeatureTargets: async () => { throw new Error('loadRows must be read-only') },
    })

    expect(await adapters.loadRows()).toEqual([{
      path: '/tmp/fixture/claude',
      version: '2.1.217',
      hasBaseline: false,
      entryDigest: digest(bytes),
      features: {
        'source-exec': { state: 'clean', details: [] },
        'agent-model': { state: 'mixed', details: ['partial'] },
        channels: { state: 'unsupported', details: ['missing'] },
      },
    }])
    expect(reads).toBe(2)
  })

  test('rejects a binary that changes while its status is probed', async () => {
    const versions = [Buffer.from('before'), Buffer.from('after')]
    const adapters = createProductionTuiAdapters({
      binaries: ['/tmp/fixture/claude'],
      readStatus: async () => ({ path: '/tmp/fixture/claude', version: '2.1.217', has_baseline: false, features: {} }),
      readBinary: async () => versions.shift(),
      applyFeatureTargets: async () => {},
    })
    await expect(adapters.loadRows()).rejects.toMatchObject({ code: 'concurrent_binary_change' })
  })

  test('passes the final dependency-closed target set and entry digest to the formal write entry', async () => {
    const calls = []
    const adapters = createProductionTuiAdapters({
      binaries: ['/tmp/fixture/claude'],
      readStatus: async () => {},
      readBinary: async () => Buffer.alloc(0),
      applyFeatureTargets: async (...args) => { calls.push(args); return { applied: args[1] } },
    })
    await adapters.applyTargets({ binary: '/tmp/fixture/claude', targetFeatures: ['source-exec', 'channels'], entryDigest: 'entry' })
    expect(calls).toEqual([['/tmp/fixture/claude', ['source-exec', 'channels'], 'entry']])
  })

  test('formal write entry forwards directly to transaction without recomputing targets', async () => {
    const calls = []
    const result = await applyFeatureTargets('/tmp/fixture/claude', ['agent-model'], 'entry', {
      context: { binary: '/tmp/fixture/claude', targetDirectory: '/tmp/store/target', identity: { pathKey: 'key' } },
      runTransaction: async (options) => { calls.push(options); return { ok: true } },
    })
    expect(result).toEqual({ ok: true })
    expect(calls[0]).toMatchObject({
      binaryPath: '/tmp/fixture/claude',
      targetDirectory: '/tmp/store/target',
      pathKey: 'key',
      requestedFeatures: ['agent-model'],
      entryDigest: 'entry',
    })
  })

  test('production adapters patch and revert a temporary fixture through shared store then reprobe', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unbun-js-tui-adapter-'))
    const binary = path.join(root, 'claude')
    const previousStore = process.env.UNBUN_CC_STORE
    process.env.UNBUN_CC_STORE = path.join(root, 'store')
    await cp(path.resolve(import.meta.dir, '../../../contract/golden/claude-v1/synthetic-2.1.175-clean.bin'), binary)
    try {
      const adapters = createProductionTuiAdapters({ binaries: [binary] })
      const clean = (await adapters.loadRows())[0]
      expect(clean.features['source-exec'].state).toBe('clean')
      expect(clean.hasBaseline).toBe(false)

      await adapters.applyTargets({ binary, targetFeatures: ['source-exec'], entryDigest: clean.entryDigest })
      const patched = (await adapters.loadRows())[0]
      expect(patched.features['source-exec'].state).toBe('patched')
      expect(patched.hasBaseline).toBe(true)

      await adapters.applyTargets({ binary, targetFeatures: [], entryDigest: patched.entryDigest })
      const reverted = (await adapters.loadRows())[0]
      expect(reverted.features['source-exec'].state).toBe('clean')
      expect(reverted.hasBaseline).toBe(true)
    } finally {
      if (previousStore === undefined) delete process.env.UNBUN_CC_STORE
      else process.env.UNBUN_CC_STORE = previousStore
      await rm(root, { recursive: true, force: true })
    }
  })
})