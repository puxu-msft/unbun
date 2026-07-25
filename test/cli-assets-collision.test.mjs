// test/cli-assets-collision.test.mjs — E4 = A5：assets 同名 basename 不再静默覆盖。
//
// 旧实现文件名直接用 `basename(b.name)`：两个非入口 blob（不同 $bunfs 路径、同尾名）basename 相同时
// 第二个 writeFileSync **静默覆盖**第一个 —— 丢资产、无警告。修复：命名逻辑抽成纯函数
// `uniqueAssetName(name, offset, used)`，用全局唯一的 offset 消歧（`<stem>-<offset><ext>`，仍撞 →
// `blob-<offset>.bin` 兜底），保证**每个 blob 都写出、不覆盖**，最终写出名如实记进 assets[].file。
//
// 本套两层验证：① 纯函数 uniqueAssetName 的碰撞消歧 / null 回落 / 兜底分支；② 经 runAssets 的 DI seam
// 注入合成 blobs + buf 真跑写盘逻辑（不读真二进制），断言同名两 blob 写出两个不同文件、都非空、字节各自
// 正确（内容不同 ⇒ 无覆盖）、assets[].file 反映真实名、null-name blob 落 `blob-<offset>.bin`。
// revert-red：把 uniqueAssetName 的 tiebreaker 去掉（回到直接 basename）→ 同名两 blob 写成同名、
// 只剩一个 / 内容被覆盖 → 本套变红。
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { uniqueAssetName } from '../lib/naming.mjs'
import { runAssets } from '../cli.mjs'

const created = []
function tmp() {
  const d = mkdtempSync(join(tmpdir(), 'unbun-assets-collision-'))
  created.push(d)
  return d
}
afterAll(() => {
  for (const d of created) rmSync(d, { recursive: true, force: true })
})

// ── 层①：纯函数 uniqueAssetName 命名逻辑 ──────────────────────────────────────────
test('uniqueAssetName：首个不冲突保持原 basename', () => {
  const used = new Set()
  expect(uniqueAssetName('/$bunfs/root/a/x.node', 10, used)).toBe('x.node')
  expect(used.has('x.node')).toBe(true)
})

test('uniqueAssetName：同名碰撞 → offset 消歧 <stem>-<offset><ext>，与首个不同', () => {
  const used = new Set()
  const first = uniqueAssetName('/$bunfs/root/a/x.node', 10, used)
  const second = uniqueAssetName('/$bunfs/root/b/x.node', 100, used) // basename 同为 x.node
  expect(first).toBe('x.node')
  expect(second).toBe('x-100.node')
  expect(second).not.toBe(first)
  expect(used.has('x-100.node')).toBe(true)
})

test('uniqueAssetName：无扩展名的 stem 也正确消歧', () => {
  const used = new Set()
  expect(uniqueAssetName('/$bunfs/root/a/blob', 10, used)).toBe('blob')
  expect(uniqueAssetName('/$bunfs/root/b/blob', 42, used)).toBe('blob-42')
})

test('uniqueAssetName：name 为 null/空 → 回落 blob-<offset>.bin', () => {
  const used = new Set()
  expect(uniqueAssetName(null, 200, used)).toBe('blob-200.bin')
  expect(uniqueAssetName('', 300, used)).toBe('blob-300.bin')
})

test('uniqueAssetName：消歧名仍撞 → 兜底 blob-<offset>.bin（每 offset 唯一，恒不覆盖）', () => {
  const used = new Set(['x.node', 'x-50.node']) // 预占：basename 与消歧名都已被用
  expect(uniqueAssetName('/$bunfs/root/c/x.node', 50, used)).toBe('blob-50.bin')
})

test('uniqueAssetName：一批含重复 basename 的 blob，返回名两两不同（无覆盖不变式）', () => {
  const used = new Set()
  const blobs = [
    { name: '/$bunfs/root/a/x.node', offset: 10 },
    { name: '/$bunfs/root/b/x.node', offset: 20 },
    { name: '/$bunfs/root/c/x.node', offset: 30 },
    { name: null, offset: 40 },
    { name: '/$bunfs/root/d/y.js', offset: 50 },
  ]
  const names = blobs.map((b) => uniqueAssetName(b.name, b.offset, used))
  expect(new Set(names).size).toBe(blobs.length) // 全唯一 ⇒ 写盘不覆盖
})

// ── 层②：经 runAssets DI seam 真跑写盘逻辑（合成 blobs + buf，不读真二进制）───────────
test('runAssets 同名碰撞：写出两个不同文件、字节各自正确、无覆盖、assets[].file 反映真实名', () => {
  const out = tmp()
  // 合成 buf：在选定 offset 放各不相同的字节图案，写盘后可逐 blob 逐字节复核。
  const buf = Buffer.alloc(300)
  buf.fill(0xaa, 10, 15) // blob A 内容
  buf.fill(0xbb, 100, 107) // blob B 内容
  buf.fill(0xcc, 200, 203) // blob C（null name）内容
  buf.fill(0x11, 250, 260) // 入口 blob 内容（应被跳过、不落盘）
  const blobs = [
    { name: '/$bunfs/root/a/x.node', offset: 10, length: 5, loader: 'file', isEntry: false },
    { name: '/$bunfs/root/b/x.node', offset: 100, length: 7, loader: 'file', isEntry: false }, // 同 basename
    { name: null, offset: 200, length: 3, loader: 'file', isEntry: false }, // null-name 回落
    { name: '/$bunfs/root/cli.js', offset: 250, length: 10, loader: 'js', isEntry: true }, // 入口，跳过
  ]

  const { outdir, assets } = runAssets({ outdir: out, blobs, buf })
  expect(outdir).toBe(out)

  // 入口跳过 → 3 个资产；落盘文件数 === 资产数（无覆盖，否则会少一个）
  expect(assets.length).toBe(3)
  const onDisk = readdirSync(out).sort()
  expect(onDisk.length).toBe(3)

  // 同名两 blob 写成两个不同文件名，null-name 落 blob-<offset>.bin
  const files = assets.map((a) => a.file)
  expect(files).toContain('x.node')
  expect(files).toContain('x-100.node')
  expect(files).toContain('blob-200.bin')
  expect(new Set(files).size).toBe(3) // 全唯一

  // 每个资产：文件存在、非空、字节 === 对应 blob 的 buf.subarray（逐 offset 复核）
  for (const a of assets) {
    const p = join(out, a.file)
    expect(existsSync(p)).toBe(true)
    const bytes = readFileSync(p)
    expect(bytes.length).toBeGreaterThan(0)
    const want = buf.subarray(a.offset, a.offset + a.length)
    expect(Buffer.compare(bytes, want)).toBe(0)
  }

  // 关键无覆盖证据：x.node 与 x-100.node 内容不同（若覆盖，二者会同为后写者的字节）
  const aBytes = readFileSync(join(out, 'x.node'))
  const bBytes = readFileSync(join(out, 'x-100.node'))
  expect(aBytes.length).toBe(5)
  expect(bBytes.length).toBe(7)
  expect(aBytes.every((x) => x === 0xaa)).toBe(true)
  expect(bBytes.every((x) => x === 0xbb)).toBe(true)

  // blob-<offset>.bin 回落分支内容正确（评审 m1 指出未测）
  const cBytes = readFileSync(join(out, 'blob-200.bin'))
  expect(cBytes.length).toBe(3)
  expect(cBytes.every((x) => x === 0xcc)).toBe(true)
})
