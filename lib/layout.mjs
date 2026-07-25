// lib/layout.mjs — 二进制体积 / 布局分解：把 Bun --compile SFX（活 claude ~245MB）拆成可解释的份额。
//
// 边界全来自 **module-graph 精确 blob 偏移/长度 + ELF section 元数据**——engine=`.text+.rodata`，
// `.bun` 内的已知内容按 blob（app cli.js / 各 .node / 辅助 js / mermaid）逐块归类，`.bun` 剩余
// （blob 覆盖不到的）≈ JSC 字节码 + 图元数据。**绝不对启发式可打印 run 做 latin1 扫描**（Global
// Constraints / FINDINGS B1 教训：可打印 run 会把字节码里的 ASCII 误算进「源码」，边界不权威）——
// 与 exp/analyze-binary-layout.mjs 的启发式扫描相比，本模块用 module-graph 精确边界，量级复现但更准。
//
// 全程静态纯读，绝不执行目标 binary。下游 cli `layout` 子命令消费 computeLayout 打表 + 写 layout.json。
import { readBinary } from './bun-binary.mjs'
import { parseModuleGraph } from './module-graph.mjs'
import { versionFromBlobs } from './extract.mjs'

// blob 归类：入口 app cli.js → 'app'；.node napi 原生模块 → 'native'；其余（mermaid file-loader
// 资产、辅助 js）→ 'asset'。app 单独成 breakdown.bunAppJs，native+asset 汇成 breakdown.bunAssets。
function classifyBlob(b) {
  if (b.isEntry) return 'app'
  if (typeof b.loader === 'string' && b.loader.startsWith('napi')) return 'native'
  return 'asset'
}

// computeLayout(bin) → { fileSize, engine, sections, blobs, breakdown }
//   engine   : .text.size + .rodata.size（引擎代码，字节）
//   sections : readBinary 的全 section 元数据（richest-context：完整传下去，不预裁剪）
//   blobs    : module-graph 的 blob 数组，每个附 category（app/native/asset）
//   breakdown: 五分类 { engine, bunAppJs, bunAssets, bunBytecodeAndMeta, otherSections }
//              各项 { bytes, pct }（pct = bytes/fileSize×100，两位小数）。五项之和 === fileSize（精确，
//              otherSections 与 bunBytecodeAndMeta 都是余项、把账做平；exp 的启发式版只能 ≈）。
export function computeLayout(bin) {
  const reader = readBinary(bin) // 开 fd + pread 建 sections；下方复用给 parseModuleGraph，用完 close
  try {
    const { sections } = reader
    const fileSize = reader.size

    const textSize = sections['.text']?.size ?? 0
    const rodataSize = sections['.rodata']?.size ?? 0
    const engine = textSize + rodataSize

    const bunSection = sections['.bun']
    if (!bunSection) throw new Error('computeLayout: no .bun section (not a Bun --compile SFX?)')

    const { blobs: rawBlobs, entryPointId } = parseModuleGraph(bin, reader) // 复用 reader，不重开 fd（E1）
    const blobs = rawBlobs.map((b) => ({ ...b, category: classifyBlob(b) }))
    // version：从入口 blob 解出（复用同一 reader，只 pread 入口 blob）。供 cli `layout` 命令用 outdirName
    // 统一命名 `claude-code-<version>`（E3 = A4），并顺带写进 layout.json（richest-context）。无锚 → null。
    const version = versionFromBlobs(reader, rawBlobs)

    // 精确边界分账：app = 入口 blob；assets = 非入口 blob 之和；bytecodeAndMeta = .bun 内 blob 覆盖不到
    // 的余量（≈ JSC 预编译字节码 + StandaloneModuleGraph 序列化元数据）。
    const blobSum = blobs.reduce((a, b) => a + b.length, 0)
    const appBlob = blobs.find((b) => b.isEntry)
    const bunAppJs = appBlob ? appBlob.length : 0
    const bunAssets = blobSum - bunAppJs
    const bunBytecodeAndMeta = bunSection.size - blobSum
    // otherSections = 文件里既非 engine（.text/.rodata）也非 .bun 的字节（ELF 头 / 符号表 / .data 等余量）。
    const otherSections = fileSize - engine - bunSection.size

    const pct = (n) => +((n / fileSize) * 100).toFixed(2)
    const item = (bytes) => ({ bytes, pct: pct(bytes) })
    const breakdown = {
      engine: item(engine),
      bunAppJs: item(bunAppJs),
      bunAssets: item(bunAssets),
      bunBytecodeAndMeta: item(bunBytecodeAndMeta),
      otherSections: item(otherSections),
    }

    return { fileSize, engine, version, entryPointId, sections, blobs, breakdown }
  } finally {
    reader.close() // 成败都关 fd（try/finally）
  }
}

// 人类可读一行：右对齐字节（MB）+ 占比。
const MB = 1024 * 1024
function fmtMB(n) {
  return (n / MB).toFixed(2).padStart(9) + ' MB'
}

// formatLayout(layout) → 多行字符串（供 cli 打 stderr）。不含颜色 / 制表符对齐依赖，纯空格右对齐。
export function formatLayout(layout) {
  const { fileSize, breakdown } = layout
  const rows = [
    ['engine (.text+.rodata)', breakdown.engine],
    ['bun app js (cli.js)', breakdown.bunAppJs],
    ['bun assets (.node/mermaid/js)', breakdown.bunAssets],
    ['bun bytecode + meta', breakdown.bunBytecodeAndMeta],
    ['other sections (ELF/symtab)', breakdown.otherSections],
  ]
  const lines = [`file size            : ${fmtMB(fileSize)}`]
  for (const [label, it] of rows) {
    lines.push(`${label.padEnd(30)}: ${fmtMB(it.bytes)}  ${it.pct.toFixed(2).padStart(6)}%`)
  }
  // named blob 明细（module-graph 精确边界）
  lines.push('')
  lines.push('.bun named blobs (module-graph exact boundaries):')
  for (const b of layout.blobs) {
    lines.push(`  ${(b.category + '').padEnd(7)} ${(b.loader + '').padEnd(10)} ${fmtMB(b.length)}  ${b.name}`)
  }
  return lines.join('\n')
}
