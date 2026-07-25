// lib/module-graph.mjs — 定位 .bun 内真 trailer + 解码 Bun StandaloneModuleGraph。
//
// 这是 Stage 0 闸门的收口：把 bun-binary.mjs 给出的 ELF `.bun` 字节窗口，解成
// 一组具名 blob（模块/资产）。下游 extract/assets/split/layout 只消费
// `parseModuleGraph(bin) → { trailerOffset, entryPointId, blobs }`，不再碰原始字节布局。
//
// 字节级布局权威见 tools/unbun/docs/FINDINGS-phase0.md（Task 0.2 已逆向确证、跨
// 195/201/205 三版核验）。此处只固化两个实证结构常量：sizeof(Offsets)=32、记录
// =52 字节。二者未来 Bun 版本可能变，故解码后 **fail-loud 自证**（名含 $bunfs +
// contents 头字节按 loader 分类 sniff + 边界不变式），自证失败即显式 throw，绝不静默产坏切片。
//
// P4：全程走 BinaryReader 的按需 pread（reader.slice/u32/toString/lastIndexOf），**从不**把整块
// 二进制读进内存。trailer 恒在 .bun 尾，只 pread 一个宽裕尾窗搜 magic；Offsets 头/记录数组各 pread
// 一次；名字与 64B 自证头逐 blob 小 pread。总读取量 ~几 MB，而非整块 257MB。
import { readBinary } from './bun-binary.mjs'

// trailer（真 magic）恒在 .bun 段**末尾** ~50KB 内。只 pread 这个宽裕尾窗（2MB）搜 lastIndexOf，
// 避免把整块 .bun（活 claude ~245MB）读进来。极端情形（尾窗内没找到）回落全窗搜——宁可慢也不静默错。
const TRAILER_WINDOW = 2 * 1024 * 1024

const MAGIC = Buffer.from('---- Bun! ----') // 无换行 14 字节（真 trailer 是 "\n---- Bun! ----\n"）

// 实证结构常量（FINDINGS-phase0.md P0-a）——带自证，勿当作永恒真理。
const OFFSETS_SIZE = 32 // sizeof(Offsets)：trailer 前 32 字节头
const RECORD_SIZE = 52 // 每条模块记录 13×u32

// Bun `Loader` enum（byte[record+49]）。分类只用 byte[49]（FINDINGS 降级项 #3）。
const LOADER = {
  0: 'jsx', 1: 'js', 2: 'ts', 3: 'tsx', 4: 'css',
  5: 'file', 6: 'json', 7: 'toml', 8: 'wasm', 9: 'napi', 10: 'napi/node',
}

// contents 头字节 sniff：**按 loader 分类**（latin1，取每个 blob 前 64 字节判存在）。
// 这是**冗余末端 sniff**——真正钉死切片的是下面的**结构不变式**（graph_base+cOff 的 offset 数学、
// 边界无重叠、末 blob 贴记录数组）。head sniff 只在「头类型已知」时有附加意义，故按 loader 分类：
//
//   • js 族（jsx/js/ts/tsx）+ 入口 blob：头**必**含 JS 类 marker。cli.js/*.js 走 `@bun-cjs`
//     （在首行注释里，非 byte0）；`// @bun` 是 bun `--compile` 通用 bundle banner——claude 的入口是
//     **预打包 CJS**（含 `@bun-cjs`），而一个直接 `bun build --compile` 的 ESM 入口（如自建 fixture）
//     头是 `// @bun\n…`（无 `@bun-cjs`）；收录该 banner 使解析对任意 bun SFX 通用（版本/构建无关）。
//     入口本体恒是 JS bundle → 无论其 loader 字节读成什么都强制此检查（多一道守卫）。
//   • napi（napi/napi.node）：头**必** `\x7fELF`（byte0）。
//   • file/json/css/toml/wasm/其它「任意-内容」loader（如 5=file）：**跳过** head sniff——
//     file-loader 资产内容任意（mermaid 头是 `"use strict"`、chart.umd.min.js 头是 `/*!` 法律 banner、
//     下个新内嵌 file 资产可能又是别的甚至非 JS 文件），用 JS/ELF 头字节 sniff 它天然脆弱、每加一个新
//     file 资产就误报一次。这类 blob 的正确性仍由**结构不变式**（offset 落在文件内、边界无重叠、
//     name 是 `$bunfs` 路径）照旧强制兜住——head sniff 对它们既无意义也不该做。
const JS_HEAD_MARKERS = ['// @bun', '@bun-cjs', '"use strict"', '#!']
const NAPI_HEAD_MARKER = '\x7fELF'
const JS_LOADERS = new Set(['jsx', 'js', 'ts', 'tsx']) // Bun Loader enum 0/1/2/3
const NAPI_LOADERS = new Set(['napi', 'napi/node']) // Bun Loader enum 9/10

// preRead（可选）：上游若已 readBinary(bin) 过，把 **reader** 透传进来复用，避免重复 openSync + 重复
// pread（活 claude 257MB）。未传则照旧自开 reader（保持既有单参调用不变、向后兼容），并在返回前 close
// 自己开的 fd（解码只在本函数内用 reader，blobs 是纯 offset/length/name 元数据、返回后不再需要 reader）。
export function parseModuleGraph(bin, preRead = null) {
  const reader = preRead ?? readBinary(bin)
  const ownReader = !preRead // 自开的 fd 自己关；透传进来的由调用方持有、不在此关
  try {
    const bun = reader.sections['.bun']
    if (!bun) throw new Error('parseModuleGraph: no .bun section (not a Bun --compile SFX?)')
    const winEnd = bun.off + bun.size

    // 真 trailer = .bun 窗口内 magic 最后一次出现（排除 .rodata 引擎区的 HMR 常量副本）。trailer 恒在
    // .bun 尾，先只 pread 尾窗（2MB）搜；尾窗内没找到 → 回落全窗（罕见，结构上 trailer 必在尾）。
    const tailFrom = Math.max(bun.off, winEnd - TRAILER_WINDOW)
    const ranges = [[tailFrom, winEnd]]
    if (tailFrom > bun.off) ranges.push([bun.off, tailFrom + MAGIC.length - 1])
    const failures = []
    for (const [rangeStart, rangeEnd] of ranges) {
      let candidateEnd = rangeEnd
      while (candidateEnd > rangeStart) {
        const magicPos = reader.lastIndexOf(MAGIC, rangeStart, candidateEnd)
        if (magicPos < rangeStart) break
        const trailerOffset = magicPos - 1
        try {
          const trailerLiteral = reader.toString('latin1', trailerOffset, trailerOffset + MAGIC.length + 2)
          if (trailerLiteral !== '\n---- Bun! ----\n') throw new Error(`invalid trailer literal at ${trailerOffset}`)
          const { entryPointId, blobs } = decodeRecords(reader, trailerOffset, bun)
          return { trailerOffset, entryPointId, blobs }
        } catch (error) {
          failures.push(`@${magicPos}: ${error.message}`)
          candidateEnd = magicPos
        }
      }
    }
    throw new Error(`parseModuleGraph: no structurally valid Bun trailer in .bun window${failures.length ? ` (${failures.join('; ')})` : ''}`)
  } finally {
    if (ownReader) reader.close()
  }
}

// 按 FINDINGS-phase0.md 的实测记录布局逐条解码，返回 { entryPointId, blobs }。
// blob = { name, offset, length, loader, isEntry }：offset/length 是文件内绝对偏移与长度，
// reader.slice(offset, length) 即该 blob 原始字节。全程走 reader 的按需 pread。
function decodeRecords(reader, trailerOffset, bun) {
  const fileSize = reader.size

  // ── Offsets 头（trailer 前 32 字节，小端）：pread 一次 ─────────────────────────
  //   [-32] byte_count      u64  graph 序列化区总字节数（graph_base..offsets_start）
  //   [-24] modules_ptr.off u32  记录数组相对 graph_base 的偏移
  //   [-20] modules_ptr.len u32  记录数组字节数（= N × 52）
  //   [-16] entry_point_id  u32  入口模块下标（从此读取，勿硬编码 0）
  //   [-12..] 尾部 12 字节语义未确证 → 不读取（FINDINGS 降级项 #1）
  const os = trailerOffset - OFFSETS_SIZE
  if (os < bun.off) throw new Error(`decodeRecords: Offsets header @${os} precedes .bun window @${bun.off}`)
  const oh = reader.slice(os, OFFSETS_SIZE)
  const byteCount = Number(oh.readBigUInt64LE(0))
  const mpOff = oh.readUInt32LE(8)
  const mpLen = oh.readUInt32LE(12)
  const entryPointId = oh.readUInt32LE(16)

  // graph_base = 所有 StringPointer 的绝对基址（权威推导，别靠 ".bun+8" 巧合）。
  const graphBase = os - byteCount
  if (graphBase < bun.off || graphBase >= os) {
    throw new Error(`decodeRecords: graph_base ${graphBase} outside .bun window [${bun.off}, ${os})`)
  }

  // 记录数 N = mpLen / 52（随版本变：205=6, 201/195=5；必须从 mpLen 算，绝不写死）。
  if (mpLen <= 0 || mpLen % RECORD_SIZE !== 0) {
    throw new Error(`decodeRecords: modules_ptr.length ${mpLen} not a positive multiple of record size ${RECORD_SIZE}`)
  }
  const n = mpLen / RECORD_SIZE
  const recordsArrayStart = graphBase + mpOff // 记录数组绝对起点
  // mpOff 是 readUInt32LE（无符号恒 ≥0），故 recordsArrayStart ≥ graphBase 恒成立——不做
  // `recordsArrayStart < graphBase` 的死检查（learn-by-analogy：与 nameOff<0 同类死守卫）；
  // 真正有风险的是上界越界。
  const recordsArrayEnd = recordsArrayStart + mpLen
  if (!Number.isSafeInteger(recordsArrayEnd) || recordsArrayEnd > os) {
    throw new Error(`decodeRecords: records array [${recordsArrayStart}, ${recordsArrayEnd}) outside graph region [${graphBase}, ${os}) before Offsets header`)
  }

  // entry_point_id 边界前置：n 已知即可校验，fail-fast at source（越界值别先进记录循环再暴露）。
  if (entryPointId >= n) {
    throw new Error(`decodeRecords: entry_point_id ${entryPointId} out of range (N=${n})`)
  }

  // 记录数组：pread 一次（~N×52 字节），逐条从本地 buffer 读字段（省 syscall、语义不变）。
  const rec = reader.slice(recordsArrayStart, mpLen)
  const blobs = []
  for (let i = 0; i < n; i++) {
    const r = i * RECORD_SIZE
    // 记录字段（相对 graph_base）：[0]name.off [4]name.len [8]contents.off [12]contents.len
    const nameOff = rec.readUInt32LE(r)
    const nameLen = rec.readUInt32LE(r + 4)
    const cOff = rec.readUInt32LE(r + 8)
    const cLen = rec.readUInt32LE(r + 12)
    const loaderByte = rec[r + 49] // byte[49] = Loader enum

    const nameAbs = graphBase + nameOff
    const offset = graphBase + cOff // blob 字节的文件内绝对偏移
    const nameEnd = nameAbs + nameLen
    const contentEnd = offset + cLen
    if (!Number.isSafeInteger(nameEnd) || nameAbs < graphBase || nameEnd > recordsArrayStart) {
      throw new Error(`decodeRecords: record #${i} name [${nameAbs}, ${nameEnd}) outside graph region [${graphBase}, ${recordsArrayStart}) before records`)
    }
    if (!Number.isSafeInteger(contentEnd) || offset < graphBase || contentEnd > recordsArrayStart) {
      throw new Error(`decodeRecords: record #${i} contents [${offset}, ${contentEnd}) outside graph region [${graphBase}, ${recordsArrayStart}) before records`)
    }
    const name = reader.toString('latin1', nameAbs, nameAbs + nameLen) // 小 pread
    blobs.push({
      name,
      offset,
      length: cLen,
      loader: LOADER[loaderByte] ?? loaderByte,
      isEntry: i === entryPointId,
    })
  }

  // ── fail-loud 自证：结构常量若被未来 Bun 改动，坏切片会在此暴露、显式报错 ────────
  // (1) 每条：name 可打印且含 "$bunfs"；contents 头 64 字节按 loader 分类 sniff（js/入口→JS marker、
  //     napi→ELF、file 等任意-内容 loader→跳过 head sniff，靠下面的结构不变式兜）。逐 blob 小 pread。
  for (const b of blobs) {
    if (!/^[\x20-\x7e]+$/.test(b.name) || !b.name.includes('$bunfs')) {
      throw new Error(`decodeRecords self-check: blob name not a printable $bunfs path: ${JSON.stringify(b.name.slice(0, 80))}`)
    }
    if (JS_LOADERS.has(b.loader) || b.isEntry) {
      // 入口/JS bundle 确实该有这些头——这个检查有意义、保留（入口无论 loader 字节如何都强制）。
      const head = reader.toString('latin1', b.offset, b.offset + Math.min(b.length, 64))
      if (!JS_HEAD_MARKERS.some((m) => head.includes(m))) {
        throw new Error(`decodeRecords self-check: js/entry blob "${b.name}" head has no JS marker (${JSON.stringify(head.slice(0, 48))})`)
      }
    } else if (NAPI_LOADERS.has(b.loader)) {
      const head = reader.toString('latin1', b.offset, b.offset + Math.min(b.length, 64))
      if (!head.includes(NAPI_HEAD_MARKER)) {
        throw new Error(`decodeRecords self-check: napi blob "${b.name}" head is not ELF (${JSON.stringify(head.slice(0, 48))})`)
      }
    }
    // else：file/json/css/toml/wasm/未知 loader —— 内容任意，**不做** head sniff（见上方注释）。
    // 其正确性由下面的结构不变式（边界无重叠 + 末 blob 贴记录数组 + offset 越界守卫）照旧强制。
  }
  // (2) 边界不变式：按 offset 排序后相邻 blob 无重叠；全部 blob 位于记录数组之前
  //     （末 blob 结束贴到记录数组起点，205 实测差 1）。二者一起把 length 钉死。
  const sorted = [...blobs].sort((a, b) => a.offset - b.offset)
  for (let i = 1; i < sorted.length; i++) {
    const prevEnd = sorted[i - 1].offset + sorted[i - 1].length
    if (sorted[i].offset < prevEnd) {
      throw new Error(`decodeRecords self-check: blobs overlap — "${sorted[i - 1].name}" ends @${prevEnd} > next "${sorted[i].name}" @${sorted[i].offset}`)
    }
  }
  const lastEnd = sorted[sorted.length - 1].offset + sorted[sorted.length - 1].length
  if (lastEnd > recordsArrayStart) {
    throw new Error(`decodeRecords self-check: last blob ends @${lastEnd} past records array start @${recordsArrayStart}`)
  }

  return { entryPointId, blobs }
}
