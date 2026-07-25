import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { channelsFeature } from '../../lib/patch/targets/claude/channels.mjs'
import { claudeFeatureRegistry } from '../../lib/patch/targets/claude/index.mjs'
import { sourceExecFeature } from '../../lib/patch/targets/claude/source-exec.mjs'
import { closeFeatures } from '../../lib/patch/core/dependencies.mjs'

const ROOT = path.resolve(import.meta.dir, '../..')
const VECTOR_ROOT = path.join(ROOT, 'contract', 'vectors', 'feature-claude-v1', 'fixtures')
const FIXTURE_ROOT = path.join(ROOT, 'exp', 'exact-replay', 'fixtures')
const input = JSON.parse(readFileSync(path.join(VECTOR_ROOT, 'channels-input.json'), 'utf8'))
const expected = JSON.parse(readFileSync(path.join(VECTOR_ROOT, 'channels-expected.json'), 'utf8'))
const cleanGolden = readFileSync(path.join(ROOT, 'contract', 'golden', 'claude-v1', 'synthetic-2.1.175-clean.bin'))

function support({ feature = 'clean', permissions = 'clean', capStrip = 'clean' } = {}) {
  return [
    feature === 'absent' ? '' : input.support[`essential_${feature}`],
    permissions === 'absent' ? '' : input.support[`permissions_${permissions}`],
    capStrip === 'absent' ? '' : input.support[`cap_strip_${capStrip}`],
  ].filter(Boolean).join(';')
}

function binary(decision, options) {
  return Buffer.from(`${decision};${support(options)}`, 'latin1')
}

describe('claude target registry', () => {
  test('registers the revised frozen dependency graph without touching legacy production paths', () => {
    expect(claudeFeatureRegistry.names()).toEqual(['source-exec', 'agent-model', 'channels'])
    expect(Object.fromEntries(claudeFeatureRegistry.features().map((feature) => [feature.name, feature.requires]))).toEqual({
      'source-exec': [],
      'agent-model': [],
      channels: ['source-exec'],
    })
  })
})

describe('channels feature', () => {
  test('finds the real decision and skips every tail register decoy', () => {
    const cases = [
      ['tail_register_decoy', 1],
      ['multiple_decoys', 2],
    ]
    for (const [name, decoys] of cases) {
      const decision = input[name].replace('REAL_DECISION', input.decision_clean)
      expect(channelsFeature.detect(binary(decision))).toEqual({ ...expected[name], decoys_skipped: decoys })
    }
  })

  test('classifies essential absence separately from optional best-effort absence', () => {
    expect(channelsFeature.detect(binary(input.decision_clean, { feature: 'absent' }))).toMatchObject(expected.essential_feature_flag_missing)
    expect(channelsFeature.detect(binary(input.decision_clean, { permissions: 'absent' }))).toMatchObject(expected.permissions_absent)
    expect(channelsFeature.detect(binary(input.decision_clean, { capStrip: 'absent' }))).toMatchObject(expected.cap_strip_absent)
  })

  test('reports clean, patched, and mixed best-effort substates', () => {
    expect(channelsFeature.detect(binary(input.decision_clean))).toMatchObject({ state: 'clean' })
    expect(channelsFeature.detect(binary(input.decision_patched, { feature: 'patched', permissions: 'patched', capStrip: 'patched' }))).toMatchObject({ state: 'patched' })
    const mixed = binary(input.decision_patched, { feature: 'clean', permissions: 'patched', capStrip: 'clean' })
    const observed = channelsFeature.observe_substates(mixed)
    expect(Object.fromEntries(observed.map(({ id, state }) => [id, state]))).toEqual({
      'channels:decision:0': 'patched',
      'channels:feature-flag:0': 'clean',
      'channels:permissions:0': 'patched',
      'channels:cap-strip:0': 'clean',
    })
    expect(channelsFeature.detect(mixed)).toMatchObject({ state: 'mixed', sites: 4 })
  })

  test('apply changes all owned sites only and preserves the input by default', () => {
    const original = binary(input.decision_clean)
    const snapshot = Buffer.from(original)
    const applied = channelsFeature.apply(original)
    expect(original).toEqual(snapshot)
    expect(applied.bytes.length).toBe(original.length)
    expect(channelsFeature.detect(applied.bytes).state).toBe('patched')
    expect(applied.edits).toBe(4)

    const withSource = Buffer.concat([Buffer.from('// @bun @bytecode;'), original])
    const channelsOnly = channelsFeature.apply(withSource).bytes
    expect(channelsOnly.toString('latin1')).toContain('// @bun @bytecode')

    const mutable = binary(input.decision_clean)
    expect(channelsFeature.apply(mutable, { mutate: true }).bytes).toBe(mutable)
    expect(channelsFeature.detect(mutable).state).toBe('patched')
  })

  test('detects and applies every repeated owned site', () => {
    const repeated = Buffer.from(`${input.decision_clean};${input.decision_clean};${support()};${support()}`, 'latin1')
    const observed = channelsFeature.observe_substates(repeated)
    expect(observed.filter(({ id }) => id.startsWith('channels:decision:'))).toHaveLength(2)
    expect(observed.filter(({ id }) => id.startsWith('channels:feature-flag:'))).toHaveLength(2)
    expect(observed.filter(({ id }) => id.startsWith('channels:permissions:'))).toHaveLength(2)
    expect(observed.filter(({ id }) => id.startsWith('channels:cap-strip:'))).toHaveLength(2)
    expect(channelsFeature.detect(repeated).sites).toBe(8)
    const applied = channelsFeature.apply(repeated)
    expect(applied.edits).toBe(8)
    expect(channelsFeature.detect(applied.bytes).state).toBe('patched')
  })

  test('exactly replays mixed channels substates from the clean baseline', () => {
    const manifest = JSON.parse(readFileSync(path.join(FIXTURE_ROOT, 'manifest.json'), 'utf8'))
    const mixed = readFileSync(path.join(FIXTURE_ROOT, manifest.fixtures['mixed-replayable'].path))
    const observed = channelsFeature.observe_substates(mixed)
    expect(Object.fromEntries(observed.map(({ id, state }) => [id, state]))).toEqual({
      'channels:decision:0': 'patched',
      'channels:feature-flag:0': 'clean',
      'channels:permissions:0': 'patched',
      'channels:cap-strip:0': 'clean',
    })
    const replayed = channelsFeature.replay_substates(cleanGolden, observed).bytes
    const sourceReplayed = sourceExecFeature.replay_substates(replayed, sourceExecFeature.observe_substates(mixed)).bytes
    expect(sourceReplayed).toEqual(mixed)
    expect(() => channelsFeature.replay_substates(cleanGolden, [{ id: 'decision', offset: 999999, length: 1, state: 'patched' }])).toThrow('substate_unreplayable')

    const patched = channelsFeature.apply(Buffer.from(cleanGolden)).bytes
    const reverseDecision = channelsFeature.observe_substates(patched).map((site) => site.id.startsWith('channels:decision:') ? { ...site, state: 'clean' } : site)
    expect(() => channelsFeature.replay_substates(patched, reverseDecision)).toThrow('decision cannot be reversed')
  })

  test('matches every pinned target-set output byte for byte', () => {
    const manifest = JSON.parse(readFileSync(path.join(FIXTURE_ROOT, 'manifest.json'), 'utf8'))
    for (const target of manifest.target_sets) {
      const closed = closeFeatures(claudeFeatureRegistry, target.request_set)
      expect(closed).toEqual(target.closed_set)
      let actual = Buffer.from(cleanGolden)
      for (const name of closed) actual = claudeFeatureRegistry.get(name).apply(actual).bytes
      const pinned = readFileSync(path.resolve(FIXTURE_ROOT, manifest.fixtures[target.fixture].path))
      expect(actual, target.fixture).toEqual(pinned)
    }
  })
})