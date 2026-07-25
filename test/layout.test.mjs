// test/layout.test.mjs — layout 分解正确性：用 module-graph 精确 blob 边界 + ELF section 元数据把
// 245MB 二进制拆成 { engine, bunAppJs, bunAssets, bunBytecodeAndMeta, otherSections }，各项字节+占比。
// 全程静态纯读、不执行目标 binary；边界全来自 module-graph + ELF，**绝不对启发式可打印 run 做 latin1
// 扫描**（Global Constraints / B1 教训）。断言结构 / 量级，不 byte-pin：复现 exp 结论量级（engine 大、
// .bun 是大头、cli.js ~18MB、字节码是最大单块）。独立 oracle 复核 sum ≈ fileSize（不靠被测 breakdown 自证）。
import { test, expect } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readBinary, defaultBinary } from '../lib/bun-binary.mjs'
import { parseModuleGraph } from '../lib/module-graph.mjs'
import { computeLayout } from '../lib/layout.mjs'
import { runLayout } from '../cli.mjs'
const MB = 1024 * 1024

test('computeLayout：module-graph 精确边界分解 .bun + ELF section，各项 >0、和 ≈ fileSize', () => {
  const bin = defaultBinary()
  const layout = computeLayout(bin)

  // ── 顶层字段 ────────────────────────────────────────────────────────────────
  expect(layout.fileSize).toBeGreaterThan(100 * MB) // 活二进制 ~245MB
  expect(layout.engine).toBeGreaterThan(0)
  expect(layout.sections['.bun']).toBeTruthy()
  expect(Array.isArray(layout.blobs)).toBe(true)
  expect(layout.blobs.length).toBeGreaterThan(2)

  // ── 独立 oracle：直接从 readFileSync（全读整块）+ readBinary（section 边界）+ parseModuleGraph
  //     重算，不信被测 breakdown 自证。P4 后 readBinary 是按需 pread 的 reader、不再全读 buf，故 buf
  //     用 readFileSync 自读，sections 从 reader 取 ──────────────────────────────────
  const buf = readFileSync(bin)
  const r = readBinary(bin)
  const sections = r.sections
  r.close()
  const { blobs, entryPointId } = parseModuleGraph(bin)
  const engineOracle = sections['.text'].size + sections['.rodata'].size
  expect(layout.engine).toBe(engineOracle)
  expect(layout.fileSize).toBe(buf.length)

  const entry = blobs.find((b) => b.isEntry)
  expect(entry).toBeTruthy()
  const blobSum = blobs.reduce((a, b) => a + b.length, 0)
  const bytecodeOracle = sections['.bun'].size - blobSum
  const assetsOracle = blobSum - entry.length
  const otherOracle = buf.length - engineOracle - sections['.bun'].size

  // ── breakdown 五项 ─────────────────────────────────────────────────────────
  const bd = layout.breakdown
  for (const k of ['engine', 'bunAppJs', 'bunAssets', 'bunBytecodeAndMeta', 'otherSections']) {
    expect(bd[k]).toBeTruthy()
    expect(typeof bd[k].bytes).toBe('number')
    expect(typeof bd[k].pct).toBe('number')
  }

  // 各项字节 = 独立 oracle 值（module-graph 精确边界，非启发式）
  expect(bd.engine.bytes).toBe(engineOracle)
  expect(bd.bunAppJs.bytes).toBe(entry.length)
  expect(bd.bunAssets.bytes).toBe(assetsOracle)
  expect(bd.bunBytecodeAndMeta.bytes).toBe(bytecodeOracle)
  expect(bd.otherSections.bytes).toBe(otherOracle)

  // ── 契约核心断言：各项 >0、复现 exp 量级 ───────────────────────────────────
  expect(bd.engine.bytes).toBeGreaterThan(40 * MB)          // .text+.rodata 引擎，exp ~77MB 级
  expect(bd.bunAppJs.bytes).toBeGreaterThan(5 * MB)         // app cli.js ~18MB（entry blob）
  expect(bd.bunAssets.bytes).toBeGreaterThan(0)             // .node + mermaid + 辅助 js
  expect(bd.bunBytecodeAndMeta.bytes).toBeGreaterThan(0)    // JSC 字节码 + 元数据
  expect(bd.otherSections.bytes).toBeGreaterThanOrEqual(0)  // ELF 头 / 符号表 / 其余段（余量）

  // .bun 是大头：字节码块是最大单项，且 .bun 派生总量 > 引擎
  expect(bd.bunBytecodeAndMeta.bytes).toBeGreaterThan(bd.engine.bytes)
  expect(bd.bunBytecodeAndMeta.bytes).toBeGreaterThan(bd.bunAppJs.bytes)
  expect(sections['.bun'].size).toBeGreaterThan(engineOracle)

  // ── 和 ≈ fileSize（±段对齐 / 未归类余量，容 5%）──────────────────────────────
  const sum = Object.values(bd).reduce((a, v) => a + v.bytes, 0)
  expect(Math.abs(sum - layout.fileSize)).toBeLessThan(layout.fileSize * 0.05)

  // 占比之和 ≈ 100%
  const pctSum = Object.values(bd).reduce((a, v) => a + v.pct, 0)
  expect(Math.abs(pctSum - 100)).toBeLessThan(1)
}, 30_000)

// A7 — runLayout CLI 层烟测：上面测的是纯函数 computeLayout；runLayout 是薄 wrapper（computeLayout +
// outdirName 命名 + 写盘 layout.json），无烟测则「computeLayout 对但 runLayout 接线/写盘坏了」不被发现。
// 跑 runLayout 到临时 outdir（mkdtempSync），断言 layout.json 写出、可解析、含 breakdown/engine/fileSize
// 等关键字段、breakdown 各项之和 ≈ fileSize。用真活二进制（纯读取，绝不执行）。afterAll 自清临时目录。
test('runLayout：写 layout.json 到 outdir、可解析、含关键字段、breakdown 各项和 ≈ fileSize', () => {
  const bin = defaultBinary()
  const out = mkdtempSync(join(tmpdir(), 'unbun-layout-out-'))
  try {
    const { outdir, layout } = runLayout({ bin, outdir: out })
    expect(outdir).toBe(out)

    // layout.json 落盘、可解析、内容 === 返回值（写盘接线自洽）
    const layoutPath = join(out, 'layout.json')
    expect(existsSync(layoutPath)).toBe(true)
    const onDisk = JSON.parse(readFileSync(layoutPath, 'utf8'))
    expect(onDisk).toEqual(layout)

    // 关键字段齐全、类型合理
    expect(typeof onDisk.fileSize).toBe('number')
    expect(onDisk.fileSize).toBeGreaterThan(100 * MB)
    expect(typeof onDisk.engine).toBe('number')
    expect(onDisk.engine).toBeGreaterThan(0)
    expect(onDisk.breakdown).toBeTruthy()
    for (const k of ['engine', 'bunAppJs', 'bunAssets', 'bunBytecodeAndMeta', 'otherSections']) {
      expect(typeof onDisk.breakdown[k].bytes).toBe('number')
      expect(typeof onDisk.breakdown[k].pct).toBe('number')
    }

    // breakdown 各项之和 ≈ fileSize（±段对齐余量，容 5%）
    const sum = Object.values(onDisk.breakdown).reduce((a, v) => a + v.bytes, 0)
    expect(Math.abs(sum - onDisk.fileSize)).toBeLessThan(onDisk.fileSize * 0.05)
  } finally {
    rmSync(out, { recursive: true, force: true }) // 只清自建临时目录，绝不碰共享 refs/
  }
}, 30_000)
