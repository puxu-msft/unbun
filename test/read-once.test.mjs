// test/read-once.test.mjs — 证明「每命令对同一 bin 只访问一次」（不重复映射/开 fd、不赔回 E1 的单次读）。
//
// P4 前：readBinary 用 readFileSync 全读；E1 判据是 spyOn(readFileSync) 数「以 bin 为参的读」=1。
// P4：readBinary 改为 openSync(fd) + 定点 pread；判据迁到 spyOn(openSync) 数「以 bin 为参的 open」。
// 现（mmap 混合）：readBinary **主路径走 Bun.mmap**（非运行文件命中 mmap，不再 openSync），运行中二进制
// （ETXTBSY）才回落 openSync pread。故「访问一次」的判据升级为**同时 spy Bun.mmap + openSync**，数二者
// 对同一 bin 的访问**合计**——一条命令对同一 bin 恰 1 次（extractApp / computeLayout / runAssets 各内部
// readBinary 一次 + parseModuleGraph 复用同一 reader，不重映射/重开）。fixture mini 非运行 → 走 mmap
// （mmap=1, open=0, 合计 1）。改前若把 parseModuleGraph 的 preRead 复用去掉（各自再 readBinary）→ 合计
// 变 2 = RED，故本判据**非空**（能抓「重复映射/重开 fd / 重复读整块」回归）。
//
// 另两路判别式（都非空、都 revert-to-red 可红）：
//   ② preRead 诚实性：parseModuleGraph(不存在的 bin, 合法 preRead reader) 必须用 preRead 解出 blobs
//      而**不重开 bin**；若忽略 preRead 去 open 不存在路径 → ENOENT 抛（改前无 preRead 参必抛 = RED）。
//   ③ 单参/preRead 路径等价：两条路径解出的 { trailerOffset, entryPointId, blobs } 逐字段一致。
import { test, expect, beforeAll, spyOn } from 'bun:test'
import * as fs from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readBinary } from '../lib/bun-binary.mjs'
import { parseModuleGraph } from '../lib/module-graph.mjs'
import { extractApp } from '../lib/extract.mjs'
import { computeLayout } from '../lib/layout.mjs'
import { runAssets } from '../cli.mjs'
import { cachedMiniFixture } from './fixtures/build-fixture.mjs'

const tmp = (p) => mkdtempSync(join(tmpdir(), p))

let mini // 真 bun --compile SFX（共享 FS 缓存、跨文件复用）
beforeAll(() => {
  mini = cachedMiniFixture().miniPath
})

// 计数辅助：同时 spy Bun.mmap（主路径）+ fs.openSync（回落路径），只数「以 path 为第一参」的访问
// （滤掉 buildFixture / 写盘等无关 open）。spy 保留原实现（真映射/真开 fd），只在 fn() 执行期计数，事后
// restore。Bun.mmap 走**原生** open syscall（非 fs.openSync），故非运行文件走 mmap 时 openSync 计 0。
function countAccessOf(path, fn) {
  const openSpy = spyOn(fs, 'openSync')
  const mmapSpy = spyOn(Bun, 'mmap')
  try {
    fn()
    const opens = openSpy.mock.calls.filter((c) => c[0] === path).length
    const mmaps = mmapSpy.mock.calls.filter((c) => c[0] === path).length
    return opens + mmaps // 总二进制访问次数（映射 + 开 fd 合计）
  } finally {
    openSpy.mockRestore()
    mmapSpy.mockRestore()
  }
}

test('extractApp accesses the binary exactly once (no re-map/re-open, no double full read)', () => {
  expect(countAccessOf(mini, () => { extractApp(mini) })).toBe(1)
})

test('computeLayout accesses the binary exactly once', () => {
  expect(countAccessOf(mini, () => { computeLayout(mini) })).toBe(1)
})

test('runAssets accesses the binary exactly once', () => {
  const outdir = tmp('unbun-readonce-assets-')
  expect(countAccessOf(mini, () => { runAssets({ bin: mini, outdir }) })).toBe(1)
})

// 判别式：parseModuleGraph(bin, preRead) 必须诚实用 preRead reader 且**不重开 bin**。传不存在的 bin
// 路径 + 合法 preRead reader：诚实 → 成功解出 blobs；忽略 preRead 重开 bin → ENOENT。改前必抛 = RED。
test('parseModuleGraph honors preRead reader and does not re-open bin', () => {
  const pre = readBinary(mini)
  try {
    const { blobs } = parseModuleGraph('/no/such/unbun-bin-does-not-exist', pre)
    expect(blobs.length).toBeGreaterThan(0)
  } finally {
    pre.close()
  }
})

// 回归：单参调用（无 preRead）自开自关 fd；传 preRead reader 路径与单参结果逐字段一致（透传不改解码）。
test('parseModuleGraph single-arg unchanged; preRead reader path equivalent', () => {
  const a = parseModuleGraph(mini)
  const pre = readBinary(mini)
  try {
    const b = parseModuleGraph(mini, pre)
    expect(b.trailerOffset).toBe(a.trailerOffset)
    expect(b.entryPointId).toBe(a.entryPointId)
    expect(b.blobs).toEqual(a.blobs)
  } finally {
    pre.close()
  }
})
