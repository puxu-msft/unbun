// test/cli-split.test.mjs — split 子命令：把 app bundle 切成 per-module 文件 + index.json。
// 真 claude 二进制纯读一次（beforeAll 缓存 app），写进临时 app.js 走「已提取 app.js 输入」分支，
// split 到自建临时 outdir。断言结构 / 行为（index.count 自洽、落盘文件数 === count、每条记录字段
// 合理、抽样模块可被独立 oracle acorn 重解析、esm+cjs 两 kind 皆有），**绝不 byte-pin 专有文案**。
// 临时目录用 mkdtempSync，afterAll 只清自己建的。
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Parser } from 'acorn'
import { extractApp } from '../lib/extract.mjs'
import { defaultBinary } from '../lib/bun-binary.mjs'
import { runSplit } from '../cli.mjs'

const created = []
function tmp(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix))
  created.push(d)
  return d
}
afterAll(() => {
  for (const d of created) rmSync(d, { recursive: true, force: true })
})

// 读 257MB binary + 权威切 ~19MB 一次，缓存 app 供各例复用（split 内部仍解析一次 ~19MB，可接受）。
let app
beforeAll(() => {
  app = extractApp(defaultBinary()).app
})

const smallBundle = (handles) => `(function(exports){var h=(e,t)=>()=>(e&&(t=e(e=0)),t);var ${handles.map((h, i) => `${h}=h(()=>${i})`).join(',')};})`

function snapshotDir(dir) {
  return Object.fromEntries(readdirSync(dir).sort().map((name) => [name, readFileSync(join(dir, name))]))
}

test('split rerun atomically replaces the generation and removes stale module files', async () => {
  const parent = tmp('unbun-split-rerun-')
  const out = join(parent, 'modules')
  await runSplit({ app: smallBundle(['a', 'b', 'c']), version: '1.0.0', outdir: out })
  await runSplit({ app: smallBundle(['x', 'y']), version: '1.0.1', outdir: out })
  const files = readdirSync(out).sort()
  expect(files.filter((f) => f.endsWith('.js')).length).toBe(2)
  expect(files.some((f) => f.includes('-a.js') || f.includes('-b.js') || f.includes('-c.js'))).toBe(false)
  expect(JSON.parse(readFileSync(join(out, 'index.json'), 'utf8')).modules.map((m) => m.handle)).toEqual(['x', 'y'])
})

test('split publish failure leaves the previous generation byte-for-byte readable', async () => {
  const parent = tmp('unbun-split-failure-')
  const out = join(parent, 'modules')
  await runSplit({ app: smallBundle(['a', 'b']), version: '1.0.0', outdir: out })
  const before = snapshotDir(out)
  const blocker = join(parent, '.modules.injected')
  writeFileSync(blocker, 'not a directory')
  await expect(runSplit({ app: smallBundle(['x']), version: '1.0.1', outdir: out, tempOutdir: blocker })).rejects.toThrow()
  const after = snapshotDir(out)
  expect(Object.keys(after)).toEqual(Object.keys(before))
  for (const name of Object.keys(before)) expect(after[name].equals(before[name])).toBe(true)
})

test('split：写 per-module 文件 + index.json（count 自洽、文件都在、可重解析、esm+cjs 皆有）', async () => {
  // 走「已提取 app.js 输入」分支：把缓存 app 写进临时 app.js，split 直接读它（免二进制再读 257MB）。
  const srcDir = tmp('unbun-split-src-')
  const appJs = join(srcDir, 'app.js')
  writeFileSync(appJs, app)
  const out = tmp('unbun-split-out-')

  // runSplit 现为 async（P5 并发写盘）：必须 await，否则拿到 Promise、断言假绿/竞态。
  const { outdir, index } = await runSplit({ input: appJs, outdir: out })
  expect(outdir).toBe(out)

  // index.json 落盘内容 === 返回值（自洽）
  const onDisk = JSON.parse(readFileSync(join(out, 'index.json'), 'utf8'))
  expect(onDisk).toEqual(index)

  // count === modules 数组长度，且量级合理（不 pin 精确值）
  expect(index.count).toBe(index.modules.length)
  expect(index.count).toBeGreaterThan(1000)

  // 落盘：模块文件数 === count，外加 index.json 一份
  const files = readdirSync(out)
  expect(files).toContain('index.json')
  expect(files.length).toBe(index.count + 1)

  // 每条 index 记录字段结构 / 类型合理，bytes 自洽，file 命名合规
  for (const m of index.modules) {
    expect(typeof m.seq).toBe('number')
    expect(m.bytes).toBe(m.end - m.start)
    expect(m.file).toMatch(/^\d{5,}-.*\.js$/) // seq 补零 ≥5 位（Claude 恒 5；大 SFX 按 count 加宽）
    expect(['esm', 'cjs']).toContain(m.kind)
    expect(m.hash).toMatch(/^[0-9a-f]{16}$/) // E5：内容哈希落进 index.json（diff 精确身份）
  }

  // esm 与 cjs 两 kind 都出现（brief 要求）
  const kinds = new Set(index.modules.map((m) => m.kind))
  expect(kinds.has('esm')).toBe(true)
  expect(kinds.has('cjs')).toBe(true)

  // helpers 结构透传
  expect(Array.isArray(index.helpers.esm)).toBe(true)
  expect(Array.isArray(index.helpers.cjs)).toBe(true)

  // 抽样若干模块（跨区间，非只前几个）：文件存在、内容 === 对应 app 字节区间、可被 acorn 独立重解析
  for (const i of [0, index.count >> 1, index.count - 1]) {
    const m = index.modules[i]
    const p = join(out, m.file)
    expect(existsSync(p)).toBe(true)
    const content = readFileSync(p, 'utf8')
    expect(content).toBe(app.slice(m.start, m.end))
    expect(() => Parser.parse(content, { ecmaVersion: 'latest' })).not.toThrow()
  }

  // app.js 输入 → version 从 basename 推得（'app'）
  expect(index.version).toBe('app')
}, 30_000)
