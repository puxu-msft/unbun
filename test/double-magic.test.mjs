// test/double-magic.test.mjs — double-magic 消歧鲁棒性（评审 G2 / Task 4.3）。
//
// 场景：`bun build --compile` 的 app 正文里如果嵌了一个**字面量** `---- Bun! ----`，
//   编译后这个「假 magic」会落进 ELF `.bun` 段窗口内、**真 trailer 之前**（实证：见 build-fixture
//   的 DECOY_MAGIC_SENTINEL 注入 + 本测试 ≥2 次断言）。`module-graph.mjs` 用
//   `buf.lastIndexOf(MAGIC, winEnd)` 而非 `indexOf` 定位真 trailer，正是为了在这种「窗口内多 magic」
//   下仍取到**最后一个**（真 trailer），而不是被前面的假 magic 误导。
//
// 本测试把这个鲁棒性做成**真测**（计划原写「若造不出则 skip」，PoC 已证可造 → 去 skip 做真测）：
//   ① 造含注入 magic 的 fixture，断言 `.bun` 窗口内 magic 出现 ≥2 次（假 + 真）——否则注入没进窗口；
//   ② `parseModuleGraph` 成功、切出的 blob 自证通过（取到的是**真** trailer；若取了假 magic，
//      其后的 Offsets 头是正文字节、解出的记录表是垃圾 → fail-loud THROW 或 blob 自证失败）；
//   ③ 断言真 trailer 偏移 = 窗口内 magic 的**最后一次**出现（`lastIndexOf`），且注入的假 magic
//      偏移 < 真 trailer 偏移；
//   ④ **非空性**：把 fixture 从真 trailer 处截断（只留假 magic）再解析 → 必须 THROW，
//      证明 `lastIndexOf` 的「取最后一个」是 load-bearing（取第一个/假的会失败）。
//
// fixture `mini-doublemagic` 是 ~94MB 构建产物（bun --compile 打包整个 bun 运行时），**不入库**：
//   本测试在临时目录即时 build，afterAll 清理。build-fixture.mjs 是其唯一真相源。
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Parser } from 'acorn'
import { readBinary } from '../lib/bun-binary.mjs'
import { parseModuleGraph } from '../lib/module-graph.mjs'
import { cachedMiniFixture, DECOY_MAGIC_SENTINEL } from './fixtures/build-fixture.mjs'

// 独立 oracle：magic 常量在此重述（不 import module-graph 的私有 MAGIC），作为独立判据。
const MAGIC = Buffer.from('---- Bun! ----')

// P4：readBinary 现返回按需 pread 的 reader（不再全读 buf）。本套用**全读 buf** 作独立 oracle
// （indexOf/lastIndexOf/toString 扫全窗验 magic 定位）+ readBinary 只取 .bun section 边界，各司其职。
function bufAndSections(path) {
  const buf = readFileSync(path)
  const r = readBinary(path)
  try {
    return { buf, sections: r.sections }
  } finally {
    r.close()
  }
}

const created = []
function tmp(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix))
  created.push(d)
  return d
}
afterAll(() => {
  for (const d of created) rmSync(d, { recursive: true, force: true })
})

// 统计 buf 的 [start,end) 区间内 needle 的（不重叠）出现次数。
function countOccurrences(buf, needle, start, end) {
  let n = 0
  let i = start
  while ((i = buf.indexOf(needle, i)) !== -1 && i < end) {
    n++
    i += needle.length
  }
  return n
}

let mini // 含注入 magic 的 fixture 路径（共享 FS 缓存、跨 test-run 复用）
beforeAll(() => {
  mini = cachedMiniFixture({ doubleMagic: true }).miniPath
})

test('injected literal magic lands in .bun window before the real trailer (≥2 occurrences)', () => {
  const { buf, sections } = bufAndSections(mini)
  const bun = sections['.bun']
  expect(bun).toBeTruthy()
  const winEnd = bun.off + bun.size

  // ① 窗口内 magic 出现 ≥2 次（注入的假 magic + 真 trailer）。若只 1 次 → 注入没进 .bun。
  const count = countOccurrences(buf, MAGIC, bun.off, winEnd)
  expect(count).toBeGreaterThanOrEqual(2)

  // 第一处（indexOf）= 注入的假 magic；最后一处（lastIndexOf）= 真 trailer。
  const decoyPos = buf.indexOf(MAGIC, bun.off)
  const realMagicPos = buf.lastIndexOf(MAGIC, winEnd)
  expect(decoyPos).toBeGreaterThanOrEqual(bun.off)
  expect(realMagicPos).toBeLessThan(winEnd)

  // ③ 假 magic 在真 trailer **之前**（否则本测试证不了 lastIndexOf 的必要性）。
  expect(decoyPos).toBeLessThan(realMagicPos)

  // 把「≥2 次」绑定到**我们注入的**哨兵，而非某个巧合 magic：第一处 magic 前后是 DECOY 边界词。
  const around = buf.toString('latin1', Math.max(0, decoyPos - 24), decoyPos + MAGIC.length + 24)
  expect(around).toContain('UNBUN_DECOY_START')
  expect(around).toContain('UNBUN_DECOY_END')
  // 完整哨兵串（含内嵌 magic）确实原样落进 .bun app bundle。
  expect(buf.includes(Buffer.from(DECOY_MAGIC_SENTINEL))).toBe(true)
})

test('parseModuleGraph picks the REAL trailer (lastIndexOf), not the injected decoy magic', () => {
  const { buf, sections } = bufAndSections(mini)
  const bun = sections['.bun']
  const winEnd = bun.off + bun.size
  const realMagicPos = buf.lastIndexOf(MAGIC, winEnd)
  const decoyPos = buf.indexOf(MAGIC, bun.off)

  const { trailerOffset, blobs } = parseModuleGraph(mini)

  // 取到的是真 trailer：trailerOffset 指向 trailer 前导 '\n'，= 最后一次 magic 出现 - 1。
  expect(trailerOffset).toBe(realMagicPos - 1)
  // 且**不是**假 magic：假 magic 的偏移严格更小。
  expect(decoyPos).toBeLessThan(trailerOffset)

  // 切出的 blob 自证通过 = 证明取到的确是真 trailer（取了假 magic → 记录表是正文垃圾 → 已 THROW）。
  expect(blobs.length).toBeGreaterThanOrEqual(2)
  const slice = (b) => buf.subarray(b.offset, b.offset + b.length)
  // 入口 app bundle：整块 acorn 可解析（长度敏感），头含 bun banner。
  const entry = blobs.find((b) => b.isEntry)
  expect(entry).toBeTruthy()
  const entryHead = slice(entry).subarray(0, 64).toString('latin1')
  expect(entryHead.includes('// @bun') || entryHead.includes('@bun-cjs')).toBe(true)
  // fixture 入口是 `bun build --compile` 的 ESM bundle（`// @bun`，含 import/export）→ sourceType module；
  // 真 claude 入口是预打包 `@bun-cjs` CJS wrapper → script。按 banner 选，整块可解析 = 长度正确。
  const sourceType = entryHead.includes('@bun-cjs') ? 'script' : 'module'
  expect(() => Parser.parse(slice(entry).toString('utf8'), { ecmaVersion: 'latest', sourceType })).not.toThrow()
  // 至少一个资产 blob（tiny.txt，file loader）：头是 `/*!`（**非** JS/ELF marker）——loader-aware
  // 自证对 file 类跳过 head sniff，此处只复核头非空（切片长度正确、blob 确实切出来了）。
  const assets = blobs.filter((b) => !b.isEntry)
  expect(assets.length).toBeGreaterThanOrEqual(1)
  for (const a of assets) {
    const head = slice(a).subarray(0, 64).toString('latin1')
    expect(head.length).toBeGreaterThan(0)
  }
  // 相邻 blob 无重叠（进一步锁死 offset/length 都取自真 trailer 的记录表）。
  const sorted = [...blobs].sort((x, y) => x.offset - y.offset)
  for (let i = 1; i < sorted.length; i++) {
    expect(sorted[i].offset).toBeGreaterThanOrEqual(sorted[i - 1].offset + sorted[i - 1].length)
  }
})

test('non-vacuity: with the real trailer removed, only the decoy remains → parse THROWS (lastIndexOf is load-bearing)', () => {
  const { buf, sections } = bufAndSections(mini)
  const bun = sections['.bun']
  const winEnd = bun.off + bun.size
  const realMagicPos = buf.lastIndexOf(MAGIC, winEnd)
  const decoyPos = buf.indexOf(MAGIC, bun.off)
  expect(decoyPos).toBeLessThan(realMagicPos) // 前置条件：确有更早的假 magic

  // 从真 trailer 处截断 → 文件里 magic 的最后一次出现变成**假 magic**（模拟「若取第一个/更早的 magic」）。
  // ELF header（文件头）不变，readBinary 仍解析出同一 .bun 窗口；但 lastIndexOf(MAGIC, winEnd) 现在
  // 落到假 magic → 其后的「Offsets 头」是 app 正文字节 → graph_base/记录表越界或自证失败 → fail-loud THROW。
  const truncated = buf.subarray(0, realMagicPos)
  const d = tmp('unbun-doublemagic-trunc-')
  const truncPath = join(d, 'mini-truncated')
  writeFileSync(truncPath, truncated)

  // 独立复核：截断后文件里最后一次 magic 确实是假 magic（decoyPos），真 trailer 已被切掉。
  expect(truncated.lastIndexOf(MAGIC)).toBe(decoyPos)

  // 取到假 magic → 绝不静默产坏切片：必须 THROW（证明「取最后一个真 trailer」是承重的）。
  expect(() => parseModuleGraph(truncPath)).toThrow()
})
