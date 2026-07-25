import { describe, expect, test } from 'bun:test'
import { access, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { closeFeatures } from '../../lib/patch/core/dependencies.mjs'
import { sha256 } from '../../lib/patch/store/manifests.mjs'
import { claudeFeatureRegistry } from '../../lib/patch/targets/claude/index.mjs'
import { resolveTransactionBaseline, runPatchTransaction } from '../../lib/patch/transaction/transaction.mjs'

const clean = await readFile(new URL('../../contract/golden/claude-v1/synthetic-2.1.175-clean.bin', import.meta.url))
const vectors = JSON.parse(await readFile(new URL('../../contract/vectors/transaction-v1.json', import.meta.url), 'utf8'))
const knownBad = JSON.parse(await readFile(new URL('../../contract/vectors/known-bad-v1/manifest.json', import.meta.url), 'utf8'))

function applyFeatures(requested) {
  let bytes = Buffer.from(clean)
  for (const name of closeFeatures(claudeFeatureRegistry, requested)) {
    bytes = claudeFeatureRegistry.get(name).apply(bytes).bytes
  }
  return bytes
}

function inspect(bytes) {
  return {
    embeddedVersion: '2.1.175',
    states: Object.fromEntries(claudeFeatureRegistry.features().map((feature) => [feature.name, feature.detect(bytes).state])),
  }
}

async function fixture(entryFeatures) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unbun-transaction-'))
  const binaryPath = path.join(root, '2.1.175')
  const entry = applyFeatures(entryFeatures)
  await writeFile(binaryPath, entry, { mode: 0o751 })
  return { root, binaryPath, entry }
}

function transactionOptions(root, writes) {
  return {
    targetDirectory: path.join(root, 'store', 'target'),
    baseline: {
      bytes: clean,
      manifest: {
        embedded_version: '2.1.175',
        size: clean.length,
        sha256: sha256(clean),
      },
    },
    registry: claudeFeatureRegistry,
    inspect,
    platform: 'linux',
    lock: {
      acquire: async () => ({ token: 'test-lock' }),
      release: async () => {},
    },
    atomicWrite: {
      publish: async (options) => {
        writes.push(options)
        await writeFile(options.binaryPath, options.resultBytes, { mode: options.mode })
        return { replaced: true, temporaryPath: null }
      },
      restore: async ({ binaryPath, entryBytes, mode }) => writeFile(binaryPath, entryBytes, { mode }),
    },
    verifyBaseline: async () => ({ accepted: true }),
  }
}

describe('shared-store v1 binary transaction', () => {
  test('consumes the frozen language-neutral scenario vector', () => {
    expect(vectors).toMatchObject({ schema_version: 1, protocol: 'shared-store-v1-section-9' })
    expect(vectors.scenarios.map((scenario) => scenario.id)).toEqual([
      'apply-agent-model',
      'idempotent-agent-model',
      'revert-channels-preserves-agent',
      'entry-digest-mismatch',
    ])
  })

  for (const scenario of vectors.scenarios.filter((item) => !item.expected_error)) {
    test(scenario.id, async () => {
      const { root, binaryPath, entry } = await fixture(scenario.entry_features)
      const writes = []
      const before = await stat(binaryPath)
      const result = await runPatchTransaction({
        binaryPath,
        requestedFeatures: scenario.requested_features,
        entryDigest: sha256(entry),
        ...transactionOptions(root, writes),
      })

      expect(result).toMatchObject({ applied: scenario.expected_features, edits: scenario.expected_edits })
      expect(writes).toHaveLength(scenario.expected_write ? 1 : 0)
      const finalBytes = await readFile(binaryPath)
      expect(finalBytes).toEqual(applyFeatures(scenario.expected_features))
      expect((await stat(binaryPath)).mode & 0o777).toBe(before.mode & 0o777)
      expect(finalBytes.toString('latin1')).not.toContain('.bak')
    })
  }

  test('rejects a stale entry digest before writing', async () => {
    const scenario = vectors.scenarios.find((item) => item.id === 'entry-digest-mismatch')
    const { root, binaryPath, entry } = await fixture(scenario.entry_features)
    const writes = []
    await expect(runPatchTransaction({
      binaryPath,
      requestedFeatures: scenario.requested_features,
      entryDigest: scenario.entry_digest,
      ...transactionOptions(root, writes),
    })).rejects.toMatchObject({ code: scenario.expected_error })
    expect(writes).toHaveLength(0)
    expect(await readFile(binaryPath)).toEqual(entry)
  })
})

describe('transaction baseline resolver', () => {
  const pathKey = 'a'.repeat(64)

  async function resolveFixture(entryFeatures) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unbun-baseline-'))
    return {
      targetDirectory: path.join(root, pathKey),
      current: applyFeatures(entryFeatures),
      registry: claudeFeatureRegistry,
      inspect,
      platform: 'linux',
      pathKey,
      now: () => new Date('2026-07-23T12:34:56.000Z'),
    }
  }

  test('publishes and re-verifies a clean baseline before returning it', async () => {
    const input = await resolveFixture([])
    const baseline = await resolveTransactionBaseline(input)
    expect(baseline.created).toBe(true)
    expect(baseline.bytes).toEqual(clean)
    expect(baseline.manifest).toMatchObject({
      schema: 'unbun.cc.baseline',
      embedded_version: '2.1.175',
      path_key: pathKey,
      states: { 'source-exec': 'clean', 'agent-model': 'clean', channels: 'clean' },
    })
    const loaded = await resolveTransactionBaseline(input)
    expect(loaded.created).toBe(false)
    expect(loaded.bytes).toEqual(clean)
  })

  test('reverses only patched reversible features and proves exact replay', async () => {
    const input = await resolveFixture(['agent-model'])
    const baseline = await resolveTransactionBaseline(input)
    expect(baseline.bytes).toEqual(clean)
    expect(baseline.created).toBe(true)
  })

  test('refuses to invent a baseline from patched irreversible channels', async () => {
    const input = await resolveFixture(['channels'])
    await expect(resolveTransactionBaseline(input)).rejects.toMatchObject({ code: 'channels_patched_no_baseline', exitCode: 1 })
  })

  test('does not write the binary when baseline publication fails', async () => {
    const { root, binaryPath, entry } = await fixture([])
    const writes = []
    await expect(runPatchTransaction({
      binaryPath,
      requestedFeatures: ['agent-model'],
      entryDigest: sha256(entry),
      registry: claudeFeatureRegistry,
      inspect,
      platform: 'linux',
      targetDirectory: path.join(root, pathKey),
      pathKey,
      lock: { acquire: async () => ({ token: 'baseline-lock' }), release: async () => {} },
      atomicWrite: { publish: async (options) => writes.push(options), restore: async () => {} },
      baselineResolver: async () => { throw new Error('baseline publish failed') },
    })).rejects.toThrow('baseline publish failed')
    expect(writes).toHaveLength(0)
    expect(await readFile(binaryPath)).toEqual(entry)
  })

  test('holds the default cooperative target lock across baseline resolution and binary publish', async () => {
    const { root, binaryPath, entry } = await fixture([])
    const targetDirectory = path.join(root, 'default-lock-target')
    const observations = []
    const assertLocked = async (stage) => {
      const owner = JSON.parse(await readFile(path.join(targetDirectory, 'write.lock', 'owner.json'), 'utf8'))
      observations.push([stage, owner.command])
    }
    await runPatchTransaction({
      binaryPath,
      targetDirectory,
      requestedFeatures: ['agent-model'],
      entryDigest: sha256(entry),
      registry: claudeFeatureRegistry,
      inspect,
      platform: 'linux',
      baselineResolver: async () => {
        await assertLocked('baseline')
        return { bytes: clean, manifest: { embedded_version: '2.1.175', size: clean.length, sha256: sha256(clean) } }
      },
      verifyBaseline: async () => ({ accepted: true }),
      atomicWrite: {
        publish: async ({ resultBytes }) => {
          await assertLocked('publish')
          await writeFile(binaryPath, resultBytes, { mode: 0o751 })
          return { replaced: true }
        },
        restore: async () => {},
      },
    })
    expect(observations).toEqual([
      ['baseline', `write ${binaryPath}`],
      ['publish', `write ${binaryPath}`],
    ])
    await expect(access(path.join(targetDirectory, 'write.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('frozen generation-one known-bad cases on the new transaction', () => {
  const byId = Object.fromEntries(knownBad.vectors.map((vector) => [vector.id, vector]))

  test('covers all five frozen known-bad IDs', () => {
    expect(Object.keys(byId)).toEqual([
      'hardcoded-e',
      'incorrect-agent-source-dependency',
      'channels-revert-erases-agent-model',
      'adjacent-bak',
      'collapsed-error-exit',
    ])
  })

  test('applies agent-model with the receiver preserved and without the old source dependency', async () => {
    const { root, binaryPath } = await fixture([])
    const entry = Buffer.from(clean.toString('latin1').replace('model:Q.enum(', 'model:S.enum('), 'latin1')
    await writeFile(binaryPath, entry, { mode: 0o751 })
    expect(claudeFeatureRegistry.get('agent-model').detect(entry).state).toBe(byId['hardcoded-e'].assertion.expected)
    const result = await runPatchTransaction({
      binaryPath,
      requestedFeatures: ['agent-model'],
      entryDigest: sha256(entry),
      ...transactionOptions(root, []),
      baseline: {
        bytes: entry,
        manifest: { embedded_version: '2.1.175', size: entry.length, sha256: sha256(entry) },
      },
    })
    expect(result.applied).toEqual(byId['incorrect-agent-source-dependency'].assertion.expected)
    const bytes = await readFile(binaryPath)
    expect(bytes.toString('latin1')).toContain('model:S.string()')
    expect(bytes.toString('latin1')).toContain('// @bun @bytecode')
    expect(claudeFeatureRegistry.get('agent-model').detect(bytes).state).toBe('patched')
  })

  test('reverts channels while preserving agent-model and creates or reads no adjacent backup', async () => {
    const { root, binaryPath, entry } = await fixture(['agent-model', 'channels'])
    await writeFile(`${binaryPath}.bak`, Buffer.from('decoy backup that must not be read'))
    const result = await runPatchTransaction({
      binaryPath,
      requestedFeatures: ['agent-model'],
      entryDigest: sha256(entry),
      ...transactionOptions(root, []),
    })
    expect(result.applied).toEqual(['agent-model'])
    const bytes = await readFile(binaryPath)
    expect(bytes.toString('latin1')).toContain(byId['channels-revert-erases-agent-model'].assertion.expected.replace('E.', 'Q.'))
    expect(claudeFeatureRegistry.get('channels').detect(bytes).state).toBe('clean')
    expect(await readFile(`${binaryPath}.bak`, 'utf8')).toBe('decoy backup that must not be read')
    const names = await readdir(root)
    expect(names.filter((name) => name.endsWith('.bak'))).toEqual(['2.1.175.bak'])
    await expect(access(path.join(root, 'store', 'target', '2.1.175.bak'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('maps structural feature failure to integrity severity instead of exit 1', async () => {
    const malformed = Buffer.from(clean.toString('latin1').replace('function oYH(){return w$("tengu_harbor",!1)}', ''), 'latin1')
    const { root, binaryPath } = await fixture([])
    await writeFile(binaryPath, malformed)
    await expect(runPatchTransaction({
      binaryPath,
      requestedFeatures: ['channels'],
      entryDigest: sha256(malformed),
      ...transactionOptions(root, []),
      baseline: { bytes: malformed, manifest: { embedded_version: '2.1.175', size: malformed.length, sha256: sha256(malformed) } },
    })).rejects.toMatchObject({
      code: byId['collapsed-error-exit'].assertion.expected === 2 ? 'content_mismatch' : 'unexpected',
      exitCode: byId['collapsed-error-exit'].assertion.expected,
    })
    expect(await readFile(binaryPath)).toEqual(malformed)
  })
})