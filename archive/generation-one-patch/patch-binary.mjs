// lib/patch-binary.mjs — `cc patch <feature>` 的文件级编排：备份 / 原子写 / macOS 重签名 / 就地补丁 / revert。
//
// 吸收自 ~/.claude/scripts/channels-patch/patch.py + ~/.claude/scripts/agent-patch/patch.py（JS 重写；
// 原 channels-patch 曾在 tools/channels-patch/，已移出仓库）。两个纯字节
// 变换模块（patch-channels / patch-agent-model）只收 buf 出 buf；本模块负责真正读写 live 二进制、备份、
// 原子替换、macOS ad-hoc 重签名。**就地改写 live claude**（配 .bak 备份 + revert），这是补丁的核心价值。
//
// 备份与 revert 语义（两特性差异，忠实保留原工具能力）：
//   - channels：决策函数塌缩是**破坏性**改写（塌掉的分支字节丢失），无法逐字节还原 → revert 走「从
//     .bak 干净副本整文件恢复」。故首次打补丁前必须建立 .bak。
//   - agent-model：枚举↔字符串是**等长可逆**替换 → revert 走就地字节还原（revertAgentModel），无需 .bak。
//   同一二进制两特性可叠加：channels revert（整文件恢复 .bak）会连带抹掉 agent-model；agent-model revert
//   只动自己的位点，不影响 channels。CLI 层在 revert channels 时会提示这一点。

import { readFileSync, writeFileSync, statSync, chmodSync, existsSync, copyFileSync, renameSync, realpathSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { platform } from 'node:os'
import { join, basename } from 'node:path'
import { applyChannels, classifyChannels, quickStatusChannelsReader } from './patch-channels.mjs'
import { applyAgentModel, revertAgentModel, classifyAgentModel, quickStatusAgentModelReader } from './patch-agent-model.mjs'
import { parseVersion } from '../../lib/extract.mjs'
import { readBinary } from '../../lib/bun-binary.mjs'

// 特性注册表：单一真相源。apply/classify 复用纯字节模块；revert 语义分「backup」（整文件恢复）与
// 「inplace」（就地字节还原）。requiresBackup=true 的特性首次打补丁前建立 .bak。
export const FEATURES = {
  channels: {
    label: 'channels（启用 --channels）',
    apply: applyChannels,
    classify: classifyChannels,
    revert: 'backup',
    requiresBackup: true,
    quickReader: quickStatusChannelsReader,
    runHint: 'claude --channels plugin:telegram@claude-plugins-official',
  },
  'agent-model': {
    label: 'agent-model（放开 Agent 工具 model 枚举）',
    apply: (buf, log) => applyAgentModel(buf), // agent-model 无 log 参数，签名对齐
    classify: (buf) => {
      const { status, detail } = classifyAgentModel(buf)
      return { status, details: [detail] }
    },
    revert: 'inplace',
    revertFn: revertAgentModel,
    requiresBackup: false,
    quickReader: quickStatusAgentModelReader,
    runHint: 'Agent(model="gpt-5.5", subagent_type="general-purpose", ...)',
  },
}

export function featureNames() { return Object.keys(FEATURES) }

const MIN_BINARY_SIZE = 10_000_000

// ── 版本抽取：优先 Python 同款 `overview",VERSION:"` 前缀锚（与原工具一致、边角串稳），
// 回落 extract 的 parseVersion（PACKAGE_URL 全锚）。容错 latin1 全量扫，取不到 → null。
const VERSION_ANCHOR = Buffer.from('overview",VERSION:"', 'latin1')
export function binaryVersion(buf) {
  const idx = buf.lastIndexOf(VERSION_ANCHOR)
  if (idx !== -1) {
    const start = idx + VERSION_ANCHOR.length
    const end = buf.indexOf(0x22 /* '"' */, start)
    if (end !== -1 && end - start <= 24) {
      const ver = buf.toString('latin1', start, end)
      if (ver && /^[0-9]/.test(ver) && /[0-9]$/.test(ver) && /^[0-9.]+$/.test(ver)) return ver
    }
  }
  try {
    return parseVersion(buf.toString('latin1'))
  } catch {
    return null
  }
}

// versionFromReader(reader) → 在 reader 上开尾窗只读抽版本（mmap/pread，不全量读入）。SEA 版本锚在尾部：
// 从 reader.size 往前 lastIndexOf VERSION_ANCHOR，命中处只 toString 到下一个引号。取不到 → null。
const VER_SCAN_TAIL = 64 * 1024 * 1024
export function versionFromReader(reader) {
  const size = reader.size
  const from = Math.max(0, size - VER_SCAN_TAIL)
  const idx = reader.lastIndexOf(VERSION_ANCHOR, from, size)
  if (idx === -1) return null
  const start = idx + VERSION_ANCHOR.length
  const win = reader.toString('latin1', start, Math.min(size, start + 24))
  const q = win.indexOf('"')
  if (q === -1) return null
  const ver = win.slice(0, q)
  if (ver && /^[0-9]/.test(ver) && /[0-9]$/.test(ver) && /^[0-9.]+$/.test(ver)) return ver
  return null
}

// quickProbe(binary, feature) → { status, version }。**快速只读探测**（mmap 主 + pread 回落，尾部开窗）：
// 只触碰 bundle 尾部几个百分点、不全量读入/解码整块 240MB。这是 --check 的两条只读路径之一（快速 vs 全面）：
// 快速路径只出 status/version（内存几十 MB、批量 7 个 ~0.2s）；全面路径（runPatchCheck full=true，完整
// classify）额外给逐项字节明细（每个子锚点 clean/patched 计数），代价是全读全解码。二者判级结果一致，
// 差别在信息量而非仅速度。要逐项明细走全面路径。
export function quickProbe(binary, feature) {
  const f = FEATURES[feature]
  if (!f) throw new Error(`unknown feature '${feature}' (use: ${featureNames().join('|')})`)
  const reader = readBinary(binary)
  try {
    return { status: f.quickReader(reader), version: versionFromReader(reader) }
  } finally {
    reader.close()
  }
}

// ── 备份路径：`foo`/`foo.exe`/`2.1.175` → 追加 .bak（点号版本名不误当扩展名） ──
export function backupPath(binary) {
  const s = binary.toLowerCase()
  if (s.endsWith('.exe')) return binary.slice(0, -4) + '.bak'
  return binary + '.bak'
}

// ── 原子写 + 保执行位 ──
function atomicWrite(binary, data) {
  const tmp = binary + '.patched'
  writeFileSync(tmp, data)
  try {
    const mode = statSync(binary).mode
    chmodSync(tmp, mode | 0o111)
  } catch { /* best-effort 保执行位 */ }
  try {
    renameSync(tmp, binary)
  } catch (err) {
    if (err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'EBUSY') {
      throw new Error(`无法替换 ${binary}（可能正在运行）。请关闭 Claude Code 后重试。补丁已就绪：${tmp}`)
    }
    throw err
  }
}

// ── macOS ad-hoc 重签名（改写后必须，否则拒绝执行） ──
function maybeResignMacos(binary, log) {
  if (platform() !== 'darwin') return
  const manual = `  codesign --remove-signature ${binary}\n  codesign -s - ${binary}`
  try {
    execFileSync('codesign', ['--remove-signature', binary], { stdio: 'pipe' })
    execFileSync('codesign', ['-s', '-', binary], { stdio: 'pipe' })
    log('  OK macOS ad-hoc codesign')
  } catch (err) {
    throw new Error(`补丁已写入，但重签名失败：${err.message}\n手动执行：\n${manual}`)
  }
}

// ── 命令：check ──
// --check 有两条只读路径：**快速**（默认，quickProbe：mmap 尾部开窗，只出 status/version，内存几十 MB）
// 与**全面**（full=true，完整 classify：全读+全量解码，额外给每个子锚点的逐项字节明细）。两者判级一致，
// 差别在信息量。快速路径避免早期「全读全解码 7×240MB → ~6s / GB 级内存」的批量探测退化。
export function runPatchCheck({ binary, feature, log = console.error, full = false } = {}) {
  const f = FEATURES[feature]
  if (!f) throw new Error(`unknown feature '${feature}' (use: ${featureNames().join('|')})`)
  if (!existsSync(binary)) { log(`Binary not found: ${binary}`); return { status: 'error' } }
  const bak = backupPath(binary)
  if (!full) {
    const { status, version } = quickProbe(binary, feature)
    log(`Feature  : ${feature}`)
    log(`Status   : ${status}`)
    log(`Version  : ${version || '?'}`)
    if (existsSync(bak)) log(`Backup   : ${bak}`)
    return { status }
  }
  const buf = readFileSync(binary)
  const { status, details } = f.classify(buf)
  log(`Feature  : ${feature}`)
  log(`Status   : ${status}`)
  log(`Version  : ${binaryVersion(buf) || '?'}`)
  if (existsSync(bak)) log(`Backup   : ${bak}`)
  for (const d of details) log(`  - ${d}`)
  return { status, details }
}

// ── 命令：patch（就地改写 live） ──
export function runPatch({ binary, feature, log = console.error } = {}) {
  const f = FEATURES[feature]
  if (!f) throw new Error(`unknown feature '${feature}' (use: ${featureNames().join('|')})`)
  if (!existsSync(binary)) { log(`Binary not found: ${binary}`); return { patched: false } }

  const current = readFileSync(binary)
  const { status } = f.classify(current)
  if (status === 'unsupported') { log(`不支持的结构（未找到锚点）-> ${binary}`); return { patched: false, status } }

  const bak = backupPath(binary)
  // source = 打补丁的**基线字节**。requiresBackup 的破坏性特性（channels）不变量：`.bak` 永远是干净基线，
  // 每次都从 bak 重新派生，且当 current 干净且与 bak 不同（原地覆盖装了新版）时刷新 bak——忠实移植 Python
  // run_patch 的语义，避免 stale-bak 令 revert 把新版降级、以及 mixed/部分损坏态无法自愈。
  let source = current
  if (f.requiresBackup) {
    if (!existsSync(bak)) {
      // 已 patched 但没干净 .bak：拒绝，避免把已补过的二进制毒化成备份源。
      if (status === 'patched') {
        log(`Already patched -> ${binary}\n没有干净的 .bak，未做任何改动（避免把已补过的二进制当备份源）。`)
        return { patched: false, status }
      }
      copyFileSync(binary, bak) // current 干净 → 建立干净基线
      source = readFileSync(bak)
      log(`Backup  -> ${bak}`)
    } else {
      source = readFileSync(bak)
      if (!current.equals(source) && status === 'clean') {
        // .bak 存在但与 current 不同，且 current 干净 → 新版本覆盖安装，刷新备份为新的干净基线。
        copyFileSync(binary, bak)
        source = readFileSync(bak)
        log(`Backup refreshed (binary updated) -> ${bak}`)
      } else {
        log(`Backup exists, re-patching from clean .bak`)
      }
    }
  }

  const { patched, edits } = f.apply(source, log)
  if (patched.equals(current)) { log(`Already patched -> ${binary}`); return { patched: false, status: 'patched' } }
  atomicWrite(binary, patched)
  maybeResignMacos(binary, log)
  log(`\nPatched -> ${binary} (${edits} edit block(s))`)
  log(`Run:  ${f.runHint}`)
  return { patched: true, edits }
}

// ── 命令：revert ──
export function runRevert({ binary, feature, log = console.error } = {}) {
  const f = FEATURES[feature]
  if (!f) throw new Error(`unknown feature '${feature}' (use: ${featureNames().join('|')})`)
  if (!existsSync(binary)) { log(`Binary not found: ${binary}`); return { reverted: false } }

  if (f.revert === 'backup') {
    const bak = backupPath(binary)
    if (!existsSync(bak)) { log(`No backup found for ${binary} — nothing to revert.`); return { reverted: false } }
    copyFileSync(bak, binary)
    // 不重签名：.bak 是原始字节（含原始签名），整文件恢复即回到出厂态，无需 ad-hoc 重签（对齐 Python）。
    log(`Reverted from backup -> ${binary}（注：整文件恢复，会连带抹掉同一二进制上的其它就地补丁）`)
    return { reverted: true }
  }
  // inplace：就地字节还原（等长可逆特性，如 agent-model）。
  const current = readFileSync(binary)
  const { patched, reverted } = f.revertFn(current)
  if (reverted === 0) { log(`Nothing to revert for ${binary}`); return { reverted: false } }
  atomicWrite(binary, patched)
  maybeResignMacos(binary, log)
  log(`Reverted -> ${binary} (${reverted} site)`)
  return { reverted: true, sites: reverted }
}

// ── 二进制自动检测（官方安装位 + 编辑器扩展内置 native-binary） ──
function isClaudeBinary(p) {
  try {
    const st = statSync(p)
    if (!st.isFile() || st.size < MIN_BINARY_SIZE) return false
    const base = basename(p)
    const dot = base.lastIndexOf('.')
    if (dot === -1) return true
    const ext = base.slice(dot + 1).toLowerCase()
    return ext === 'exe' || /^\d+$/.test(ext) // 无扩展名 / .exe / 点号版本名（2.1.175）
  } catch { return false }
}

export function detectBinaries(home = process.env.HOME || '') {
  const found = []
  const seen = new Set()
  const add = (p) => {
    try {
      const rp = realpathSync(p)
      if (isClaudeBinary(rp) && !seen.has(rp)) { seen.add(rp); found.push(rp) }
    } catch { /* 不存在 */ }
  }
  if (!home) return found
  const isWin = process.platform === 'win32'
  const binNames = isWin ? ['claude.exe', 'claude'] : ['claude']
  add(join(home, '.local/bin/claude'))
  add(join(home, '.local/bin/claude.exe'))
  const vd = join(home, '.local/share/claude/versions')
  try {
    for (const e of readdirSync(vd)) {
      if (/\.(bak|patched|agentbak)$/.test(e)) continue
      const full = join(vd, e)
      try {
        if (statSync(full).isFile()) add(full)
        else for (const n of binNames) add(join(full, n))
      } catch { /* skip */ }
    }
  } catch { /* 无 versions 目录 */ }
  // 编辑器扩展内置 native-binary（含 insiders / vscodium 变体）
  const extRoots = [
    '.vscode/extensions', '.vscode-server/extensions',
    '.vscode-insiders/extensions', '.vscode-server-insiders/extensions',
    '.vscodium/extensions', '.vscodium-server/extensions',
    '.cursor/extensions', '.cursor-server/extensions',
    '.windsurf/extensions', '.windsurf-server/extensions',
  ]
  for (const rel of extRoots) {
    const root = join(home, rel)
    try {
      for (const e of readdirSync(root)) {
        if (!e.startsWith('anthropic.claude-code-')) continue
        for (const n of binNames) add(join(root, e, 'resources', 'native-binary', n))
      }
    } catch { /* skip */ }
  }
  // PATH 上的 claude（brew / 手动安装的入口，realpathSync 解到真二进制、seen 去重）
  for (const entry of (process.env.PATH || '').split(isWin ? ';' : ':')) {
    if (!entry) continue
    for (const n of binNames) add(join(entry.replace(/^"|"$/g, ''), n))
  }
  // Homebrew 前缀（macOS/Linux brew）
  if (!isWin) {
    for (const prefix of ['/opt/homebrew', '/usr/local', '/home/linuxbrew/.linuxbrew']) {
      add(join(prefix, 'bin/claude'))
      const caskroom = join(prefix, 'Caskroom/claude-code')
      try {
        for (const v of readdirSync(caskroom)) add(join(caskroom, v, 'claude'))
      } catch { /* skip */ }
    }
  }
  return found
}
