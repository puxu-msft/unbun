// test/diff.test.mjs — diff 子命令核心：两个 split index.json 之间的结构 diff，**归一 minifier 改名噪音**。
// 用合成 index fixture（不依赖真二进制、纯数据）造出「一增一删一改一改名」四种变化，断言 diffModuleSets
// 正确分类；核心非空断言是「改名（handle 变、内容同）被归一为 renamed、绝不误报为 changed」。
// 断言结构 / 分类，绝不 byte-pin。CLI 路径（runDiff）用临时 index.json 走目录解析分支单独覆盖。
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { diffModuleSets } from '../lib/diff.mjs'
import { runDiff } from '../cli.mjs'

// 合成一条 index 模块记录：seq/handle/kind/bytes + 自洽的 start/end/file（diff 只看 kind/bytes/handle）。
function mod(seq, handle, kind, bytes) {
  return { seq, handle, kind, start: 0, end: bytes, bytes, file: `${String(seq).padStart(5, '0')}-${handle}.js` }
}
// 带内容哈希（E5）的模块记录：hash 是 split 写进 index 的**精确身份**（sha256 前 16 hex）。
function modH(seq, handle, kind, bytes, hash) {
  return { ...mod(seq, handle, kind, bytes), hash }
}
function index(version, modules) {
  return { version, helpers: { esm: [], cjs: [] }, count: modules.length, modules }
}
// 剥掉 hash 字段 → 模拟 E5 之前产的老 index.json（diff 须回落 (kind,bytes)）。
function stripHash(idx) {
  return index(idx.version, idx.modules.map(({ hash, ...m }) => m))
}

// A：M1,M2,M3,M4。B：M1 不变 / M2 改名(handle b→E,内容同) / M3 bytes 变 / M4 删 / M5 新增。
const indexA = index('vA', [
  mod(1, 'a', 'esm', 100), // M1
  mod(2, 'b', 'cjs', 200), // M2  → 在 B 改名成 'E'（bytes/kind 同）
  mod(3, 'c', 'esm', 300), // M3  → 在 B bytes 变 300→350
  mod(4, 'd', 'cjs', 400), // M4  → 在 B 删除
])
const indexB = index('vB', [
  mod(1, 'a', 'esm', 100), // M1 unchanged
  mod(2, 'E', 'cjs', 200), // M2 renamed（handle b→E，内容同）
  mod(3, 'c', 'esm', 350), // M3 changed（bytes 300→350，handle 同）
  mod(5, 'f', 'esm', 500), // M5 added
])

test('diffModuleSets：改名归一为 renamed 不误报 changed；增/删/改各就位', () => {
  const d = diffModuleSets(indexA, indexB)

  // ── unchanged：M1（handle+kind+bytes 全同）━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  expect(d.unchanged).toBe(1)

  // ── renamed：M2（handle b→E，内容同）— 核心非空断言：改名被归一，绝不进 changed ━━━━━━━━━
  expect(d.renamed.length).toBe(1)
  const r = d.renamed[0]
  expect(r.oldHandle).toBe('b')
  expect(r.newHandle).toBe('E')
  // 改名项绝不出现在 changed（归一 minifier 改名噪音的核心）
  expect(d.changed.some((c) => c.handle === 'b' || c.handle === 'E')).toBe(false)
  expect(d.renamed.some((x) => x.oldHandle === 'b')).toBe(true)

  // ── changed：M3（handle c 不变、bytes 300→350）━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  expect(d.changed.length).toBe(1)
  const c = d.changed[0]
  expect(c.handle).toBe('c')
  expect(c.a.bytes).toBe(300)
  expect(c.b.bytes).toBe(350)

  // ── removed：M4（handle d，只在 A）━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  expect(d.removed.length).toBe(1)
  expect(d.removed[0].handle).toBe('d')

  // ── added：M5（handle f，只在 B）━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  expect(d.added.length).toBe(1)
  expect(d.added[0].handle).toBe('f')

  // 交叉核验：四条变化 + 一条不变，各类互斥不重复计数
  const rmHandles = new Set(d.removed.map((m) => m.handle))
  const addHandles = new Set(d.added.map((m) => m.handle))
  expect(rmHandles.has('b')).toBe(false) // b 是改名不是删除
  expect(addHandles.has('E')).toBe(false) // E 是改名不是新增
})

test('diffModuleSets：两个相同 index → 全 unchanged、其余空', () => {
  const d = diffModuleSets(indexA, indexA)
  expect(d.unchanged).toBe(indexA.modules.length)
  expect(d.added).toEqual([])
  expect(d.removed).toEqual([])
  expect(d.changed).toEqual([])
  expect(d.renamed).toEqual([])
})

// ── E5：hash 精确身份 vs (kind,bytes) 近似身份 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 核心场景：A/B 各含两个 **(kind,bytes) 相同但内容不同**（hash 不同、handle 全异）的模块。
// (kind,bytes) 指纹会把它们**误配成 renamed**（假阳性）；hash 精确身份消除这个误配。
const collideA = index('cA', [
  modH(1, 'p', 'esm', 100, 'aaaa000000000001'), // 与 q 同 (esm,100)、内容不同
  modH(2, 'q', 'esm', 100, 'aaaa000000000002'),
])
const collideB = index('cB', [
  modH(1, 'r', 'esm', 100, 'bbbb000000000001'), // 与 A 各模块同 (esm,100)、内容全不同
  modH(2, 's', 'esm', 100, 'bbbb000000000002'),
])

test('E5：hash 精确身份消除 (kind,bytes) 误配 —— 不同模块绝不被误配成 renamed', () => {
  const d = diffModuleSets(collideA, collideB)
  // hash 全不同 → Pass 2 无配 → 各归 removed/added，绝无假阳性 renamed。
  expect(d.renamed.length).toBe(0)
  expect(d.removed.length).toBe(2) // p,q 只在 A
  expect(d.added.length).toBe(2) // r,s 只在 B
  expect(d.changed.length).toBe(0)
  expect(d.unchanged).toBe(0)
})

test('E5 向后兼容 + 非空证：同 fixtures 去掉 hash → 回落 (kind,bytes) → 误配 renamed 复现', () => {
  // 与上例**同一组 fixtures**，仅剥掉 hash（模拟老 index.json）。回落 (kind,bytes)：两模块同指纹 →
  // Pass 2 把它们**误配成 2 个 renamed**（假阳性）。上例 renamed=0、此处 renamed=2，差异全由 hash
  // 引入 —— 这正是 hash 消除误配的**在测证明**（非空、无需手工 revert 即自证）。
  const d = diffModuleSets(stripHash(collideA), stripHash(collideB))
  expect(d.renamed.length).toBe(2) // (kind,bytes) 近似身份的固有误配
  expect(d.removed.length).toBe(0)
  expect(d.added.length).toBe(0)
})

test('E5：hash 精确 rename —— handle 变、内容(hash)同 → renamed', () => {
  const renA = index('rA', [modH(1, 'a', 'esm', 100, 'deadbeefdeadbeef')])
  const renB = index('rB', [modH(1, 'z', 'esm', 100, 'deadbeefdeadbeef')]) // handle 变、hash 同
  const d = diffModuleSets(renA, renB)
  expect(d.renamed.length).toBe(1)
  expect(d.renamed[0].oldHandle).toBe('a')
  expect(d.renamed[0].newHandle).toBe('z')
  expect(d.unchanged).toBe(0)
})

test('E5 固有局限：rename+改内容同时发生 → 退化成 removed+added（hash 也关联不了两端）', () => {
  const a = index('a', [modH(1, 'a', 'esm', 100, 'hashold000000001')])
  const b = index('b', [modH(1, 'z', 'esm', 120, 'hashnew000000002')]) // handle 与 hash 双双变
  const d = diffModuleSets(a, b)
  // 两个身份信号都变 → 无从关联，如实退化（诚实标注：hash 只消除误配，不解决「既改名又改内容」）。
  expect(d.renamed.length).toBe(0)
  expect(d.removed.length).toBe(1)
  expect(d.added.length).toBe(1)
})

test('E5 向后兼容：一侧无 hash（新旧混比）→ 回落 (kind,bytes)、不崩', () => {
  const withH = index('h', [modH(1, 'a', 'esm', 100, 'somehash00000001')])
  const noH = index('n', [mod(1, 'b', 'esm', 100)]) // 无 hash、同 (kind,bytes)、handle 异
  const d = diffModuleSets(withH, noH)
  // 只要有一侧缺 hash 就回落 (kind,bytes)：同指纹、handle 异 → renamed（现有语义，不崩）。
  expect(d.renamed.length).toBe(1)
  expect(d.renamed[0].oldHandle).toBe('a')
  expect(d.renamed[0].newHandle).toBe('b')
})

// ── CLI 路径：runDiff 从两个目录的 modules/index.json 读入、写 diff.json ━━━━━━━━━━━━━━━━━━
const created = []
afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true })
})
function writeSplitDir(prefix, idx) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  created.push(dir)
  mkdirSync(join(dir, 'modules'), { recursive: true })
  writeFileSync(join(dir, 'modules', 'index.json'), JSON.stringify(idx, null, 2) + '\n')
  return dir
}

test('runDiff：解析目录下 modules/index.json、分类正确、写结构化 diff.json', () => {
  const dirA = writeSplitDir('unbun-diffA-', indexA)
  const dirB = writeSplitDir('unbun-diffB-', indexB)
  const out = mkdtempSync(join(tmpdir(), 'unbun-diffout-'))
  created.push(out)

  const { diff, outPath } = runDiff({ a: dirA, b: dirB, outdir: out })
  expect(diff.summary).toEqual({ added: 1, removed: 1, changed: 1, renamed: 1, unchanged: 1 })

  // diff.json 落盘 === 返回结果（自洽）
  expect(existsSync(outPath)).toBe(true)
  const onDisk = JSON.parse(readFileSync(outPath, 'utf8'))
  expect(onDisk.summary).toEqual(diff.summary)
  expect(onDisk.renamed[0].oldHandle).toBe('b')
  expect(onDisk.renamed[0].newHandle).toBe('E')
  // 版本透传（provenance）
  expect(onDisk.versionA).toBe('vA')
  expect(onDisk.versionB).toBe('vB')
})

test('runDiff：直接给 index.json 路径也可（不止目录）', () => {
  const dirA = writeSplitDir('unbun-diffpA-', indexA)
  const dirB = writeSplitDir('unbun-diffpB-', indexB)
  const out = mkdtempSync(join(tmpdir(), 'unbun-diffpout-'))
  created.push(out)

  const { diff } = runDiff({
    a: join(dirA, 'modules', 'index.json'),
    b: join(dirB, 'modules', 'index.json'),
    outdir: out,
  })
  expect(diff.summary.renamed).toBe(1)
  expect(diff.summary.changed).toBe(1)
})
