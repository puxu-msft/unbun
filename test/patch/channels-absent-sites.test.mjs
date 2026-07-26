// test/patch/channels-absent-sites.test.mjs — L3B-03 回归：channels 的 observe/replay 站点集合必须同源。
//
// Blocker 原状：`observe_substates` 走 `records()`（optional 站点缺失时补 `absent` 占位），而
// `replay_substates` 走 `recordsFromSites()`（无占位）。两者长度不等 → `validateReplay` 必抛
// `substate_unreplayable`。后果远超 channels 自身：缺 `permissions` 站点的二进制会在
// `runPatchTransaction` 的 exact-replay 校验中被 `baseline_stale_build` 拒绝，**连 agent-model 这种
// 与 channels 无关的 feature 也写不进去**；而 Python（channels.py 的 allow_absent=True）没有这个
// 限制，构成跨实现行为分歧。
//
// 这里锁住的是 replay 的**自反性**：把 observe_substates 的输出原样喂回 replay_substates 必须成功
// 且零改动。这是 replay 契约的基本性质，此前完全没有测试覆盖。
import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'

import { claudeFeatureRegistry } from '../../lib/patch/targets/claude/index.mjs'

const clean = await readFile(new URL('../../contract/golden/claude-v1/synthetic-2.1.175-clean.bin', import.meta.url))
const channels = claudeFeatureRegistry.get('channels')

// 等长破坏某个 optional 站点的锚字符串 → 该站点在 locate 中消失，observe 会补 absent 占位。
function withoutSite(marker) {
  const at = clean.toString('latin1').indexOf(marker)
  expect(at).toBeGreaterThan(0)
  const variant = Buffer.from(clean)
  variant.write('X'.repeat(marker.length), at, 'latin1')
  return variant
}

describe('channels optional-site absence (L3B-03)', () => {
  test('replay accepts its own observation on a fully populated build', () => {
    const observed = channels.observe_substates(clean)
    expect(observed.some((site) => site.state === 'absent')).toBe(false)

    const result = channels.replay_substates(Buffer.from(clean), observed)
    expect(result.edits).toBe(0)
    expect(result.bytes.equals(clean)).toBe(true)
  })

  for (const [label, marker] of [
    ['permissions', 'tengu_harbor_permissions'],
    ['cap-strip', 'tengu_harbor'],
  ]) {
    test(`replay accepts its own observation when the optional ${label} site is missing`, () => {
      const variant = withoutSite(marker)
      const observed = channels.observe_substates(variant)

      // 站点集合形状保持稳定：缺失的 optional 站点以 absent 占位出现，而不是整体消失。
      expect(observed.length).toBeGreaterThan(0)
      expect(observed.some((site) => site.state === 'absent')).toBe(true)

      // 自反性：observe 的输出必须是 replay 的合法输入（此前这里抛 substate_unreplayable）。
      const result = channels.replay_substates(Buffer.from(variant), observed)
      expect(result.edits).toBe(0)
      expect(result.bytes.equals(variant)).toBe(true)
    })
  }

  test('an absent placeholder is rejected when the site is actually present', () => {
    // 反向守卫：absent 只在 current 也确实缺失时合法，不能用它把真实站点谎报成缺失而跳过校验。
    const observed = channels.observe_substates(clean)
    const forged = observed.map((site, index) => (index === 0 ? { ...site, state: 'absent' } : site))

    expect(() => channels.replay_substates(Buffer.from(clean), forged)).toThrow(/absent/)
  })

  test('an absent placeholder replays regardless of its offset', () => {
    // absent 占位不对应任何字节：replay 遇到它直接跳过，从不读它的 offset/length。但占位的
    // offset 取自 `bytes.length`，会随输入长度漂移——窗口化观测得到的是窗口末端，full detect
    // 得到的是整个二进制的长度。让这个**无语义**的数值参与 validateReplay 的严格相等校验，
    // 会在 optional 站点缺失的 build 上抛 substate_unreplayable，阻断所有 feature 的写入。
    // 因此 absent 记录只校验 identity 与「双方都缺失」，不校验 offset/length。
    const variant = withoutSite('tengu_harbor_permissions')
    const observed = channels.observe_substates(variant)
    const drifted = observed.map((site) => (site.state === 'absent' ? { ...site, offset: site.offset + 1_000_000 } : site))

    const result = channels.replay_substates(Buffer.from(variant), drifted)
    expect(result.edits).toBe(0)
    expect(result.bytes.equals(variant)).toBe(true)
  })
})
