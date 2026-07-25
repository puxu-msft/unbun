// test/loader-aware-headsniff.test.mjs — module-graph 自证的 head sniff **按 loader 分类** 的回归。
//
// 背景（真 bug，dogfooding 于 claude 2.1.206 暴露）：旧实现用一张对**所有** blob 生效的头字节白名单
//   HEAD_MARKERS = ['// @bun','@bun-cjs','\x7fELF','"use strict"','#!']。2.1.206 新增内嵌资产
//   chart.umd.min.js（Chart.js，file loader，头是 `/*!` 法律注释 banner）不在白名单 → parseModuleGraph
//   对该 file 资产 fail-loud 误报 throw。根因：head-marker sniff 对 **file-loader 资产天然脆弱**——
//   file 资产内容任意（mermaid 是 `"use strict"`、chart 是 `/*!`、下一个又可能是别的），每加一个新内嵌
//   file 资产就误报一次。真正的守卫是**结构不变式**（offset 数学 + 边界无重叠 + 末 blob 贴记录数组），
//   对所有 blob（含 file）照旧生效；head sniff 只是冗余末端、仅对「头类型已知」的类别有意义。
//
// 修复：head sniff 按 loader 分类——js 族（jsx/js/ts/tsx）+ 入口 blob 仍要求 JS 类 marker；napi 仍要求
//   ELF；file/json/css/toml/wasm/未知 loader **跳过** head sniff，靠结构不变式兜。
//
// 本测试是该修复的**活见证**（走真 bun --compile fixture、真 parseModuleGraph 真 pread）：
//   ① 载体 = `mini` fixture，其内嵌 tiny.txt 是 **file loader** 且头**故意**是 `/*!`（复刻 chart 场景、
//      非任何 JS/ELF marker）→ parseModuleGraph **不再 throw**、切出该 file blob。若把自证退回「所有 blob
//      都查 head」（revert-red），此 `/*!` file 资产会立刻 fail-loud「no marker」→ 证本测非空、真兜 bug。
//   ② 入口 blob（js loader）**仍**含 JS marker → 证 js 分支的 head 检查未被削弱、照旧有意义（drift 兜底）。
// 结构不变式未弱化的证据（篡改 RECORD_SIZE/OFFSETS_SIZE 仍 throw）见 module-graph.test.mjs + 手验记录。
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { parseModuleGraph } from '../lib/module-graph.mjs'
import { cachedMiniFixture } from './fixtures/build-fixture.mjs'

// 独立 oracle：JS/ELF marker 常量在此重述（不 import module-graph 私有的 JS_HEAD_MARKERS），作独立判据。
const JS_MARKERS = ['// @bun', '@bun-cjs', '"use strict"', '#!']
const ELF_MARKER = '\x7fELF'
const anyMarker = (head) => JS_MARKERS.some((m) => head.includes(m)) || head.includes(ELF_MARKER)

test('loader-aware head sniff: file-loader asset with a non-marker head (/*!) does NOT throw', () => {
  const mini = cachedMiniFixture().miniPath
  const buf = readFileSync(mini) // 独立 oracle：全读整块自行取头字节校验
  // 真 parseModuleGraph（含 fail-loud 自证）在含 `/*!`-headed file 资产的 SFX 上必须成功。
  let blobs
  expect(() => {
    ;({ blobs } = parseModuleGraph(mini))
  }).not.toThrow()
  expect(blobs.length).toBeGreaterThanOrEqual(2)

  const head = (b) => buf.subarray(b.offset, b.offset + Math.min(b.length, 64)).toString('latin1')

  // ① file-loader 资产（tiny.txt）：头是 `/*!`（非任何 JS/ELF marker），却被无 throw 切出 → 证 file 类
  //    跳过了 head sniff（否则旧 all-blobs 白名单会在此 fail-loud）。这正是 2.1.206 chart.umd.min.js 场景。
  const fileBlobs = blobs.filter((b) => b.loader === 'file')
  expect(fileBlobs.length).toBeGreaterThanOrEqual(1)
  const arbitrary = fileBlobs.find((b) => !anyMarker(head(b)))
  expect(arbitrary).toBeTruthy() // 确有一个「头非白名单」的 file 资产（tiny.txt 头 `/*!`）
  expect(head(arbitrary).startsWith('/*!')).toBe(true) // 独立复核其头确是 `/*!`（非 marker）

  // ② 入口 blob（js loader）**仍**含 JS marker → js 分支的 head 检查照旧生效、未被削弱。
  const entry = blobs.find((b) => b.isEntry)
  expect(entry).toBeTruthy()
  expect(anyMarker(head(entry))).toBe(true)
})
