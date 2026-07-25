import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { sourceExecFeature } from '../../lib/patch/targets/claude/source-exec.mjs'

const ROOT = path.resolve(import.meta.dir, '../..')
const VECTOR_ROOT = path.join(ROOT, 'contract', 'vectors', 'feature-claude-v1', 'fixtures')
const FIXTURE_ROOT = path.join(ROOT, 'exp', 'exact-replay', 'fixtures')
const input = JSON.parse(readFileSync(path.join(VECTOR_ROOT, 'source-exec-input.json'), 'utf8'))
const expected = JSON.parse(readFileSync(path.join(VECTOR_ROOT, 'source-exec-expected.json'), 'utf8'))
const cleanGolden = readFileSync(path.join(ROOT, 'contract', 'golden', 'claude-v1', 'synthetic-2.1.175-clean.bin'))

function bytes(parts) {
  return Buffer.from(parts.join('|'), 'latin1')
}

describe('source-exec feature', () => {
  test('matches every frozen state vector and reports every site', () => {
    const states = input.cases.find((entry) => entry.id === 'states').inputs
    for (const [name, segments] of Object.entries(states)) {
      expect(sourceExecFeature.detect(bytes(segments))).toEqual(expected.results[name])
    }
  })

  test('probes both discovery ends and detects absolute offsets in windows', () => {
    expect(sourceExecFeature.probe_windows({ size: 80_000_000 })).toEqual([[0, 32_000_000], [48_000_000, 80_000_000]])
    const windows = [
      { offset: 0, bytes: Buffer.concat([Buffer.alloc(32), Buffer.from('// @bun @bytecode', 'latin1')]) },
      { offset: 79_999_000, bytes: Buffer.from('// @bun @bytecode', 'latin1') },
    ]
    expect(sourceExecFeature.detect_windows(windows)).toEqual(expected.results['first-tail-multi-tag'])
  })

  test('apply and reverse are equal-length, immutable by default, and optionally mutable', () => {
    const original = bytes(['// @bun @bytecode', '// @bun @source__'])
    const snapshot = Buffer.from(original)
    const applied = sourceExecFeature.apply(original)
    expect(original).toEqual(snapshot)
    expect(applied.bytes.length).toBe(original.length)
    expect(sourceExecFeature.detect(applied.bytes)).toEqual({ state: 'patched', sites: 2 })
    expect(sourceExecFeature.reverse(applied.bytes).bytes).toEqual(bytes(['// @bun @bytecode', '// @bun @bytecode']))

    const mutable = Buffer.from('// @bun @bytecode', 'latin1')
    const result = sourceExecFeature.apply(mutable, { mutate: true })
    expect(result.bytes).toBe(mutable)
    expect(mutable.toString('latin1')).toBe('// @bun @source__')

    const replayMutable = bytes(['// @bun @bytecode', '// @bun @bytecode'])
    const desired = sourceExecFeature.observe_substates(applied.bytes)
    expect(sourceExecFeature.replay_substates(replayMutable, desired, { mutate: true }).bytes).toBe(replayMutable)
    expect(replayMutable).toEqual(applied.bytes)
  })

  test('observes and exactly replays mixed substates', () => {
    const mixed = bytes(['// @bun @bytecode', '// @bun @source__'])
    const observed = sourceExecFeature.observe_substates(mixed)
    expect(observed).toEqual([
      { id: 'source-exec:tag:0', offset: 7, length: 10, state: 'clean' },
      { id: 'source-exec:tag:1', offset: 25, length: 10, state: 'patched' },
    ])
    expect(sourceExecFeature.replay_substates(bytes(['// @bun @bytecode', '// @bun @bytecode']), observed).bytes).toEqual(mixed)
    expect(() => sourceExecFeature.replay_substates(mixed, [{ ...observed[0], state: 'unknown' }, observed[1]])).toThrow('substate_unreplayable')
  })

  test('matches the pinned source-exec fixture byte for byte', () => {
    const pinned = readFileSync(path.join(FIXTURE_ROOT, 'synthetic-2.1.175-target-source-exec.bin'))
    const actual = sourceExecFeature.apply(cleanGolden).bytes
    expect(actual).toEqual(pinned)
    expect(sourceExecFeature.reverse(actual).bytes).toEqual(cleanGolden)
  })
})