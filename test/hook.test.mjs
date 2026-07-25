// test/hook.test.mjs — 等长 loader-hook 打桩器（纯字节）正确性 + 守卫。
// 合成含锚点的 buffer（无需真 bun 二进制）：验等长不变、命中偏移、payload 覆盖、
// 多锚点全替换，以及三条守卫（payload 超锚点长度→抛、锚点后非 \n→抛）。anchor 参数化
// 用自己的 `//!` 锚证明 fixture 路径（Task 4.2 不对称锚）也走同一纯函数。
import { test, expect } from 'bun:test'
import { patchLoaderHook, CC_ANCHOR, CC_PAYLOAD } from '../lib/hook.mjs'

test('equal-length patch preserves size; rejects when payload too long', () => {
  const anchor = Buffer.from(CC_ANCHOR + '\n')
  const buf = Buffer.concat([Buffer.from('AAAA'), anchor, Buffer.from('BBBB')])
  const { patched, sites } = patchLoaderHook(Buffer.from(buf), { force: true })
  expect(patched.length).toBe(buf.length) // 等长不变
  expect(sites.length).toBe(1)
  expect(sites[0]).toBe(4) // 'AAAA' 之后
  expect(patched.toString('latin1')).toContain(CC_PAYLOAD)
  expect(CC_PAYLOAD.length).toBeLessThanOrEqual(CC_ANCHOR.length) // 守卫前提
})

test('preserves the trailing \\n and does not mutate the caller buffer', () => {
  const anchor = Buffer.from(CC_ANCHOR + '\n')
  const src = Buffer.concat([Buffer.from('AAAA'), anchor, Buffer.from('BBBB')])
  const copy = Buffer.from(src)
  const { patched } = patchLoaderHook(copy, { force: true })
  // 行尾 \n 原位保留（锚点长度处仍是 0x0a）
  expect(patched[4 + CC_ANCHOR.length]).toBe(0x0a)
  // 纯函数不改入参 buffer
  expect(copy.equals(src)).toBe(true)
})

test('patches every anchor occurrence (multi-site)', () => {
  const a = Buffer.from(CC_ANCHOR + '\n')
  const buf = Buffer.concat([Buffer.from('XX'), a, Buffer.from('YY'), a, Buffer.from('ZZ')])
  const { patched, sites } = patchLoaderHook(Buffer.from(buf), { force: true })
  expect(patched.length).toBe(buf.length)
  expect(sites.length).toBe(2)
  expect(sites[0]).toBe(2)
  expect(sites[1]).toBe(2 + CC_ANCHOR.length + 1 + 2) // XX + anchor + \n + YY
  // 两处都替换 → payload 出现两次
  const hay = patched.toString('latin1')
  expect(hay.split(CC_PAYLOAD).length - 1).toBe(2)
})

test('no anchor → empty sites, buffer unchanged (CLI decides if that is an error)', () => {
  const buf = Buffer.from('no anchor here at all')
  const { patched, sites } = patchLoaderHook(Buffer.from(buf), { force: true })
  expect(sites.length).toBe(0)
  expect(patched.equals(buf)).toBe(true)
})

test('throws when the byte right after the anchor is not \\n', () => {
  // 锚点后紧跟 'X' 而非换行 → 拒绝打桩（防打到被改写/错位的构建）
  const buf = Buffer.concat([Buffer.from('AAAA'), Buffer.from(CC_ANCHOR), Buffer.from('X')])
  expect(() => patchLoaderHook(Buffer.from(buf), { force: true })).toThrow()
})

test('throws when payload is longer than anchor (cannot keep equal length)', () => {
  const anchor = '//!'
  const payload = 'this-payload-is-way-too-long'
  const buf = Buffer.concat([Buffer.from(anchor), Buffer.from('\n')])
  expect(() => patchLoaderHook(Buffer.from(buf), { anchor, payload })).toThrow()
})

test('anchor/payload are parameterizable (fixture uses its own //! anchor)', () => {
  const anchor = "//! fixture loader-hook anchor placeholder text here padding"
  const payload = 'globalThis.__CC_EXT_HOOKED__=true'
  expect(payload.length).toBeLessThanOrEqual(anchor.length)
  const buf = Buffer.concat([Buffer.from('head'), Buffer.from(anchor + '\n'), Buffer.from('tail')])
  const { patched, sites } = patchLoaderHook(Buffer.from(buf), { anchor, payload })
  expect(patched.length).toBe(buf.length)
  expect(sites.length).toBe(1)
  expect(patched.toString('latin1')).toContain(payload)
  // 默认真 claude 锚在此 buffer 里不存在 → 用默认锚则零命中
  const { sites: none } = patchLoaderHook(Buffer.from(buf))
  expect(none.length).toBe(0)
})
