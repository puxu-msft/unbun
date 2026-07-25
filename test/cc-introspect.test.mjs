// test/cc-introspect.test.mjs — cc 运行时内省的核心 oracle（评审 M1：子集，绝不 ===）。
//
// 真链路（不 mock）：build-fixture 造一个可打桩 bun SFX `mini`（内含 tiny.txt 文件资产）→
//   `cc introspect --probe assets` 对 mini 的 `//!` 锚**真打桩、真跑副本**、经 CC_EXT 注入
//   dump-assets probe → 收 `Bun.embeddedFiles` 名集 = runtimeSet；
//   `parseModuleGraph(mini)` 静态解出全 blob 名集 = staticAll（含入口 app bundle）。
//
// 子集不变式（核心）：runtimeSet ⊆ staticAll，且**严格**子集——app bundle（入口 `mini`）只在静态里、
//   不在 embeddedFiles（JS 模块被 --compile 内联、不是 `with{type:file}` 资产）。绝不断言 ===。
//   runtimeSet 非空（fixture 真嵌了 tiny.txt）。
//
// fixture `mini` 是 ~94MB 构建产物（bun --compile 打包整个 bun 运行时），**不入库**：本测试在
//   临时目录即时 build，afterAll 清理。build-fixture.mjs 是 entry.js/tiny.txt/锚的唯一真相源。
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { parseModuleGraph } from '../lib/module-graph.mjs'
import { patchLoaderHook } from '../lib/hook.mjs'
import { runCcIntrospect, runCcRun, runCcPatch } from '../cli.mjs'
import { cachedMiniFixture, FIXTURE_ANCHOR } from './fixtures/build-fixture.mjs'

const created = []
function tmp(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix))
  created.push(d)
  return d
}
afterAll(() => {
  for (const d of created) rmSync(d, { recursive: true, force: true })
})

let mini // path to the built fixture SFX (shared FS cache, gitignored/ephemeral)
beforeAll(() => {
  mini = cachedMiniFixture().miniPath
})

// 名归一：blob 名带 `/$bunfs/root/`，embeddedFiles 名已是 basename —— 双方都取 basename 比对。
const norm = (n) => basename(String(n))

test('CORE: runtime embeddedFiles ⊆ static blobs (strict subset, not equal); runtime non-empty', () => {
  // runtime：真打桩 mini 的 //! 锚 + 真跑副本 + CC_EXT=dump-assets probe → Bun.embeddedFiles 名集。
  const { result, outdir } = runCcIntrospect({ bin: mini, probe: 'assets', anchor: FIXTURE_ANCHOR })
  expect(result).toBeTruthy()
  expect(result.probe).toBe('assets')
  const runtimeSet = (result.files || []).map((f) => norm(f.name))

  // static：独立 oracle，静态解 module graph（不依赖被测 runtime 路径）。
  const { blobs } = parseModuleGraph(mini)
  const staticAll = blobs.map((b) => norm(b.name)) // 含入口 app bundle
  const staticAssets = blobs.filter((b) => !b.isEntry).map((b) => norm(b.name))

  // runtime 非空（fixture 真嵌了 tiny.txt）
  expect(runtimeSet.length).toBeGreaterThan(0)

  // 子集：每个运行时嵌入件都在静态全集里
  for (const n of runtimeSet) expect(staticAll).toContain(n)

  // **严格**子集（绝不 ===）：静态全集有运行时没有的东西——入口 app bundle 只在静态里、不在 embeddedFiles。
  expect(staticAll.length).toBeGreaterThan(runtimeSet.length)
  const staticOnly = staticAll.filter((n) => !runtimeSet.includes(n))
  expect(staticOnly.length).toBeGreaterThan(0)
  const entryName = norm(blobs.find((b) => b.isEntry).name)
  expect(staticOnly).toContain(entryName) // app bundle 是「静态有、运行时无」的典型

  // runtime 嵌入件也都是「非入口」blob（embeddedFiles 即 file-type 非入口资产）——把 runtime 绑到资产定义。
  for (const n of runtimeSet) expect(staticAssets).toContain(n)

  // probe 也把资产写到了 outdir（dump-assets 的落盘职责）
  for (const n of runtimeSet) expect(existsSync(join(outdir, n))).toBe(true)
}, 60_000)

test('patch-loader-hook: patches mini //! anchor equal-length (size unchanged, sites non-empty)', () => {
  const out = join(tmp('unbun-patch-'), 'mini.hooked')
  const origSize = statSync(mini).size
  const r = runCcPatch({ bin: mini, out, anchor: FIXTURE_ANCHOR })
  expect(r.patched).toBe(true)
  expect(r.sites.length).toBeGreaterThan(0)
  expect(r.size).toBe(origSize)
  expect(existsSync(out)).toBe(true)
  expect(statSync(out).size).toBe(origSize) // 等长：写出的副本 size 与原始一致
  // 独立复核：读回副本，其字节确实经过等长打桩（用纯函数在原始 buf 上复算，命中集一致）。
  const { patched, sites } = patchLoaderHook(readFileSync(mini), { anchor: FIXTURE_ANCHOR })
  expect(sites).toEqual(r.sites)
  expect(Buffer.compare(readFileSync(out), patched)).toBe(0)
}, 30_000)

test('patch-loader-hook guard①: zero anchor sites → refuse (patched=false), exit 1', () => {
  try {
    const d = tmp('unbun-nosite-')
    const noAnchor = join(d, 'noanchor.bin')
    writeFileSync(noAnchor, 'this buffer has no loader-hook anchor whatsoever')
    const r = runCcPatch({ bin: noAnchor, out: join(d, 'x.hooked'), anchor: FIXTURE_ANCHOR })
    expect(r.patched).toBe(false)
    expect(r.reason).toBe('no-sites')
    expect(process.exitCode).toBe(1)
    expect(existsSync(join(d, 'x.hooked'))).toBe(false) // 零命中不写文件
  } finally {
    process.exitCode = 0 // 别污染测试 runner 的退出码（Bun 下赋 undefined 不清零，须显式 0）
  }
})

test('patch-loader-hook guard②: out under versions/ refused w/o --force; --force writes (real behavior)', () => {
  try {
    const d = tmp('unbun-vers-')
    const vout = join(d, 'versions', '9.9.9', 'mini.hooked')
    // 无 --force：拒绝、退出 1、不写文件
    const r1 = runCcPatch({ bin: mini, out: vout, anchor: FIXTURE_ANCHOR })
    expect(r1.patched).toBe(false)
    expect(r1.reason).toBe('versions-guard')
    expect(process.exitCode).toBe(1)
    expect(existsSync(vout)).toBe(false)
    // --force：真写（非 no-op），等长
    process.exitCode = 0
    const r2 = runCcPatch({ bin: mini, out: vout, force: true, anchor: FIXTURE_ANCHOR })
    expect(r2.patched).toBe(true)
    expect(existsSync(vout)).toBe(true)
    expect(statSync(vout).size).toBe(statSync(mini).size)
  } finally {
    process.exitCode = 0
  }
}, 30_000)

test('patch-loader-hook guard③: sibling .bak size mismatch warns (non-blocking)', () => {
  const d = tmp('unbun-bak-')
  // 造一个带锚的小目标 + 一个尺寸不一致的 .bak
  const anchoredBuf = Buffer.concat([Buffer.from('head'), Buffer.from(FIXTURE_ANCHOR + '\n'), Buffer.from('tail')])
  const target = join(d, 'target.bin')
  writeFileSync(target, anchoredBuf)
  writeFileSync(target + '.bak', Buffer.from('different size bak content zzzzzzzzzzzzzzzzzzzzz'))
  // 应仍成功打桩（.bak 尺寸不符只是警告），且等长
  const out = join(d, 'target.hooked')
  const r = runCcPatch({ bin: target, out, anchor: FIXTURE_ANCHOR })
  expect(r.patched).toBe(true)
  expect(statSync(out).size).toBe(anchoredBuf.length)
})

test('cc run: patches a copy, injects CC_EXT, captures probe stdout; live binary read-only', () => {
  const d = tmp('unbun-ccrun-')
  const ext = join(d, 'marker.cjs')
  writeFileSync(ext, "process.stdout.write('CC_RUN_MARKER pid=' + process.pid + '\\n'); process.exit(0)\n")
  const beforeSize = statSync(mini).size
  const res = runCcRun({ bin: mini, ext, anchor: FIXTURE_ANCHOR })
  expect(res.sites.length).toBeGreaterThan(0)
  expect(res.stdout).toContain('CC_RUN_MARKER')
  // 原始 mini 未被改动（只读 + 只对临时副本打桩）
  expect(statSync(mini).size).toBe(beforeSize)
}, 30_000)

test('cc run: missing extension fails loudly with the original module error visible', () => {
  const missing = join(tmp('unbun-missing-ext-'), 'does-not-exist.cjs')
  const res = runCcRun({ bin: mini, ext: missing, anchor: FIXTURE_ANCHOR })
  expect(res.status).not.toBe(0)
  expect(res.stderr).toContain('does-not-exist.cjs')
}, 30_000)

test('cc run: extension top-level throw fails loudly with the original error visible', () => {
  const ext = join(tmp('unbun-throw-ext-'), 'throw.cjs')
  writeFileSync(ext, "throw new Error('UNBUN_TOP_LEVEL_THROW')\n")
  const res = runCcRun({ bin: mini, ext, anchor: FIXTURE_ANCHOR })
  expect(res.status).not.toBe(0)
  expect(res.stderr).toContain('UNBUN_TOP_LEVEL_THROW')
}, 30_000)

test('cc introspect facts: unwritable output target is a failure, not a success marker', () => {
  const out = tmp('unbun-facts-write-fail-')
  const blocker = join(out, 'facts.json')
  mkdirSync(blocker)
  expect(() => runCcIntrospect({ bin: mini, probe: 'facts', outdir: out, anchor: FIXTURE_ANCHOR })).toThrow(/facts|write|status/i)
}, 30_000)

test('cc introspect graph: unwritable output target is a failure, not a success marker', () => {
  const out = tmp('unbun-graph-write-fail-')
  const blocker = join(out, 'module-graph.json')
  mkdirSync(blocker)
  expect(() => runCcIntrospect({ bin: mini, probe: 'graph', outdir: out, anchor: FIXTURE_ANCHOR })).toThrow(/graph|write|status/i)
}, 30_000)

test('cc introspect rejects a successful child marker for the wrong probe', () => {
  const ext = join(tmp('unbun-wrong-probe-'), 'wrong.cjs')
  writeFileSync(ext, 'console.log("UNBUN_PROBE_JSON " + JSON.stringify({probe:"assets",files:[]})); process.exit(0)\n')
  const payload = `process.env.CC_EXT&&require(process.env.CC_EXT)`
  expect(() => runCcIntrospect({ bin: mini, probe: 'facts', anchor: FIXTURE_ANCHOR, payload, args: ['--version'], script: ext })).toThrow()
}, 30_000)

test('cc introspect assets rejects markers whose reported output files are missing', () => {
  const ext = join(tmp('unbun-missing-output-'), 'missing.cjs')
  writeFileSync(ext, 'console.log("UNBUN_PROBE_JSON " + JSON.stringify({probe:"assets",files:[{name:"missing.bin"}]})); process.exit(0)\n')
  expect(() => runCcIntrospect({ bin: mini, probe: 'assets', anchor: FIXTURE_ANCHOR, script: ext })).toThrow(/expected output missing/i)
}, 30_000)

test('cc introspect facts + graph: structured runtime facts; graph honest about --compile limitation', () => {
  const f = runCcIntrospect({ bin: mini, probe: 'facts', anchor: FIXTURE_ANCHOR })
  expect(f.result.probe).toBe('facts')
  expect(typeof f.result.bunVersion).toBe('string')
  expect(f.result.processVersions).toBeTruthy()
  expect(f.result.embeddedFiles.map((x) => norm(x.name)).length).toBeGreaterThan(0)
  expect(existsSync(join(f.outdir, 'facts.json'))).toBe(true)

  const g = runCcIntrospect({ bin: mini, probe: 'graph', anchor: FIXTURE_ANCHOR })
  expect(g.result.probe).toBe('graph')
  expect(typeof g.result.note).toBe('string') // 诚实注明：--compile 内联模块，只捕运行时惰性 require
  expect(Array.isArray(g.result.runtimeLoads)).toBe(true)
  expect(g.result.embeddedFiles.map((x) => norm(x.name)).length).toBeGreaterThan(0)
  expect(existsSync(join(g.outdir, 'module-graph.json'))).toBe(true)
}, 60_000)
