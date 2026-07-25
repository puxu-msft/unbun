// test/mmap-reader.test.mjs — 证 mmap 主路径命中 + ETXTBSY 回落 pread + 两路字节等价 + close 释放映射
// + oracle 保全。对应 lib/bun-binary.mjs 的 readBinary「mmap 主 + pread 回落」混合 reader。
//
// 核心风险面（各测都非空、可 revert-to-red）：
//   ① 主路径真走 mmap（非运行文件）——spy Bun.mmap 命中、reader 正确、sections 解出。
//   ② ETXTBSY 回落（本混合的**存在理由**）：运行中二进制无法 mmap → 必回落 pread、结果正确。
//      两法证：mock Bun.mmap 抛 ETXTBSY（确定性）；真运行中 bun（process.execPath，真 ETXTBSY，零 mock）。
//      revert：去掉 readBinary 的 mmap try/catch 回落 → mmap 抛直接冒泡 → 这些测试 RED（回落非空）。
//   ③ 两路字节等价：同一文件经 mmap-reader 与 forced-pread（mock mmap 抛）解出的 size/sections/字节
//      逐一致——mmap 与 pread 后端对下游是**可互换**的（下游零改动的前提）。
//   ④ close() 丢弃映射引用：close 后 slice 抛「used after close」（映射页可被 GC 回收，Bun.mmap 无显式
//      munmap）；多次 readBinary+close 无累积常驻内存。
import { test, expect, beforeAll, spyOn } from 'bun:test'
import { readFileSync, statSync } from 'node:fs'
import { readBinary } from '../lib/bun-binary.mjs'
import { cachedMiniFixture } from './fixtures/build-fixture.mjs'

let mini // 真 bun --compile SFX（非运行 → mmap 主路径命中）
beforeAll(() => {
  mini = cachedMiniFixture().miniPath
})

const throwsEtxtbsy = () => spyOn(Bun, 'mmap').mockImplementation(() => {
  const e = new Error('ETXTBSY: text file is busy, open')
  e.code = 'ETXTBSY'
  throw e
})

// ① 主路径：非运行文件 → readBinary 走 Bun.mmap（不 openSync），reader 正确解出 .bun。
test('mmap main path: readBinary maps a non-running SFX and parses sections', () => {
  const spy = spyOn(Bun, 'mmap')
  let r
  try {
    r = readBinary(mini)
    expect(spy.mock.calls.filter((c) => c[0] === mini).length).toBe(1) // mmap 命中一次
    expect(r.sections['.bun']).toBeDefined()
    expect(r.sections['.bun'].size).toBeGreaterThan(0)
    expect(r.u32(0)).toBe(0x464c457f) // ELF magic（小端）
    expect(r.elf.shoff + r.elf.shentsize * r.elf.shnum).toBe(r.size) // 段头表尾贴 EOF
  } finally {
    spy.mockRestore()
    r?.close()
  }
})

// ②a ETXTBSY 回落（mock，确定性）：mmap 抛 ETXTBSY → readBinary 必回落 pread、不崩、结果正确。
// revert 证：去掉 readBinary 的 try/catch 回落 → 此处 readBinary 抛 ETXTBSY = RED（已手工 revert 验红）。
test('ETXTBSY fallback (mocked): mmap throws → readBinary falls back to pread, result correct', () => {
  const spy = throwsEtxtbsy()
  let r
  try {
    r = readBinary(mini) // mmap 抛 → 必回落 pread（否则崩 = 回落逻辑没了）
    expect(r.sections['.bun']).toBeDefined()
    expect(r.u32(0)).toBe(0x464c457f)
  } finally {
    spy.mockRestore()
    r?.close()
  }
})

// ②b 真 ETXTBSY（零 mock）：process.execPath 是**正在运行**的 bun → Bun.mmap 真抛 ETXTBSY → readBinary
// 回落 pread。这是本混合的**实战场景**（活二进制被本会话执行时的 unbun 自映射）。用独立全读 oracle 验字节。
test('real ETXTBSY: readBinary handles a running executable via pread fallback (no mock)', () => {
  const running = process.execPath // 正在跑的 bun 二进制 → mmap ETXTBSY
  const r = readBinary(running)
  try {
    expect(r.size).toBe(statSync(running).size)
    expect(Buffer.from(r.slice(0, 4))).toEqual(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) // \x7fELF
    const oracle = readFileSync(running) // 独立全读 oracle
    const win = 1 << 16
    expect(Buffer.from(r.slice(0, win))).toEqual(oracle.subarray(0, win)) // 首窗字节逐一致
    expect(Buffer.from(r.slice(r.size - win, win))).toEqual(oracle.subarray(r.size - win)) // 尾窗字节逐一致
  } finally {
    r.close()
  }
})

// ③ 两路字节等价：mmap-reader vs forced-pread（mock mmap 抛）解出的 size/sections/字节逐字一致，
// 证两后端对下游可互换（module-graph/extract/layout/assets 零改动的前提）。
test('mmap reader and pread fallback yield byte-identical views for the same file', () => {
  const viaMmap = readBinary(mini)
  let viaPread
  const spy = throwsEtxtbsy()
  try {
    viaPread = readBinary(mini) // mmap 抛 → pread 后端
  } finally {
    spy.mockRestore()
  }
  try {
    expect(viaPread.size).toBe(viaMmap.size)
    expect(Object.keys(viaPread.sections).sort()).toEqual(Object.keys(viaMmap.sections).sort())
    expect(viaPread.sections['.bun']).toEqual(viaMmap.sections['.bun'])
    expect(viaPread.elf).toEqual(viaMmap.elf)
    const bun = viaMmap.sections['.bun']
    // 字节等价：头 64B、.bun 段头 4KB、u32/toString/lastIndexOf 各判据一致
    expect(Buffer.from(viaPread.slice(0, 64))).toEqual(Buffer.from(viaMmap.slice(0, 64)))
    expect(Buffer.from(viaPread.slice(bun.off, Math.min(4096, bun.size)))).toEqual(
      Buffer.from(viaMmap.slice(bun.off, Math.min(4096, bun.size))),
    )
    expect(viaPread.u32(0)).toBe(viaMmap.u32(0))
    expect(viaPread.toString('latin1', 0, 4)).toBe(viaMmap.toString('latin1', 0, 4))
    const needle = Buffer.from('---- Bun! ----')
    expect(viaPread.lastIndexOf(needle, bun.off, bun.off + bun.size)).toBe(
      viaMmap.lastIndexOf(needle, bun.off, bun.off + bun.size),
    )
  } finally {
    viaMmap.close()
    viaPread.close()
  }
})

// ④a close() 丢弃映射引用：close 后 slice 抛「used after close」——证引用被丢弃（映射页可被 GC 回收，
// Bun.mmap 无显式 munmap，靠丢引用 + GC）。fail-loud 防 close 后悬垂使用。
test('close() drops the mmap reference (use-after-close throws)', () => {
  const r = readBinary(mini)
  expect(r.u32(0)).toBe(0x464c457f)
  r.close()
  expect(() => r.slice(0, 4)).toThrow(/used after close/)
})

// ④a' 回落路径（PreadReader）close 后同样抛「used after close」——消息与 BufferBackedReader 统一
// （否则 readSync(null,…) 抛 ERR_INVALID_ARG_TYPE，信息不一致）。mock mmap 抛 ETXTBSY 逼出 pread 后端。
test('pread fallback reader also throws used-after-close (consistent message)', () => {
  const spy = throwsEtxtbsy()
  let r
  try {
    r = readBinary(mini) // mmap 抛 → PreadReader
  } finally {
    spy.mockRestore()
  }
  expect(r.u32(0)).toBe(0x464c457f)
  r.close()
  expect(() => r.slice(0, 4)).toThrow(/used after close/)
})

// ④b 无映射泄漏：多次 readBinary（触碰头+段头几页）+ close + GC 后常驻内存不累积（每次只触碰几页，
// GC 回收；非 readFileSync 全读 → 不该线性涨）。宽松上界，只抓「每次全常驻/映射不释放」这种大泄漏。
test('repeated readBinary+close does not accumulate resident memory', () => {
  const rss0 = process.memoryUsage().rss
  for (let i = 0; i < 40; i++) {
    const r = readBinary(mini)
    r.slice(0, 64)
    const bun = r.sections['.bun']
    r.slice(bun.off, Math.min(4096, bun.size))
    r.close()
  }
  Bun.gc(true)
  const grewMB = (process.memoryUsage().rss - rss0) / 1048576
  expect(grewMB).toBeLessThan(80) // 无累积映射（40 次仅触碰几页；若映射不释放会线性膨胀到 GB 级）
})
