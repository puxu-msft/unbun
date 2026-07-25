// lib/patch-channels.mjs — 让新版 Claude Code 的 `--channels` 在无需 claude.ai OAuth、不受
// provider/allowlist 限制下也能启用（plugin: 与 server: 两种通道都生效）。
//
// 吸收自 ~/.claude/scripts/channels-patch/patch.py（JS 重写、纳入 bun test；原在 tools/channels-patch/，已移出仓库）。补丁集（全部原地等长替换、TOC-safe）：
//   1) 决策函数塌缩：保留最前的 capability 检查，把函数体后半段塌成 `return{action:"register"}`，
//      空格填充回原长 → 一次绕过 provider/disabled/policy/session/marketplace/allowlist。
//   2) feature flag  `tengu_harbor",!1` → `!0`               （必须：防能力被提前剥离）
//   3) permissions   `tengu_harbor_permissions",!1` → `!0`   （尽力）
//   4) bun fallback  `// @bun @bytecode` → `// @bun @source__`（必须：强制运行时执行改过的 JS 源码）
//   5) cap-strip     能力剥离条件 `(!oYH()||!b$q(...))` 的 `||` → `&&`（尽力，server: 通道关键）
//
// 本模块只做**纯字节/纯文本**变换（收 buf 出 buf + 分类），不碰文件系统 / 备份 / 检测——编排在
// lib/patch-binary.mjs。锚点一律用稳定字符串，绝不依赖混淆变量名。

const DECISION_WINDOW = 8000 // feature-message 附近找决策函数体的范围
const MAX_BLOCK_LOOKBACK = 2500 // 从 capability 标记往前找包围块的最大回溯

const CAPABILITY_MARKER = 'claude/channel'
const FEATURE_MESSAGE = 'channels feature is not currently available'
const REGISTER_RETURN = 'return{action:"register"}'
const SKIP_RETURN = 'return{action:"skip"'
const DOWNSTREAM_GATES = ['kind:"auth"', 'kind:"allowlist"', 'kind:"provider"']

const FEATURE_FLAG_PREFIX = Buffer.from('tengu_harbor",!', 'latin1')
const PERMISSIONS_FLAG_PREFIX = Buffer.from('tengu_harbor_permissions",!', 'latin1')
const BYTE_TRUE = 0x31 // '1' → 旧写法 !1（开关默认关）
const BYTE_FALSE = 0x30 // '0' → 改为 !0（开关默认开）

const BUN_TAG_PREFIX = Buffer.from('// @bun ', 'latin1')
const BUN_BYTECODE = Buffer.from('@bytecode', 'latin1')
const BUN_SOURCE = Buffer.from('@source__', 'latin1')

const CAP_STRIP_ANCHOR = Buffer.from('["claude/channel"]&&(', 'latin1')
const CAP_STRIP_TAIL = Buffer.from(')))delete', 'latin1')
const CAP_STRIP_WINDOW = 80
const PIPE_PAIR = Buffer.from('||', 'latin1')
const AMP_PAIR = Buffer.from('&&', 'latin1')

function findAll(buf, pattern) {
  const out = []
  for (let i = 0; (i = buf.indexOf(pattern, i)) !== -1; i++) out.push(i)
  return out
}

const REGISTER_RETURN_BYTES = Buffer.from(REGISTER_RETURN, 'latin1')

// quickStatusChannels(buf) → 'clean'|'patched'|'unsupported'。**只读快速判级**：镜像 Python quick_status。
// 决策函数在 SEA 二进制尾部（bundle），从尾 lastIndexOf 找 register，仅在其 ±DECISION_WINDOW 开一个小
// 窗解码后跑既有文本判定器 → **不全量 toString 240MB**（全量解码正是 --check 全面路径吃 GB 级内存的根因）。
// 逐处回退：找到的若是无关 register（窗内无决策体），继续往更靠前找，与 classifyChannels 同等鲁棒。
// 不细分 mixed（部分字节补丁的边角）：以决策体状态为准，要逐项字节明细走全面路径 classifyChannels。
export function quickStatusChannels(buf) {
  let end = buf.length
  while (true) {
    const reg = buf.lastIndexOf(REGISTER_RETURN_BYTES, end - 1)
    if (reg === -1) return 'unsupported'
    const lo = Math.max(0, reg - DECISION_WINDOW)
    const hi = Math.min(buf.length, reg + DECISION_WINDOW)
    const window = buf.toString('latin1', lo, hi)
    if (locatePatchedDecisionBodies(window).length) return 'patched'
    if (locateDecisionBodies(window).length) return 'clean'
    end = reg // 无关 register，继续往更靠前找
  }
}

// quickStatusChannelsReader(reader) → 同上，但**在 reader 上开尾窗**（mmap/pread），只 toString 尾部小窗、
// 不把整块 240MB 读进内存或全量解码。SEA 决策函数在 bundle 尾部：从 reader.size 往前用 lastIndexOf 找
// register，命中处 ±DECISION_WINDOW 用 reader.toString 只解码该窗。这是 --check/探测批量场景省内存的关键。
// SCAN_TAIL：只在文件尾部这么多字节里扫 register（bundle 恒在尾部；给足冗余）。
const SCAN_TAIL = 64 * 1024 * 1024
export function quickStatusChannelsReader(reader) {
  const size = reader.size
  const scanFrom = Math.max(0, size - SCAN_TAIL)
  let end = size
  while (end > scanFrom) {
    const reg = reader.lastIndexOf(REGISTER_RETURN_BYTES, scanFrom, end)
    if (reg === -1) return 'unsupported'
    const lo = Math.max(0, reg - DECISION_WINDOW)
    const hi = Math.min(size, reg + DECISION_WINDOW)
    const window = reader.toString('latin1', lo, hi)
    if (locatePatchedDecisionBodies(window).length) return 'patched'
    if (locateDecisionBodies(window).length) return 'clean'
    end = reg
  }
  return 'unsupported'
}

// ── 花括号配对（跳过字符串 / 模板串 / 注释） ────────────────────────────────
// 从 openIdx 处的 `{` 出发做配对，返回匹配 `}` 的索引；找不到返回 -1。
export function findMatchingBrace(text, openIdx) {
  if (openIdx < 0 || openIdx >= text.length || text[openIdx] !== '{') return -1
  let depth = 0
  let mode = 'normal'
  let i = openIdx
  while (i < text.length) {
    const ch = text[i]
    const nxt = i + 1 < text.length ? text[i + 1] : ''
    if (mode === 'normal') {
      if (ch === '/' && nxt === '/') { mode = 'line'; i += 2; continue }
      if (ch === '/' && nxt === '*') { mode = 'block'; i += 2; continue }
      if (ch === "'") mode = 'single'
      else if (ch === '"') mode = 'double'
      else if (ch === '`') mode = 'template'
      else if (ch === '{') depth++
      else if (ch === '}') { depth--; if (depth === 0) return i }
    } else if (mode === 'single') {
      if (ch === '\\') { i += 2; continue }
      if (ch === "'") mode = 'normal'
    } else if (mode === 'double') {
      if (ch === '\\') { i += 2; continue }
      if (ch === '"') mode = 'normal'
    } else if (mode === 'template') {
      if (ch === '\\') { i += 2; continue }
      if (ch === '`') mode = 'normal'
    } else if (mode === 'line') {
      if (ch === '\n') mode = 'normal'
    } else if (mode === 'block') {
      if (ch === '*' && nxt === '/') { mode = 'normal'; i += 2; continue }
    }
    i++
  }
  return -1
}

// 找到同时包住 marker/capability/register 的**最小** {...} 块，返回 [open, close] 或 null。
function findSmallestEnclosingBlock(text, markerPos, capabilityPos, registerPos) {
  const start = Math.max(0, capabilityPos - MAX_BLOCK_LOOKBACK)
  let best = null
  for (let openIdx = capabilityPos; openIdx >= start; openIdx--) {
    if (text[openIdx] !== '{') continue
    const closeIdx = findMatchingBrace(text, openIdx)
    if (closeIdx === -1) continue
    if (openIdx < capabilityPos && capabilityPos < closeIdx &&
        openIdx < markerPos && markerPos < closeIdx &&
        openIdx < registerPos && registerPos < closeIdx) {
      if (best === null || (closeIdx - openIdx) < (best[1] - best[0])) best = [openIdx, closeIdx]
    }
  }
  return best
}

// 返回 capability 检查块（含 skip-return 与尾随分号/空白）的结束位置（改写时需**保留**的前缀边界），或 -1。
function findCapabilityCheckEnd(text, bodyStart, bodyEnd, capabilityPos) {
  const ifPos = text.lastIndexOf('if(', capabilityPos)
  if (ifPos === -1 || ifPos < bodyStart) return -1
  const skipPos = text.indexOf(SKIP_RETURN, ifPos)
  if (skipPos === -1 || skipPos >= bodyEnd) return -1
  if (!text.slice(ifPos, skipPos).includes(CAPABILITY_MARKER)) return -1
  const objectOpen = text.indexOf('{', skipPos)
  if (objectOpen === -1 || objectOpen >= bodyEnd) return -1
  const objectClose = findMatchingBrace(text, objectOpen)
  if (objectClose === -1 || objectClose >= bodyEnd) return -1
  let end = objectClose + 1
  while (end < bodyEnd && ' ;\r\n\t'.includes(text[end])) end++
  return end
}

// 定位所有可塌缩的决策函数体，返回 [{bodyStart, bodyEnd, capabilityEnd}]（按出现顺序、去重）。
export function locateDecisionBodies(text) {
  const out = []
  const seen = new Set()
  let start = 0
  while (true) {
    const markerPos = text.indexOf(FEATURE_MESSAGE, start)
    if (markerPos === -1) break
    start = markerPos + 1
    const windowStart = Math.max(0, markerPos - DECISION_WINDOW)
    const windowEnd = Math.min(text.length, markerPos + DECISION_WINDOW)
    const capabilityPos = text.lastIndexOf(CAPABILITY_MARKER, markerPos)
    if (capabilityPos === -1 || capabilityPos < windowStart) continue
    const registerPos = text.indexOf(REGISTER_RETURN, markerPos)
    if (registerPos === -1 || registerPos >= windowEnd) continue
    const bounds = findSmallestEnclosingBlock(text, markerPos, capabilityPos, registerPos)
    if (bounds === null) continue
    const key = bounds[0] + ':' + bounds[1]
    if (seen.has(key)) continue
    const [bodyStart, bodyEnd] = bounds
    const capabilityEnd = findCapabilityCheckEnd(text, bodyStart, bodyEnd, capabilityPos)
    if (capabilityEnd === -1 || capabilityEnd >= registerPos) continue
    const body = text.slice(bodyStart + 1, bodyEnd)
    if (!body.includes(CAPABILITY_MARKER) || !body.includes(FEATURE_MESSAGE) || !body.includes(REGISTER_RETURN)) continue
    seen.add(key)
    out.push({ bodyStart, bodyEnd, capabilityEnd })
  }
  return out
}

// 定位**已被塌缩**的决策函数体（仍含 capability+register，但不再含下游 feature-message/auth/allowlist/provider）。
export function locatePatchedDecisionBodies(text) {
  const out = []
  const seen = new Set()
  let start = 0
  while (true) {
    const capabilityPos = text.indexOf(CAPABILITY_MARKER, start)
    if (capabilityPos === -1) break
    start = capabilityPos + 1
    const windowEnd = Math.min(text.length, capabilityPos + DECISION_WINDOW)
    const registerPos = text.indexOf(REGISTER_RETURN, capabilityPos)
    if (registerPos === -1 || registerPos >= windowEnd) continue
    const bounds = findSmallestEnclosingBlock(text, capabilityPos, capabilityPos, registerPos)
    if (bounds === null) continue
    const key = bounds[0] + ':' + bounds[1]
    if (seen.has(key)) continue
    const [bodyStart, bodyEnd] = bounds
    const body = text.slice(bodyStart + 1, bodyEnd)
    if (!body.includes(CAPABILITY_MARKER) || !body.includes(REGISTER_RETURN)) continue
    if (!body.includes(SKIP_RETURN)) continue
    if (body.includes(FEATURE_MESSAGE) || DOWNSTREAM_GATES.some((g) => body.includes(g))) continue
    seen.add(key)
    out.push({ bodyStart, bodyEnd })
  }
  return out
}

// ── 单字节 / 标记锚点定位 ──────────────────────────────────────────────────

function locateFlagSites(buf, prefix) {
  const sites = []
  for (const off of findAll(buf, prefix)) {
    const site = off + prefix.length
    if (site < buf.length && (buf[site] === BYTE_TRUE || buf[site] === BYTE_FALSE)) sites.push(site)
  }
  return sites
}

export function locateFeatureFlagSites(buf) { return locateFlagSites(buf, FEATURE_FLAG_PREFIX) }
export function locatePermissionsFlagSites(buf) { return locateFlagSites(buf, PERMISSIONS_FLAG_PREFIX) }

// 定位 `// @bun @bytecode`（或已改的 @source__）标记的 tag 起始位置。
export function locateBunSites(buf) {
  const sites = []
  const span = BUN_BYTECODE.length
  for (const off of findAll(buf, BUN_TAG_PREFIX)) {
    const site = off + BUN_TAG_PREFIX.length
    const tag = buf.subarray(site, site + span)
    if (tag.equals(BUN_BYTECODE) || tag.equals(BUN_SOURCE)) sites.push(site)
  }
  return sites
}

// 定位能力剥离条件里的 `||`（改成 `&&` 让 server: 通道能力不被剥离）。旧版无此行 → 返回空。
export function locateCapStripSites(buf) {
  const sites = []
  const alen = CAP_STRIP_ANCHOR.length
  for (const off of findAll(buf, CAP_STRIP_ANCHOR)) {
    const start = off + alen
    const window = buf.subarray(start, start + CAP_STRIP_WINDOW)
    if (window.indexOf(CAP_STRIP_TAIL) === -1) continue
    for (let j = 0; j < window.length - 2; j++) {
      const pair = window.subarray(j, j + 2)
      if ((pair.equals(PIPE_PAIR) || pair.equals(AMP_PAIR)) && window[j + 2] === 0x21 /* '!' */) {
        sites.push(start + j)
        break
      }
    }
  }
  return sites
}

// ── 应用 ───────────────────────────────────────────────────────────────────

// 就地塌缩所有决策函数体（在 latin1 文本上算，写回同一 buf）。返回改写的函数体数量。
function applyDecisionRewrite(buf) {
  const text = buf.toString('latin1')
  const bodies = locateDecisionBodies(text)
  if (!bodies.length) return 0
  const edits = []
  for (const { bodyStart, bodyEnd, capabilityEnd } of bodies) {
    const preserved = text.slice(bodyStart + 1, capabilityEnd)
    let replacement = preserved + REGISTER_RETURN
    const originalLen = bodyEnd - bodyStart - 1
    if (replacement.length > originalLen) throw new Error('channels: decision rewrite would grow the body; refusing to patch')
    replacement = replacement.padEnd(originalLen, ' ')
    edits.push([bodyStart + 1, replacement])
  }
  for (const [pos, replacement] of edits) Buffer.from(replacement, 'latin1').copy(buf, pos)
  // 后验（在改后的 buf 上重解文本）。
  const verify = buf.toString('latin1')
  for (const { bodyStart, bodyEnd } of bodies) {
    const body = verify.slice(bodyStart + 1, bodyEnd)
    if (!body.includes(CAPABILITY_MARKER) || !body.includes(REGISTER_RETURN) ||
        body.includes(FEATURE_MESSAGE) || DOWNSTREAM_GATES.some((g) => body.includes(g))) {
      throw new Error('channels: decision rewrite failed post-verification; refusing to patch')
    }
  }
  return bodies.length
}

function applyByteSites(buf, sites, expected, replacement, desc, essential, log) {
  if (!sites.length) {
    if (essential) throw new Error(`FAIL [${desc}]: 未找到锚点`)
    log(`  SKIP ${desc} (该版本不存在)`)
    return 0
  }
  let edits = 0
  for (const site of sites) {
    const actual = buf[site]
    if (actual === replacement) { log(`  OK ${desc} @${site} (已是目标值)`); continue }
    if (actual !== expected) throw new Error(`FAIL [${desc}] @${site}: 期望 0x${expected.toString(16)}，实际 0x${actual.toString(16)}`)
    buf[site] = replacement
    edits++
    log(`  OK ${desc} @${site}`)
  }
  return edits
}

function applyBunFallback(buf, log) {
  const sites = locateBunSites(buf)
  const span = BUN_BYTECODE.length
  let edits = 0
  for (const site of sites) {
    const cur = buf.subarray(site, site + span)
    if (cur.equals(BUN_SOURCE)) { log(`  OK bun bytecode fallback @${site} (已是目标值)`); continue }
    if (!cur.equals(BUN_BYTECODE)) continue
    BUN_SOURCE.copy(buf, site)
    edits++
    log(`  OK bun bytecode fallback @${site}`)
  }
  return edits
}

function applyCapStrip(buf, log) {
  const sites = locateCapStripSites(buf)
  let edits = 0
  for (const site of sites) {
    const cur = buf.subarray(site, site + 2)
    if (cur.equals(AMP_PAIR)) { log(`  OK capability-strip neutralize @${site} (已是目标值)`); continue }
    if (!cur.equals(PIPE_PAIR)) continue
    AMP_PAIR.copy(buf, site)
    edits++
    log(`  OK capability-strip neutralize @${site}`)
  }
  return edits
}

function applySupportPatches(buf, log) {
  let edits = 0
  edits += applyBunFallback(buf, log)
  edits += applyByteSites(buf, locateFeatureFlagSites(buf), BYTE_TRUE, BYTE_FALSE, 'tengu_harbor default', true, log)
  edits += applyByteSites(buf, locatePermissionsFlagSites(buf), BYTE_TRUE, BYTE_FALSE, 'tengu_harbor_permissions default', false, log)
  edits += applyCapStrip(buf, log)
  return edits
}

// applyChannels(buf, log?) → { patched, edits }。完整补丁（决策改写 + 配套）。返回新 buffer，不改入参。
export function applyChannels(buf, log = () => {}) {
  const patched = Buffer.from(buf)
  const already = locatePatchedDecisionBodies(patched.toString('latin1')).length
  const rewritten = applyDecisionRewrite(patched)
  if (rewritten === 0 && already === 0) throw new Error('FAIL [decision]: 无法定位 channel 决策函数（版本结构可能又变了）')
  const support = applySupportPatches(patched, log)
  return { patched, edits: rewritten + support }
}

// ── 分类 ───────────────────────────────────────────────────────────────────

function classifySites(buf, sites, expected, replacement) {
  if (!sites.length) return 'absent'
  const values = sites.map((s) => buf[s])
  if (values.every((v) => v === replacement)) return 'patched'
  if (values.every((v) => v === expected)) return 'clean'
  return 'mixed'
}

function classifyBun(buf) {
  const sites = locateBunSites(buf)
  if (!sites.length) return { state: 'absent', detail: null }
  const span = BUN_BYTECODE.length
  const vals = sites.map((s) => buf.subarray(s, s + span))
  if (vals.every((v) => v.equals(BUN_SOURCE))) return { state: 'patched', detail: `bun bytecode fallback: patched (${sites.length})` }
  if (vals.every((v) => v.equals(BUN_BYTECODE))) return { state: 'clean', detail: `bun bytecode fallback: clean (${sites.length})` }
  return { state: 'mixed', detail: `bun bytecode fallback: mixed (${sites.length})` }
}

function classifyCapStrip(buf) {
  const sites = locateCapStripSites(buf)
  if (!sites.length) return { state: 'absent', detail: null }
  const vals = sites.map((s) => buf.subarray(s, s + 2))
  if (vals.every((v) => v.equals(AMP_PAIR))) return { state: 'patched', detail: `capability-strip neutralize: patched (${sites.length})` }
  if (vals.every((v) => v.equals(PIPE_PAIR))) return { state: 'clean', detail: `capability-strip neutralize: clean (${sites.length})` }
  return { state: 'mixed', detail: `capability-strip neutralize: mixed (${sites.length})` }
}

// classifyChannels(buf) → { status, details:[] }。status ∈ clean|patched|mixed|unsupported。
export function classifyChannels(buf) {
  const text = buf.toString('latin1')
  const details = []
  const states = []
  const patchedBodies = locatePatchedDecisionBodies(text)
  const candidateBodies = locateDecisionBodies(text)
  if (patchedBodies.length) {
    details.push(`已塌缩的决策函数体: ${patchedBodies.length}`)
    states.push('patched')
  } else if (candidateBodies.length) {
    details.push(`可塌缩的决策函数候选: ${candidateBodies.length}`)
    states.push('clean')
  } else {
    details.push('未找到 channel 决策函数（不支持的版本结构）')
    return { status: 'unsupported', details }
  }
  const checks = [
    ['feature flag', locateFeatureFlagSites(buf), true],
    ['permissions flag', locatePermissionsFlagSites(buf), false],
  ]
  for (const [desc, sites, essential] of checks) {
    const state = classifySites(buf, sites, BYTE_TRUE, BYTE_FALSE)
    if (state === 'absent') {
      details.push(`${desc}: ${essential ? '缺失(必须)' : '不存在(可选)'}`)
      if (essential) states.push('mixed')
      continue
    }
    details.push(`${desc}: ${state} (${sites.length})`)
    states.push(state)
  }
  for (const { state, detail } of [classifyBun(buf), classifyCapStrip(buf)]) {
    if (detail) { details.push(detail); states.push(state) }
  }
  if (states.length && states.every((s) => s === 'patched')) return { status: 'patched', details }
  if (states.length && states.every((s) => s === 'clean')) return { status: 'clean', details }
  return { status: 'mixed', details }
}
