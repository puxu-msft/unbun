// test/outdir-naming.test.mjs — E3 = A4：4 命令默认 outdir 命名统一为 `claude-code-<version||basename>`。
//
// 背景（改前分歧）：extract 用 version||basename、split 回落字面 'app'、assets/layout **只用 basename、
// 从不解析 version**。活二进制恰落在 `versions/<x.y.z>/` 下、basename==version 而巧合一致；但换名副本 /
// 通用 SFX 下 basename≠version 时，同一二进制会分裂成 `claude-code-<version>/`（extract）与
// `claude-code-<basename>/`（assets/layout）两个目录，下游 rebuild/diff 找不到配套目录。
//
// 本测试证明「统一 + 非空」：
//   ① outdirName helper 纯单测（version 优先、回落 basename）——统一命名规则的单一真相源。
//   ② 真二进制：assets/layout 的 version 解析路径（versionFromBlobs）=== extract 的 version
//      （extractApp）=== layout 的 version（computeLayout），且 outdirName 三者一致。
//   ③ **核心非空 · basename≠version 场景**：造一个含 version 锚、文件名 `renamed-copy`（≠ 锚里的
//      9.9.9）的 SFX；extract/assets/layout/split 四条 version 解析路径都解出 9.9.9 → outdirName 全为
//      `claude-code-9.9.9`（**非** `claude-code-renamed-copy`）。改前 assets/layout 用 basename 会命
//      `claude-code-renamed-copy` → 与 extract 分裂；此例正是暴露改前分歧的判别式（basename==version
//      的活二进制掩盖不了它）。
import { test, expect } from 'bun:test'
import { basename } from 'node:path'
import { readBinary, defaultBinary } from '../lib/bun-binary.mjs'
import { parseModuleGraph } from '../lib/module-graph.mjs'
import { extractApp, versionFromBlobs } from '../lib/extract.mjs'
import { computeLayout } from '../lib/layout.mjs'
import { outdirName } from '../lib/naming.mjs'
import { cachedVersionAnchorFixture } from './fixtures/build-fixture.mjs'

test('outdirName helper：version 优先、回落 basename（纯单测）', () => {
  // version 命中 → 按 version 命名（无视 basename）。
  expect(outdirName('/opt/versions/2.1.205/claude', '2.1.205')).toBe('claude-code-2.1.205')
  expect(outdirName('/x/mybin', '2.1.205')).toBe('claude-code-2.1.205') // basename≠version → 仍用 version
  // 无 version（null / undefined / 空串）→ 回落 basename。
  expect(outdirName('/x/mybin', null)).toBe('claude-code-mybin')
  expect(outdirName('/x/mybin', undefined)).toBe('claude-code-mybin')
  expect(outdirName('/x/mybin', '')).toBe('claude-code-mybin')
  // 回落取 basename（非整路径）。
  expect(outdirName('/a/b/c/app.js', null)).toBe('claude-code-app.js')
})

test('真二进制：extract / assets·layout / layout 三条 version 解析路径一致 → 同名', () => {
  const bin = defaultBinary()

  // extract 的路径（extractApp）
  const vExtract = extractApp(bin).version

  // assets 的路径（runAssets 内部：readBinary → parseModuleGraph → versionFromBlobs）
  const pre = readBinary(bin)
  const { blobs } = parseModuleGraph(bin, pre)
  const vAssets = versionFromBlobs(pre, blobs) // P4：versionFromBlobs 取 reader（非 buf），复用同一 fd
  pre.close()

  // layout 的路径（computeLayout 内部解出 version 并透出）
  const vLayout = computeLayout(bin).version

  // 三条路径解出同一 version（活二进制 P0-d 锚必命中，非空 x.y.z）
  expect(vExtract).toMatch(/^\d+\.\d+\.\d+$/)
  expect(vAssets).toBe(vExtract)
  expect(vLayout).toBe(vExtract)

  // → outdirName 三者一致（4 命令对同一二进制产出同一 `claude-code-<version>` 目录段）
  const nExtract = outdirName(bin, vExtract)
  expect(outdirName(bin, vAssets)).toBe(nExtract)
  expect(outdirName(bin, vLayout)).toBe(nExtract)
  expect(nExtract).toBe(`claude-code-${vExtract}`)
}, 30_000)

test('核心非空：basename≠version 的换名副本 → 4 命令仍同名 `claude-code-<version>`（暴露改前分歧）', () => {
  // 造含 version 锚（9.9.9）、文件名 `renamed-copy`（≠9.9.9）的 SFX：basename≠version 场景。共享缓存复用。
  const { binPath, version } = cachedVersionAnchorFixture({ name: 'renamed-copy', version: '9.9.9' })
  expect(basename(binPath)).toBe('renamed-copy') // 前提：basename≠version（否则掩盖分歧）
  expect(version).toBe('9.9.9')

  // 四条 version 解析路径（正是 4 命令各自内部所用的那条）：
  const vExtract = extractApp(binPath).version                 // extract
  const pre = readBinary(binPath)
  const { blobs } = parseModuleGraph(binPath, pre)
  const vAssets = versionFromBlobs(pre, blobs)                 // assets（P4：versionFromBlobs 取 reader）
  pre.close()
  const vLayout = computeLayout(binPath).version              // layout
  const vSplit = extractApp(binPath).version                  // split（二进制输入分支走 extractApp）

  // 全部解出锚里的 9.9.9（assets/layout 改前只用 basename、根本不解析 version → 此处会是 undefined/basename）
  for (const v of [vExtract, vAssets, vLayout, vSplit]) expect(v).toBe('9.9.9')

  // → outdirName 四者全为 `claude-code-9.9.9`（统一），且**非** `claude-code-renamed-copy`（改前 assets/
  //   layout 用 basename(bin) 会命中的、与 extract 分裂的名字）。这是改前分歧的判别式。
  const names = [vExtract, vAssets, vLayout, vSplit].map((v) => outdirName(binPath, v))
  for (const n of names) {
    expect(n).toBe('claude-code-9.9.9')
    expect(n).not.toBe('claude-code-renamed-copy') // 改前 assets/layout 的 basename 命名
  }
  // 一致性判别式：四者互等（唯一目录名，下游 rebuild/diff 能找到配套目录）
  expect(new Set(names).size).toBe(1)
}, 60_000)
