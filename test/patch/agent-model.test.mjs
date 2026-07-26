import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { agentModelFeature } from '../../lib/patch/targets/claude/agent-model.mjs'

const ROOT = path.resolve(import.meta.dir, '../..')
const VECTOR_ROOT = path.join(ROOT, 'contract', 'vectors', 'feature-claude-v1', 'fixtures')
const FIXTURE_ROOT = path.join(ROOT, 'exp', 'exact-replay', 'fixtures')
const input = JSON.parse(readFileSync(path.join(VECTOR_ROOT, 'agent-model-input.json'), 'utf8'))
const expected = JSON.parse(readFileSync(path.join(VECTOR_ROOT, 'agent-model-expected.json'), 'utf8'))
const cleanGolden = readFileSync(path.join(ROOT, 'contract', 'golden', 'claude-v1', 'synthetic-2.1.175-clean.bin'))

describe('agent-model feature', () => {
  test('defeats the frozen hardcoded-E known-bad receiver', () => {
    const knownBad = readFileSync(path.join(ROOT, 'contract', 'vectors', 'known-bad-v1', 'fixtures', 'hardcoded-receiver-s.txt'))
    expect(agentModelFeature.detect(knownBad)).toEqual(expected.variants['receiver-s'])
    const applied = agentModelFeature.apply(knownBad)
    expect(applied.bytes.toString('latin1')).toContain('model:S.string()')
    expect(applied.bytes.length).toBe(knownBad.length)
    expect(agentModelFeature.reverse(applied.bytes).bytes).toEqual(knownBad)
  })

  test('supports every audited receiver and preserves it exactly', () => {
    for (const variant of input.audited_variants) {
      const original = Buffer.from(variant.ascii, 'latin1')
      const snapshot = Buffer.from(original)
      expect(agentModelFeature.detect(original)).toEqual(expected.variants[variant.id])
      const applied = agentModelFeature.apply(original)
      expect(original).toEqual(snapshot)
      expect(applied.bytes.length).toBe(original.length)
      expect(applied.bytes.toString('latin1')).toStartWith(expected.variants[variant.id].replacement_prefix)
      expect(agentModelFeature.reverse(applied.bytes).bytes).toEqual(original)
    }

    const mutable = Buffer.from(input.audited_variants[0].ascii, 'latin1')
    expect(agentModelFeature.apply(mutable, { mutate: true }).bytes).toBe(mutable)
    expect(mutable.toString('latin1')).toContain('model:E.string()')
  })

  test('anchors only through the stable agent describe prefix and reports core-only wire sites', () => {
    const clean = Buffer.from('model:S.enum(["sonnet","opus","haiku","fable"]).optional().describe(`Optional model override for this agent. Takes precedence over changing copy`)', 'latin1')
    const observed = agentModelFeature.observe_substates(clean)
    expect(observed).toEqual([
      { id: 'agent-model:schema:0', offset: 8, length: 39, receiver: 'S', state: 'clean' },
    ])

    const patched = agentModelFeature.apply(clean).bytes
    expect(agentModelFeature.observe_substates(patched)).toEqual([
      { id: 'agent-model:schema:0', offset: 8, length: 39, receiver: 'S', state: 'patched' },
    ])
    // 单站点窗口必须直接给出结论，且 offset 是绝对值（窗口 offset + 窗内 offset）。此前这里
    // 断言返回 null——即靠回落 full detect 掩盖 windowed/full 的 substate id 分歧，代价是每次
    // 探测整读整个二进制。分歧已在 probe.mjs 的序号归一化处修掉，守卫随之移除。
    expect(agentModelFeature.detect_windows([{ offset: 1000, bytes: patched }]))
      .toEqual({ state: 'patched', sites: [1008] })
  })

  test('rejects unknown variants and discovers every exact suffix', () => {
    expect(agentModelFeature.detect(Buffer.from(input.unknown_variant, 'latin1'))).toEqual(expected.variants['unknown-variant'])
    expect(() => agentModelFeature.apply(Buffer.from(input.unknown_variant, 'latin1'))).toThrow('agent_model_variant_unsupported')
    const multiple = Buffer.from(input.multiple_suffixes, 'latin1')
    expect(agentModelFeature.detect(multiple)).toEqual(expected.variants['multiple-suffixes'])
    expect(agentModelFeature.observe_substates(multiple)).toHaveLength(2)
  })

  test('replays mixed receiver-independent substates and rejects drift', () => {
    const clean = Buffer.from(input.multiple_suffixes, 'latin1')
    const firstPatched = agentModelFeature.apply(Buffer.from(input.audited_variants[0].ascii, 'latin1')).bytes
    const mixed = Buffer.concat([firstPatched, Buffer.from(';'), Buffer.from(input.audited_variants[1].ascii, 'latin1')])
    const observed = agentModelFeature.observe_substates(mixed)
    expect(observed.map(({ receiver, state }) => [receiver, state])).toEqual([['E', 'patched'], ['S', 'clean']])
    expect(agentModelFeature.replay_substates(clean, observed).bytes).toEqual(mixed)
    expect(() => agentModelFeature.replay_substates(Buffer.from(input.unknown_variant, 'latin1'), observed)).toThrow('substate_unreplayable')

    const swapped = Buffer.from(`${input.audited_variants[1].ascii};${input.audited_variants[0].ascii}`, 'latin1')
    const swappedObserved = agentModelFeature.observe_substates(swapped)
    const forged = swappedObserved.map((site, index) => ({ ...site, receiver: observed[index].receiver }))
    expect(() => agentModelFeature.replay_substates(swapped, forged)).toThrow('receiver mismatch')
  })

  test('matches the pinned agent-model fixture byte for byte', () => {
    const pinned = readFileSync(path.join(FIXTURE_ROOT, 'synthetic-2.1.175-target-agent-model.bin'))
    const actual = agentModelFeature.apply(cleanGolden).bytes
    expect(actual).toEqual(pinned)
    expect(agentModelFeature.reverse(actual).bytes).toEqual(cleanGolden)
  })

  test('fails closed on the pinned unreplayable mixed variant', () => {
    const unreplayable = readFileSync(path.join(FIXTURE_ROOT, 'synthetic-2.1.175-mixed-unreplayable.bin'))
    expect(agentModelFeature.detect(unreplayable)).toMatchObject({ state: 'unsupported', code: 'agent_model_variant_unsupported' })
    expect(() => agentModelFeature.replay_substates(cleanGolden, agentModelFeature.observe_substates(unreplayable))).toThrow('substate_unreplayable')
  })
})