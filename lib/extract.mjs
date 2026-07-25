// lib/extract.mjs — 从 Bun --compile SFX 里权威切出 app 入口 bundle（cli.js）+ best-effort version。
//
// 只消费 module-graph 的具名 blob（精确 offset/length），**绝不启发式扫描**：入口由
// Offsets.entry_point_id 权威指认（FINDINGS-phase0.md P0-b），blob.isEntry 已透出；
// contents 按记录的权威 length 界定，`buf.toString('utf8', off, off+len)` 无损切出，
// 不对启发式 run 做 latin1 猜边界（B1 教训）。
//
// version 靠 Claude 专属唯一锚（P0-d）：内联元数据对象
// `PACKAGE_URL:"@anthropic-ai/claude-code",README_URL:"…",VERSION:"x.y.z"`。裸 `VERSION:`
// 有噪声（依赖版本号），必须用完整 PACKAGE_URL 前缀锚定。无锚 → null（best-effort，不阻塞）。
import { readBinary } from './bun-binary.mjs'
import { parseModuleGraph } from './module-graph.mjs'

export function extractApp(bin) {
  const reader = readBinary(bin) // 开一个 fd，pread 建 sections；下方按需切字节，用完 close（fd 不泄漏）
  try {
    const { blobs } = parseModuleGraph(bin, reader) // 复用 reader，不重开 fd（E1 read-once）
    const b = selectEntryBlob(reader, blobs)
    const app = reader.slice(b.offset, b.length).toString('utf8') // 只 pread 入口 blob（~18MB），非整块 257MB
    return { app, version: parseVersion(app), blob: { offset: b.offset, length: b.length } }
  } finally {
    reader.close() // 成败都关 fd（try/finally）
  }
}

// 入口 blob 选择：优先 module-graph 的权威 isEntry 指认（entry_point_id 索引）；
// 回落（非 claude 布局 / 无 entry_point_id）到「含 @bun-cjs 头且最大的 blob」（P0-b 三级判据）。
function selectEntryBlob(reader, blobs) {
  const entry = blobs.find((b) => b.isEntry)
  if (entry) return entry
  const cand = blobs
    .map((b) => ({ b, head: reader.toString('utf8', b.offset, b.offset + Math.min(b.length, 64)) })) // 小 pread 头
    .filter((x) => x.head.includes('@bun-cjs'))
  if (!cand.length) throw new Error('extractApp: no @bun-cjs app blob in module graph')
  return cand.sort((x, y) => y.b.length - x.b.length)[0].b
}

// versionFromBlobs(reader, blobs) — 从**已解析的 module-graph blobs** 里拿 claude version，供 assets /
// layout 复用：它们跑到此处时已 readBinary + parseModuleGraph，复用同一 reader、不重开 fd。
// 选入口 blob（selectEntryBlob，与 extract 同一判据）→ pread 其 app 源（~18MB）→ parseVersion。
// 无锚（通用 SFX）→ null（下游 outdirName 回落 basename）。这样 assets/layout 与 extract 对同一二进制
// 解出**同一个** version、命出**同一个** `claude-code-<version>` 目录（E3 = A4）。
export function versionFromBlobs(reader, blobs) {
  const b = selectEntryBlob(reader, blobs)
  const app = reader.slice(b.offset, b.length).toString('utf8') // 只 pread 入口 blob，非整块
  return parseVersion(app)
}

// FINDINGS-phase0.md P0-d 真锚：完整 PACKAGE_URL 元数据对象里的 VERSION。minifier 内联多份、
// 值一致，取首个即可。命中即取，否则 null（通用 SFX / 未来布局变动 → best-effort，不阻塞）。
// export：assets/layout（经 versionFromBlobs）与测试复用同一正则，绝不重复实现 P0-d 锚（单一真相源）。
export function parseVersion(app) {
  const m = app.match(/PACKAGE_URL:"@anthropic-ai\/claude-code",README_URL:"[^"]*",VERSION:"([^"]+)"/)
  if (!m) return null
  const version = m[1]
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) || version.includes('..')) {
    throw new Error(`parseVersion: invalid Claude semver ${JSON.stringify(version)}`)
  }
  return version
}
