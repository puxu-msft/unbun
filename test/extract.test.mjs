// test/extract.test.mjs — app-bundle 抽取正确性 + 美化增行 + version best-effort。
// 权威切靠 module-graph 精确 offset/length（非启发式扫描），故 slice 头含 @bun-cjs、
// 长度 >5MB（cli.js ~19MB）；beautify 用真 esbuild 反 minify → 行数必增；version 若命中
// Claude 唯一锚（FINDINGS P0-d）须是 x.y.z，无锚回落 null（best-effort，不阻塞）。
import { test, expect } from 'bun:test'
import { defaultBinary } from '../lib/bun-binary.mjs'
import { extractApp } from '../lib/extract.mjs'
import { beautify } from '../lib/beautify.mjs'

test('extracts app bundle that re-parses; version best-effort', async () => {
  const { app, version } = extractApp(defaultBinary())
  expect(app.slice(0, 64)).toContain('@bun-cjs')
  expect(app.length).toBeGreaterThan(5_000_000)
  const pretty = await beautify(app)
  expect(pretty.split('\n').length).toBeGreaterThan(app.split('\n').length) // 美化增行
  // defaultBinary() 即 claude 二进制，P0-d 唯一锚必然存在 → 断言非 null（防锚回归静默变绿·非空测），
  // 且须是 x.y.z。通用 SFX 无此锚时 parseVersion best-effort 返回 null，但那不走本用例。
  expect(version).not.toBeNull()
  expect(version).toMatch(/^\d+\.\d+\.\d+$/)
}, 30_000) // 真二进制提取 + esbuild 异步美化约 5s；给并发测试负载留余量。
