// lib/naming.mjs — 4 个 CLI 命令（extract / split / assets / layout）共享的默认 outdir 目录名。
//
// 统一规则：`claude-code-<version || basename(bin)>` —— 优先按解析出的 claude version 命名，无
// version 锚（通用 SFX / 直接读已提取的 app.js）时回落到二进制路径的 basename。历史上 4 命令各行其是
// （extract 用 version||basename、split 回落字面 'app'、assets/layout 只用 basename、从不解析 version），
// 活二进制恰好落在 `versions/<x.y.z>/` 下、basename 等于 version 而**巧合一致**；但任意 SFX / 换名副本下
// basename≠version 时会分裂成两个目录名（同一二进制 extract 产物落 `claude-code-<version>/`、assets 落
// `claude-code-<basename>/`）——下游 rebuild / diff 找不到配套目录。抽此单一真相源消除分歧（E3 = A4）。
import { basename, extname } from 'node:path'

// outdirName(bin, version) → `claude-code-<version || basename(bin)>`（仅目录名段，不含 refs/ 前缀）。
// version 为空串 / null / undefined 时回落 basename(bin)。调用方 join(repoRoot(), 'refs', outdirName(...))。
export function outdirName(bin, version) {
  return `claude-code-${version || basename(bin)}`
}

// uniqueAssetName(name, offset, used) → assets 落盘的**唯一**文件名（E4 = A5）。
//
// 基名 = `basename(name)`；name 为 null/空 → 回落 `blob-<offset>.bin`。若基名已被 `used` 占用（两个非
// 入口 blob 不同 $bunfs 路径但同尾名 —— 旧实现会静默覆盖、丢资产），用**全局唯一**的 offset 消歧为
// `<stem>-<offset><ext>`（无扩展名则 `<stem>-<offset>`）。极端防御：若消歧名仍撞（有 blob 的真名恰好长
// 这样），回落 `blob-<offset>.bin`（offset 唯一 ⇒ 恒不覆盖）。副作用：把最终选定名加入 `used`，调用方
// 循环里逐个调用即保证「每个 blob 都写出、不覆盖」。返回最终写出名，调用方如实记进 assets[].file。
export function uniqueAssetName(name, offset, used) {
  const base = name ? basename(name) : `blob-${offset}.bin`
  let file = base
  if (used.has(file)) {
    const ext = extname(base)
    const stem = base.slice(0, base.length - ext.length)
    file = `${stem}-${offset}${ext}`
    if (used.has(file)) file = `blob-${offset}.bin` // offset 全局唯一 → 最终兜底恒不撞
  }
  used.add(file)
  return file
}
