import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  assessBaselineCreation,
  createDurabilityAdapter,
  loadBaseline,
  loadSnapshot,
  publishBaseline,
  publishSnapshot,
  publishTargetMetadata,
  selectSnapshot,
} from '../../../lib/patch/store/assets.mjs'

const storeCases = JSON.parse(await readFile(new URL('../../../contract/vectors/store-v1/fixtures/store-cases.json', import.meta.url), 'utf8'))
const storeExpected = JSON.parse(await readFile(new URL('../../../contract/vectors/store-v1/fixtures/store-expected.json', import.meta.url), 'utf8'))

const temporary = []
afterEach(async () => Promise.all(temporary.splice(0).map((entry) => rm(entry, { recursive: true, force: true }))))

async function tempStore() {
  const root = await mkdtemp(path.join(tmpdir(), 'unbun-store-js-'))
  temporary.push(root)
  return root
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function baselineManifest(bytes, pathKey = 'a'.repeat(64)) {
  const sha256 = hash(bytes)
  return {
    schema: 'unbun.cc.baseline', schema_version: 1, feature_contract: 'claude-v1', path_key: pathKey,
    embedded_version: '2.1.217', blob: `blobs/${sha256}.ccbak`, sha256,
    lineage_algorithm: 'claude-v1-exact-replay', lineage_sha256: sha256, size: bytes.length,
    states: { 'source-exec': 'clean', 'agent-model': 'clean', channels: 'clean' },
    created_at: '2026-07-23T12:34:56.000Z', created_by: 'js',
  }
}

function snapshotManifest(bytes, slug = 'before-change', pathKey = 'a'.repeat(64)) {
  const sha256 = hash(bytes)
  return {
    schema: 'unbun.cc.snapshot', schema_version: 1, feature_contract: 'claude-v1', path_key: pathKey,
    embedded_version: '2.1.217', slug, blob: `blobs/${sha256}.ccsnap`, sha256, size: bytes.length,
    observed_states: { 'source-exec': 'patched', 'agent-model': 'clean', channels: 'clean' },
    created_at: '2026-07-23T12:34:56.000Z', created_by: 'js',
  }
}

const inspectBaseline = async (bytes, manifest) => {
  expect(bytes.length).toBe(manifest.size)
  return { embeddedVersion: manifest.embedded_version, states: manifest.states }
}
const inspectSnapshot = async (bytes, manifest) => {
  expect(bytes.length).toBe(manifest.size)
  return { embeddedVersion: manifest.embedded_version, states: manifest.observed_states }
}

describe('content-addressed store assets', () => {
  test('publishes target metadata no-clobber and rejects identity drift', async () => {
    const root = await tempStore()
    const targetDir = path.join(root, 'v1', 'targets', 'a'.repeat(64))
    const target = {
      schema: 'unbun.cc.target', schema_version: 1, path_key: 'a'.repeat(64), canonical_path: '/opt/claude',
      display_name: 'claude', created_at: '2026-07-23T12:34:56.000Z',
    }
    expect((await publishTargetMetadata(targetDir, target)).created).toBe(true)
    expect((await publishTargetMetadata(targetDir, target)).created).toBe(false)
    await expect(publishTargetMetadata(targetDir, { ...target, canonical_path: '/other/claude' })).rejects.toMatchObject({ code: 'target_identity_mismatch' })
    expect(JSON.parse(await readFile(path.join(targetDir, 'target.json'), 'utf8'))).toEqual(target)
  })

  test('activates a baseline only through a verified manifest and ignores orphan blobs and temps', async () => {
    const root = await tempStore()
    const targetDir = path.join(root, 'target')
    const bytes = Buffer.from('clean baseline')
    const manifest = baselineManifest(bytes)
    const options = { pathKey: manifest.path_key, inspect: inspectBaseline, computeLineageSha256: async () => hash(bytes) }
    const published = await publishBaseline(targetDir, manifest, bytes, options)
    expect(published.created).toBe(true)
    expect((await loadBaseline(targetDir, '2.1.217', options)).bytes.equals(bytes)).toBe(true)

    await Bun.write(path.join(targetDir, 'baselines', '2.1.218', 'blobs', `${hash(bytes)}.ccbak`), bytes)
    await Bun.write(path.join(targetDir, 'baselines', '2.1.219', '.baseline.json.tmp.orphan'), '{}')
    expect(await loadBaseline(targetDir, '2.1.218', options)).toBeNull()
    expect(await loadBaseline(targetDir, '2.1.219', options)).toBeNull()
  })

  test('keeps baseline manifest no-clobber and supports atomic force snapshot activation', async () => {
    const root = await tempStore()
    const targetDir = path.join(root, 'target')
    const first = Buffer.from('first')
    const second = Buffer.from('second')
    const baselineOptions = { inspect: inspectBaseline, computeLineageSha256: async () => hash(first) }
    await publishBaseline(targetDir, baselineManifest(first), first, { pathKey: 'a'.repeat(64), ...baselineOptions })
    await expect(publishBaseline(targetDir, baselineManifest(second), second, {
      pathKey: 'a'.repeat(64), inspect: inspectBaseline, computeLineageSha256: async () => hash(second),
    })).rejects.toMatchObject({ code: 'baseline_conflict' })

    const firstManifest = snapshotManifest(first)
    const secondManifest = snapshotManifest(second)
    await publishSnapshot(targetDir, firstManifest, first, { pathKey: 'a'.repeat(64), inspect: inspectSnapshot })
    await expect(publishSnapshot(targetDir, secondManifest, second, { pathKey: 'a'.repeat(64), inspect: inspectSnapshot })).rejects.toMatchObject({ code: 'snapshot_exists' })
    const replaced = await publishSnapshot(targetDir, secondManifest, second, { pathKey: 'a'.repeat(64), force: true, inspect: inspectSnapshot })
    expect(replaced).toMatchObject({ created: false, replaced: true })
    const active = await loadSnapshot(targetDir, '2.1.217', 'before-change', { pathKey: secondManifest.path_key, inspect: inspectSnapshot })
    expect(active.manifest.sha256).toBe(hash(second))
    expect(active.bytes.equals(second)).toBe(true)
    expect(storeExpected.force_activation).toEqual({ visible_state: 'old-or-new-valid-manifest', partial_manifest_visible: false })
  })

  test('reports force creation accurately when no snapshot manifest exists', async () => {
    const root = await tempStore()
    const targetDir = path.join(root, 'target')
    const bytes = Buffer.from('first force save')
    const manifest = snapshotManifest(bytes)
    const result = await publishSnapshot(targetDir, manifest, bytes, { pathKey: 'a'.repeat(64), force: true, inspect: inspectSnapshot })
    expect(result).toMatchObject({ created: true, replaced: false })
  })

  test('selects the current-version snapshot or reports frozen ambiguity', async () => {
    const root = await tempStore()
    const targetDir = path.join(root, 'target')
    const { slug, versions, current_version: ambiguousVersion } = storeCases.snapshots.ambiguity
    for (const version of versions) {
      const bytes = Buffer.from(`snapshot-${version}`)
      const manifest = { ...snapshotManifest(bytes, slug), embedded_version: version }
      await publishSnapshot(targetDir, manifest, bytes, { pathKey: 'a'.repeat(64), inspect: async () => ({ embeddedVersion: version, states: manifest.observed_states }) })
    }
    const selected = await selectSnapshot(targetDir, slug, { currentVersion: versions[1], pathKey: 'a'.repeat(64), inspect: async (_bytes, manifest) => ({ embeddedVersion: manifest.embedded_version, states: manifest.observed_states }) })
    expect(selected.manifest.embedded_version).toBe(versions[1])
    await expect(selectSnapshot(targetDir, slug, {
      currentVersion: ambiguousVersion,
      pathKey: 'a'.repeat(64),
      inspect: async (_bytes, manifest) => ({ embeddedVersion: manifest.embedded_version, states: manifest.observed_states }),
    })).rejects.toMatchObject({
      code: storeExpected.snapshot_ambiguity.code,
      exitCode: storeExpected.snapshot_ambiguity.exit,
    })
  })

  test('exposes the POSIX and Windows fsync durability boundary', async () => {
    const calls = []
    const posix = createDurabilityAdapter({ platform: 'linux', syncFile: async () => calls.push('file'), syncDirectory: async () => calls.push('directory') })
    await posix.fsyncFile({})
    await posix.fsyncDirectory('/tmp')
    expect(posix.boundary).toBe('file-and-directory-fsync')
    expect(calls).toEqual(['file', 'directory'])

    const windows = createDurabilityAdapter({ platform: 'win32', syncFile: async () => calls.push('windows-file'), syncDirectory: async () => calls.push('must-not-run') })
    await windows.fsyncFile({})
    await windows.fsyncDirectory('C:\\store')
    expect(windows.boundary).toBe('file-flush-and-atomic-rename-no-directory-fsync')
    expect(calls).toEqual(['file', 'directory', 'windows-file'])
  })

  test('fsyncs both the content-addressed blob directory and manifest slot on POSIX', async () => {
    const root = await tempStore()
    const targetDir = path.join(root, 'target')
    const bytes = Buffer.from('durable baseline')
    const manifest = baselineManifest(bytes)
    const directories = []
    const durability = {
      boundary: 'test',
      fsyncFile: async (handle) => handle.sync(),
      fsyncDirectory: async (directory) => directories.push(directory),
    }
    await publishBaseline(targetDir, manifest, bytes, {
      durability,
      pathKey: manifest.path_key,
      inspect: inspectBaseline,
      computeLineageSha256: async () => hash(bytes),
    })
    expect(directories).toContain(path.join(targetDir, 'baselines', '2.1.217', 'blobs'))
    expect(directories).toContain(path.join(targetDir, 'baselines', '2.1.217'))
  })

  test('requires target identity when a nonstandard target directory cannot provide a path key', async () => {
    const root = await tempStore()
    const targetDir = path.join(root, 'target')
    const bytes = Buffer.from('identity baseline')
    const manifest = baselineManifest(bytes)
    await publishBaseline(targetDir, manifest, bytes, {
      pathKey: manifest.path_key,
      inspect: inspectBaseline,
      computeLineageSha256: async () => hash(bytes),
    })
    await expect(loadBaseline(targetDir, '2.1.217', {
      inspect: inspectBaseline,
      computeLineageSha256: async () => hash(bytes),
    })).rejects.toThrow(/path key/i)
  })

  test('returns channels_patched_no_baseline for live 2.1.217 without writing any asset', async () => {
    const root = await tempStore()
    const targetDir = path.join(root, 'empty-test-store')
    const result = await assessBaselineCreation(targetDir, '2.1.217', {
      'source-exec': 'patched', 'agent-model': 'patched', channels: 'patched',
    })
    expect(result).toEqual({ accepted: false, code: 'channels_patched_no_baseline', exit: 1 })
    expect(storeCases.crash_residue.orphan_blob.active).toBe(false)
    expect(storeExpected.orphan_blob).toEqual({ active: false, ignored: true })
    await expect(stat(targetDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('classifies clean, mixed, unsupported, and existing baseline creation states', async () => {
    const root = await tempStore()
    const targetDir = path.join(root, 'target')
    const clean = { 'source-exec': 'clean', 'agent-model': 'clean', channels: 'clean' }
    expect(await assessBaselineCreation(targetDir, '2.1.217', clean)).toEqual({ accepted: true, existing: false })
    expect(await assessBaselineCreation(targetDir, '2.1.217', { ...clean, 'agent-model': 'mixed' })).toEqual({
      accepted: false, code: 'unsupported_or_mixed_no_baseline', exit: 1,
    })
    expect(await assessBaselineCreation(targetDir, '2.1.217', { ...clean, 'source-exec': 'unsupported' })).toEqual({
      accepted: false, code: 'unsupported_or_mixed_no_baseline', exit: 1,
    })
    await Bun.write(path.join(targetDir, 'baselines', '2.1.217', 'baseline.json'), '{}')
    expect(await assessBaselineCreation(targetDir, '2.1.217', clean)).toEqual({ accepted: true, existing: true })
  })
})