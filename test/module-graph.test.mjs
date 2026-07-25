// test/module-graph.test.mjs — 长度敏感正确性 oracle：整块解析/自证，非只看头 magic。
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { defaultBinary } from '../lib/bun-binary.mjs'
import { parseModuleGraph } from '../lib/module-graph.mjs'
import { Parser } from 'acorn'

test('parses module graph; blobs validate by FULL-slice parse (length-sensitive)', () => {
  const bin = defaultBinary()
  const buf = readFileSync(bin) // 独立 oracle：全读整块自行切片校验（P4 后 readBinary 不再全读，测试侧自读）
  const { blobs } = parseModuleGraph(bin)
  expect(blobs.length).toBeGreaterThan(2)
  const slice = (b) => buf.subarray(b.offset, b.offset + b.length)
  // app cli.js blob：整块必须 acorn 可解析。截断→SyntaxError；超长→尾部混入下一 blob 字节→SyntaxError。
  // 这同时验 offset 与 length（B1 修复：绝不能只看 subarray(0,64)）。
  const app = blobs.find((b) => slice(b).subarray(0, 64).toString('latin1').includes('@bun-cjs'))
  expect(app).toBeTruthy()
  const appSrc = slice(app).toString('utf8')
  expect(() => Parser.parse(appSrc, { ecmaVersion: 'latest' })).not.toThrow() // 长度对才解析成功
  expect(appSrc.trimEnd().endsWith('})')).toBe(true)                          // 收在外层 wrapper 闭合
  // .node ELF blob：用 ELF 自证大小验 length —— section 表尾必须 ≤ 本 blob 长度且贴合
  const natives = blobs.filter((b) => slice(b).subarray(0, 4).toString('latin1') === '\x7fELF')
  expect(natives.length).toBeGreaterThanOrEqual(2)
  for (const n of natives) {
    const s = slice(n)
    const shoff = Number(s.readBigUInt64LE(0x28))
    const shentsize = s.readUInt16LE(0x3a)
    const shnum = s.readUInt16LE(0x3c)
    expect(shoff + shentsize * shnum).toBeLessThanOrEqual(n.length)          // length 不足→越界；length 大幅超→松（配相邻连续性）
  }
  // 相邻 blob 边界连续性（无缝隙/无重叠）——进一步锁死 length
  const sorted = [...blobs].sort((a, b) => a.offset - b.offset)
  for (let i = 1; i < sorted.length; i++) {
    expect(sorted[i].offset).toBeGreaterThanOrEqual(sorted[i - 1].offset + sorted[i - 1].length)
  }
})
