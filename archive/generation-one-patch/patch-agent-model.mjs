// lib/patch-agent-model.mjs — 放开 Claude Code `Agent`/`Task` 工具 `model` 入参的枚举白名单。
//
// 吸收自 ~/.claude/scripts/agent-patch/patch.py（JS 重写、纳入 bun test）。新版 CC 把 model 参数校验成
// 一个 zod 枚举 `model:E.enum(["sonnet","opus","haiku","fable"])`，内联 `Agent(model="gpt-5.5")` 会在
// **入参解析层**被拒。本模块把这处 `E.enum([...])` **等长**改成 `E.string()`（放开为任意字符串），
// 用块注释补齐到与原枚举等长 → 二进制 size 分毫不变、Bun 尾部 TOC 偏移全不动。
//
// 本模块只做**纯字节**变换（收 buf 出 buf），不碰文件系统 / 备份 / 版本检测——那些编排放在
// lib/patch-binary.mjs。纯函数便于合成 buffer 单测。前缀 `model:` 保证只命中 Agent 工具的 model 字段。

const ENUM_ANCHOR = Buffer.from('model:E.enum(["sonnet","opus","haiku","fable"])', 'latin1')
const ENUM_CORE = Buffer.from('E.enum(["sonnet","opus","haiku","fable"])', 'latin1') // 待替换核心（41 字节）
const REPLACE_CORE_BASE = 'E.string()' // 放开为任意字符串

// 构造与 ENUM_CORE **等长**的替换串：`E.string()` + 块注释补齐（`E.string()/* any model */...`）。
function buildReplacement() {
  const padLen = ENUM_CORE.length - REPLACE_CORE_BASE.length
  if (padLen < 4) throw new Error('anchor shorter than replacement; cannot keep equal length')
  const inner = ' any model '
  const fill = padLen - '/*'.length - '*/'.length
  const body = inner.length > fill ? '' : inner
  const comment = '/*' + body + '.'.repeat(fill - body.length) + '*/'
  const rep = REPLACE_CORE_BASE + comment
  if (rep.length !== ENUM_CORE.length) throw new Error(`replacement len ${rep.length} != core ${ENUM_CORE.length}`)
  return Buffer.from(rep, 'latin1')
}

export const AGENT_MODEL_CORE = ENUM_CORE
export const AGENT_MODEL_REPLACE = buildReplacement()

function findAll(buf, pattern) {
  const out = []
  for (let i = 0; (i = buf.indexOf(pattern, i)) !== -1; i++) out.push(i)
  return out
}

// 返回未补丁的 `E.enum([...])` 核心起始偏移列表（仅 `model:` 前缀命中处）。
export function locateEnumSites(buf) {
  const sites = []
  const delta = ENUM_ANCHOR.length - ENUM_CORE.length
  for (const off of findAll(buf, ENUM_ANCHOR)) {
    const core = off + delta
    if (buf.subarray(core, core + ENUM_CORE.length).equals(ENUM_CORE)) sites.push(core)
  }
  return sites
}

// 返回已被替换为 `E.string()...` 的偏移列表（`model:E.string(` 前缀且整段等于替换核心）。
export function locatePatchedSites(buf) {
  const prefix = Buffer.from('model:' + REPLACE_CORE_BASE, 'latin1') // model:E.string(
  const sites = []
  const off0 = 'model:'.length
  for (const off of findAll(buf, prefix)) {
    const core = off + off0
    if (buf.subarray(core, core + AGENT_MODEL_REPLACE.length).equals(AGENT_MODEL_REPLACE)) sites.push(core)
  }
  return sites
}

// classifyAgentModel(buf) → { status, detail }。status ∈ clean|patched|mixed|unsupported。
export function classifyAgentModel(buf) {
  const clean = locateEnumSites(buf)
  const patched = locatePatchedSites(buf)
  if (patched.length && !clean.length) return { status: 'patched', detail: `model enum: patched (${patched.length})` }
  if (clean.length && !patched.length) return { status: 'clean', detail: `model enum: clean (${clean.length})` }
  if (!clean.length && !patched.length) return { status: 'unsupported', detail: 'model enum: 未找到锚点（版本结构可能变了）' }
  return { status: 'mixed', detail: `model enum: mixed (clean=${clean.length}, patched=${patched.length})` }
}

// applyAgentModel(buf) → { patched, edits }。就地等长替换所有 `model:E.enum([...])`。
// 已是 patched → edits=0；找不到锚点且非 patched → 抛（fail-loud）。返回新 buffer，不改入参。
export function applyAgentModel(buf) {
  const patched = Buffer.from(buf)
  const sites = locateEnumSites(patched)
  if (!sites.length) {
    if (locatePatchedSites(patched).length) return { patched, edits: 0 }
    throw new Error('agent-model: 未找到 model 枚举锚点（版本结构可能又变了）')
  }
  for (const off of sites) AGENT_MODEL_REPLACE.copy(patched, off)
  if (locateEnumSites(patched).length) throw new Error('agent-model: 改写后仍存在未替换枚举，拒绝写盘')
  return { patched, edits: sites.length }
}

// revertAgentModel(buf) → { patched, reverted }。把 `E.string()...` 逐处还原回原枚举（字节级、无损）。
export function revertAgentModel(buf) {
  const patched = Buffer.from(buf)
  const sites = locatePatchedSites(patched)
  for (const off of sites) AGENT_MODEL_CORE.copy(patched, off)
  return { patched, reverted: sites.length }
}

// quickStatusAgentModelReader(reader) → 'clean'|'patched'|'unsupported'。**在 reader 上开尾窗**只读判级：
// model 枚举锚在 bundle（SEA 尾部），从尾用 lastIndexOf 找 `model:E.enum(` / `model:E.string(`，命中即定级，
// 不全量读入/解码。省内存关键（同 channels quickStatusChannelsReader）。
const CLEAN_PREFIX = Buffer.from('model:E.enum(["sonnet"', 'latin1')
const PATCHED_PREFIX = Buffer.from('model:E.string()', 'latin1')
const AM_SCAN_TAIL = 64 * 1024 * 1024
export function quickStatusAgentModelReader(reader) {
  const size = reader.size
  const from = Math.max(0, size - AM_SCAN_TAIL)
  const patched = reader.lastIndexOf(PATCHED_PREFIX, from, size)
  const clean = reader.lastIndexOf(CLEAN_PREFIX, from, size)
  if (patched !== -1 && clean === -1) return 'patched'
  if (clean !== -1 && patched === -1) return 'clean'
  if (clean === -1 && patched === -1) return 'unsupported'
  return 'mixed'
}
