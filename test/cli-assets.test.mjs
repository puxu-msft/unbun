// test/cli-assets.test.mjs — assets 子命令：静态解析 module-graph 切「非入口」资产 blob 落盘。
// 真 claude 二进制纯读（defaultBinary，不执行）→ 把每个非入口 blob 写成独立文件到自建临时 outdir。
// 断言结构 / 行为：写出 ≥2 文件、≥2 个 ELF magic（那俩 .node）、每文件非空且字节 === 对应 blob 的
// buf.subarray、具名文件名来自 blob.name basename。**绝不断言含 sourcemap.json**（FINDINGS P0-e：
// 二进制无内嵌 sourcemap）、绝不 byte-pin 专有文案。临时目录 mkdtempSync，afterAll 只清自己建的。
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { defaultBinary } from '../lib/bun-binary.mjs'
import { parseModuleGraph } from '../lib/module-graph.mjs'
import { runAssets } from '../cli.mjs'

const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46]) // \x7fELF

const created = []
function tmp() {
  const d = mkdtempSync(join(tmpdir(), 'unbun-assets-'))
  created.push(d)
  return d
}
afterAll(() => {
  for (const d of created) rmSync(d, { recursive: true, force: true })
})

test('assets：切非入口 blob 落盘（≥2 文件、≥2 ELF、字节自证、具名 basename）', () => {
  const out = tmp()
  const bin = defaultBinary()
  const { outdir, assets } = runAssets({ bin, outdir: out })
  expect(outdir).toBe(out)

  // 独立 oracle：直接解 graph，非入口 blob 集就是资产集（不依赖被测函数自证的 assets）。
  // P4 后 readBinary 是按需 pread 的 reader、不再全读；buf 用 readFileSync 自读作字节比对 oracle。
  const buf = readFileSync(bin)
  const { blobs } = parseModuleGraph(bin)
  const nonEntry = blobs.filter((b) => !b.isEntry)
  expect(nonEntry.length).toBeGreaterThanOrEqual(2)

  // 返回的 assets 数 === 非入口 blob 数；落盘文件数 === assets 数
  expect(assets.length).toBe(nonEntry.length)
  const onDisk = readdirSync(out)
  expect(onDisk.length).toBe(assets.length)

  // 每个资产：文件存在、非空、字节 === 对应 blob 的 buf.subarray（用独立 oracle 的 blob 复核）
  let elfCount = 0
  for (const a of assets) {
    const p = join(out, a.file)
    expect(existsSync(p)).toBe(true)
    const bytes = readFileSync(p)
    expect(bytes.length).toBeGreaterThan(0)

    // 用 name（若有）或 offset 在独立 oracle 里定位对应 blob，字节逐一比对
    const b = nonEntry.find((x) => x.offset === a.offset)
    expect(b).toBeDefined()
    const want = buf.subarray(b.offset, b.offset + b.length)
    expect(bytes.length).toBe(want.length)
    expect(Buffer.compare(bytes, want)).toBe(0)

    // 具名文件名来自 blob.name basename（name 有内联名时）；回落 blob-<offset>.bin
    if (b.name) expect(a.file).toBe(basename(b.name))

    if (bytes.length >= 4 && bytes.subarray(0, 4).equals(ELF)) elfCount++
  }

  // ≥2 个资产以 ELF magic 开头（那俩 .node）——资产 blob 用 magic 头自证
  expect(elfCount).toBeGreaterThanOrEqual(2)

  // 具名 basename 命中：活二进制含 image-processor.node / audio-capture.node
  const names = assets.map((a) => a.file)
  expect(names).toContain('image-processor.node')
  expect(names).toContain('audio-capture.node')

  // FINDINGS P0-e：无内嵌 sourcemap → 资产集不含 sourcemap.json（反向断言，防未来误造）
  expect(names).not.toContain('sourcemap.json')
}, 30_000)
