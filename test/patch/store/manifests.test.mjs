import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'

import {
  StoreError,
  parseManifest,
  validateAssetManifest,
  validateManifest,
} from '../../../lib/patch/store/manifests.mjs'

const HASH = 'a'.repeat(64)
const OTHER_HASH = 'b'.repeat(64)
const CREATED_AT = '2026-07-23T12:34:56.000Z'

const samples = {
  target: {
    schema: 'unbun.cc.target', schema_version: 1, path_key: HASH,
    canonical_path: '/opt/claude/2.1.217', display_name: 'claude', created_at: CREATED_AT,
  },
  baseline: {
    schema: 'unbun.cc.baseline', schema_version: 1, feature_contract: 'claude-v1', path_key: HASH,
    embedded_version: '2.1.217', blob: `blobs/${OTHER_HASH}.ccbak`, sha256: OTHER_HASH,
    lineage_algorithm: 'claude-v1-exact-replay', lineage_sha256: HASH, size: 4,
    states: { 'source-exec': 'clean', 'agent-model': 'clean', channels: 'clean' },
    created_at: CREATED_AT, created_by: 'js', optional_diagnostic: true,
  },
  snapshot: {
    schema: 'unbun.cc.snapshot', schema_version: 1, feature_contract: 'claude-v1', path_key: HASH,
    embedded_version: '2.1.217', slug: 'before-change', blob: `blobs/${OTHER_HASH}.ccsnap`,
    sha256: OTHER_HASH, size: 4,
    observed_states: { 'source-exec': 'patched', 'agent-model': 'patched', channels: 'clean' },
    created_at: CREATED_AT, created_by: 'js',
  },
  'lock-owner': {
    schema: 'unbun.cc.lock-owner', schema_version: 1, token: '123e4567-e89b-42d3-a456-426614174000',
    implementation: 'js', pid: 123, hostname: 'host', started_at: CREATED_AT, command: 'patch',
  },
  quarantine: {
    schema: 'unbun.cc.quarantine', schema_version: 1,
    original_path: `baselines/2.1.217/blobs/${OTHER_HASH}.ccbak`, reason: 'baseline_hash_mismatch',
    observed_sha256: OTHER_HASH, discovered_at: CREATED_AT, discovered_by: 'js',
  },
}

describe('shared store manifests', () => {
  for (const [type, sample] of Object.entries(samples)) {
    test(`validates ${type} through the contract schema`, () => {
      expect(validateManifest(type, sample)).toEqual(sample)
    })
  }

  test('rejects BOM, non-object roots, missing fields, wrong types, traversal, and higher versions', () => {
    expect(() => parseManifest(`\ufeff${JSON.stringify(samples.baseline)}`, 'baseline')).toThrow(/BOM/)
    expect(() => parseManifest(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(samples.baseline))]), 'baseline')).toThrow(/BOM/)
    expect(() => parseManifest('[]', 'baseline')).toThrow(StoreError)
    const missing = structuredClone(samples.baseline)
    delete missing.schema_version
    expect(() => validateManifest('baseline', missing)).toThrow(expect.objectContaining({ code: 'baseline_invalid', exitCode: 2 }))
    expect(() => validateManifest('baseline', { ...samples.baseline, size: '4' })).toThrow(expect.objectContaining({ code: 'baseline_invalid' }))
    expect(() => validateManifest('baseline', { ...samples.baseline, blob: '../escape.ccbak' })).toThrow(expect.objectContaining({ code: 'baseline_invalid' }))
    expect(() => validateManifest('baseline', { ...samples.baseline, schema_version: 2 })).toThrow(expect.objectContaining({ code: 'store_version_unsupported', exitCode: 1 }))
  })

  test('rejects byte input that is not strict UTF-8', () => {
    const encoded = Buffer.from(JSON.stringify(samples.target))
    const marker = encoded.indexOf(Buffer.from('claude'))
    encoded[marker] = 0xff
    expect(() => parseManifest(encoded, 'target')).toThrow(expect.objectContaining({ code: 'target_identity_mismatch' }))
  })

  test('revalidates baseline content, directory identity, version and clean states', async () => {
    const bytes = Buffer.from('test')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const manifest = {
      ...samples.baseline,
      blob: `blobs/${sha256}.ccbak`, sha256, lineage_sha256: sha256,
    }
    const options = {
      directoryVersion: '2.1.217', pathKey: HASH,
      inspect: async () => ({ embeddedVersion: '2.1.217', states: manifest.states }),
      computeLineageSha256: async () => sha256,
    }
    await expect(validateAssetManifest('baseline', manifest, bytes, options)).resolves.toEqual(manifest)
    await expect(validateAssetManifest('baseline', { ...manifest, size: 5 }, bytes, options)).rejects.toMatchObject({ code: 'baseline_invalid' })
    await expect(validateAssetManifest('baseline', manifest, Buffer.from('drift'), options)).rejects.toMatchObject({ code: 'baseline_invalid' })
    await expect(validateAssetManifest('baseline', manifest, bytes, { ...options, directoryVersion: '2.1.216' })).rejects.toMatchObject({ code: 'baseline_invalid' })
    await expect(validateAssetManifest('baseline', manifest, bytes, {
      ...options,
      inspect: async () => ({ embeddedVersion: '2.1.217', states: { ...manifest.states, channels: 'patched' } }),
    })).rejects.toMatchObject({ code: 'baseline_invalid' })
  })
})

export { CREATED_AT, HASH }