import { Feature } from '../../core/feature.mjs'
import {
  ABSENT,
  CLEAN,
  MIXED,
  PATCHED,
  UNSUPPORTED,
  findAll,
  normalizeWindows,
  stateOf,
  substateError,
  validateReplay,
  writable,
} from './variants.mjs'

const CAPABILITY = 'claude/channel'
const FEATURE_MESSAGE = 'channels feature is not currently available'
const REGISTER_RETURN = 'return{action:"register"}'
const SKIP_RETURN = 'return{action:"skip"'
const DOWNSTREAM_GATES = ['kind:"auth"', 'kind:"allowlist"', 'kind:"provider"']
const DECISION_WINDOW = 8000
const MAX_BLOCK_LOOKBACK = 2500
const SCAN_TAIL_BYTES = 64 * 1024 * 1024

const FEATURE_FLAG = Buffer.from('tengu_harbor",!', 'latin1')
const PERMISSIONS_FLAG = Buffer.from('tengu_harbor_permissions",!', 'latin1')
const CAP_STRIP = Buffer.from('["claude/channel"]&&(', 'latin1')
const CAP_STRIP_TAIL = Buffer.from(')))delete', 'latin1')

function matchingBrace(text, openOffset) {
  if (text[openOffset] !== '{') return -1
  let depth = 0
  let mode = 'normal'
  for (let offset = openOffset; offset < text.length; offset++) {
    const character = text[offset]
    const next = text[offset + 1] ?? ''
    if (mode === 'normal') {
      if (character === '/' && next === '/') { mode = 'line'; offset++; continue }
      if (character === '/' && next === '*') { mode = 'block'; offset++; continue }
      if (character === "'") mode = 'single'
      else if (character === '"') mode = 'double'
      else if (character === '`') mode = 'template'
      else if (character === '{') depth++
      else if (character === '}' && --depth === 0) return offset
    } else if (mode === 'line' && character === '\n') mode = 'normal'
    else if (mode === 'block' && character === '*' && next === '/') { mode = 'normal'; offset++ }
    else if ((mode === 'single' && character === "'") || (mode === 'double' && character === '"') || (mode === 'template' && character === '`')) mode = 'normal'
    else if ((mode === 'single' || mode === 'double' || mode === 'template') && character === '\\') offset++
  }
  return -1
}

function enclosingBlock(text, markerOffset, capabilityOffset, registerOffset) {
  let best = null
  for (let open = capabilityOffset; open >= Math.max(0, capabilityOffset - MAX_BLOCK_LOOKBACK); open--) {
    if (text[open] !== '{') continue
    const close = matchingBrace(text, open)
    if (open < markerOffset && markerOffset < close && open < capabilityOffset && capabilityOffset < close && open < registerOffset && registerOffset < close) {
      if (!best || close - open < best.close - best.open) best = { open, close }
    }
  }
  return best
}

function capabilityEnd(text, body, capabilityOffset) {
  const ifOffset = text.lastIndexOf('if(', capabilityOffset)
  const skipOffset = text.indexOf(SKIP_RETURN, ifOffset)
  if (ifOffset <= body.open || skipOffset === -1 || skipOffset >= body.close || !text.slice(ifOffset, skipOffset).includes(CAPABILITY)) return -1
  const objectOpen = text.indexOf('{', skipOffset)
  const objectClose = matchingBrace(text, objectOpen)
  if (objectOpen === -1 || objectClose === -1 || objectClose >= body.close) return -1
  let end = objectClose + 1
  while (end < body.close && ' ;\r\n\t'.includes(text[end])) end++
  return end
}

function cleanDecisions(text) {
  const decisions = []
  const seen = new Set()
  for (let marker = 0; (marker = text.indexOf(FEATURE_MESSAGE, marker)) !== -1; marker++) {
    const capability = text.lastIndexOf(CAPABILITY, marker)
    const register = text.indexOf(REGISTER_RETURN, marker)
    if (capability < Math.max(0, marker - DECISION_WINDOW) || register === -1 || register >= marker + DECISION_WINDOW) continue
    const body = enclosingBlock(text, marker, capability, register)
    if (!body || seen.has(body.open)) continue
    const preservedEnd = capabilityEnd(text, body, capability)
    if (preservedEnd === -1 || preservedEnd >= register) continue
    seen.add(body.open)
    decisions.push({ ...body, preservedEnd, state: CLEAN })
  }
  return decisions
}

function patchedDecisions(text) {
  const decisions = []
  const seen = new Set()
  for (let capability = 0; (capability = text.indexOf(CAPABILITY, capability)) !== -1; capability++) {
    const register = text.indexOf(REGISTER_RETURN, capability)
    if (register === -1 || register >= capability + DECISION_WINDOW) continue
    const body = enclosingBlock(text, capability, capability, register)
    if (!body || seen.has(body.open)) continue
    const contents = text.slice(body.open + 1, body.close)
    if (!contents.includes(SKIP_RETURN) || contents.includes(FEATURE_MESSAGE) || DOWNSTREAM_GATES.some((gate) => contents.includes(gate))) continue
    seen.add(body.open)
    decisions.push({ ...body, state: PATCHED })
  }
  return decisions
}

function flagSites(bytes, prefix, kind, essential) {
  const sites = []
  for (const anchor of findAll(bytes, prefix)) {
    const offset = anchor + prefix.length
    if (bytes[offset] === 0x31 || bytes[offset] === 0x30) {
      sites.push({ kind, offset, localOffset: offset, length: 1, state: bytes[offset] === 0x31 ? CLEAN : PATCHED, essential })
    }
  }
  return sites
}

function capStripSites(bytes) {
  const sites = []
  for (const anchor of findAll(bytes, CAP_STRIP)) {
    const start = anchor + CAP_STRIP.length
    const window = bytes.subarray(start, start + 80)
    if (window.indexOf(CAP_STRIP_TAIL) === -1) continue
    for (let index = 0; index < window.length - 2; index++) {
      const pair = window.subarray(index, index + 2).toString('latin1')
      if ((pair === '||' || pair === '&&') && window[index + 2] === 0x21) {
        sites.push({ kind: 'cap-strip', offset: start + index, localOffset: start + index, length: 2, state: pair === '||' ? CLEAN : PATCHED, essential: false })
        break
      }
    }
  }
  return sites
}

function locate(bytes) {
  const text = bytes.toString('latin1')
  const clean = cleanDecisions(text)
  const patched = patchedDecisions(text)
  const decisions = [...clean, ...patched].sort((left, right) => left.open - right.open).map((body) => ({
    kind: 'decision',
    offset: body.open + 1,
    localOffset: body.open + 1,
    length: body.close - body.open - 1,
    state: body.state,
    essential: true,
    body,
  }))
  return {
    sites: [
      ...decisions,
      ...flagSites(bytes, FEATURE_FLAG, 'feature-flag', true),
      ...flagSites(bytes, PERMISSIONS_FLAG, 'permissions', false),
      ...capStripSites(bytes),
    ],
    decisions,
    decoysSkipped: Math.max(0, findAll(bytes, Buffer.from(REGISTER_RETURN, 'latin1')).length - decisions.length),
  }
}

const SITE_KINDS = ['decision', 'feature-flag', 'permissions', 'cap-strip']

// 逐窗观测的**原始**站点：不早退、不补 absent 占位、不定序号。窗口化探测必须先跨窗把这些
// 原始站点并起来，再一次性判定缺失与序号——否则单看一个窗会得出错误结论，比如 cap-strip
// 站点距 decision 约 12MB、独占一个候选窗，该窗没有 decision 就被 `records()` 早退成 []，
// 而含 decision 的那个窗又会补出一个假的 `cap-strip:absent`，把已 patched 的站点误报为不存在。
function rawRecords(bytes) {
  return locate(bytes).sites.map((site) => ({
    kind: site.kind,
    offset: site.offset,
    length: site.length,
    state: site.state,
  }))
}

// 把跨窗合并后的原始站点收敛成与 full detect 同形的 substate 列表。
function aggregateRecords(raw, size) {
  const unique = new Map()
  for (const record of raw) unique.set(`${record.kind}:${record.offset}:${record.length}`, record)
  const sites = [...unique.values()].sort((left, right) => left.offset - right.offset)
  if (!sites.some((site) => site.kind === 'decision')) return []
  return SITE_KINDS.flatMap((kind) => {
    const matching = sites.filter((site) => site.kind === kind)
    return matching.length > 0
      ? matching.map((site, index) => ({
        id: `channels:${kind}:${index}`,
        offset: site.offset,
        length: site.length,
        state: site.state,
      }))
      : [{ id: `channels:${kind}:absent`, offset: size, length: 0, state: 'absent' }]
  })
}

function records(bytes) {
  return aggregateRecords(rawRecords(bytes), bytes.length)
}

function detect(bytes) {
  const { sites, decisions, decoysSkipped } = locate(bytes)
  if (decisions.length === 0) return { state: UNSUPPORTED, sites: 0 }
  if (!sites.some((site) => site.kind === 'feature-flag')) return { state: MIXED, sites: sites.length, code: 'channels_essential_site_missing' }
  const result = { state: stateOf(sites.map((site) => site.state)), sites: sites.length }
  if (!sites.some((site) => site.kind === 'permissions') || !sites.some((site) => site.kind === 'cap-strip')) result.optional = true
  if (decoysSkipped > 0) result.decoys_skipped = decoysSkipped
  return result
}

function probeWindows(readerOrSize) {
  const size = typeof readerOrSize === 'number' ? readerOrSize : readerOrSize?.size
  if (!Number.isSafeInteger(size) || size < 0) throw new TypeError('size must be a non-negative safe integer')
  return [[Math.max(0, size - SCAN_TAIL_BYTES), size]]
}

function detectWindows(windows) {
  const normalized = normalizeWindows(windows)
  const bySite = new Map()
  let decoysSkipped = 0
  for (const window of normalized) {
    const located = locate(window.bytes)
    decoysSkipped += located.decoysSkipped
    for (const site of located.sites) {
      const absolute = { ...site, offset: site.offset + window.offset }
      bySite.set(`${absolute.kind}:${absolute.offset}:${absolute.length}`, absolute)
    }
  }
  const sites = [...bySite.values()].sort((left, right) => left.offset - right.offset)
  const decisions = sites.filter((site) => site.kind === 'decision')
  if (decisions.length === 0) return { state: UNSUPPORTED, sites: 0 }
  if (!sites.some((site) => site.kind === 'feature-flag')) {
    return { state: MIXED, sites: sites.length, code: 'channels_essential_site_missing' }
  }
  const result = { state: stateOf(sites.map((site) => site.state)), sites: sites.length }
  if (!sites.some((site) => site.kind === 'permissions') || !sites.some((site) => site.kind === 'cap-strip')) result.optional = true
  if (decoysSkipped > 0) result.decoys_skipped = decoysSkipped
  return {
    ...result,
    site_offsets: sites.map((site) => site.offset),
  }
}

function replacementFor(site, state, bytes) {
  if (site.kind === 'feature-flag' || site.kind === 'permissions') return Buffer.from(state === PATCHED ? '0' : '1', 'latin1')
  if (site.kind === 'cap-strip') return Buffer.from(state === PATCHED ? '&&' : '||', 'latin1')
  if (site.kind !== 'decision') throw substateError(`unknown channels site ${site.kind}`)
  if (state === CLEAN) throw substateError('channels decision is irreversible')
  const text = bytes.toString('latin1')
  const preserved = text.slice(site.body.open + 1, site.body.preservedEnd)
  const replacement = `${preserved}${REGISTER_RETURN}`.padEnd(site.length, ' ')
  if (replacement.length !== site.length) throw substateError('channels decision replacement is not equal length')
  return Buffer.from(replacement, 'latin1')
}

function apply(bytes, options) {
  const output = writable(bytes, options)
  const located = locate(output)
  if (located.decisions.length === 0) throw new Error('channels_unsupported: decision site not found')
  if (!located.sites.some((site) => site.kind === 'feature-flag')) {
    const error = new Error('channels_essential_site_missing: feature flag site not found')
    error.code = 'channels_essential_site_missing'
    throw error
  }
  let edits = 0
  for (const site of located.sites) {
    if (site.state === PATCHED) continue
    replacementFor(site, PATCHED, output).copy(output, site.localOffset)
    edits++
  }
  return { bytes: output, edits }
}

function replaySubstates(bytes, desired, options) {
  const output = writable(bytes, options)
  const located = locate(output)
  // L3B-03：replay 必须与 observe_substates 使用**同一** site 集合（含 optional 站点缺失时的 absent
  // 占位），否则缺 permissions / cap-strip 的 build 上二者长度不等，validateReplay 必抛
  // substate_unreplayable——实测会让这类二进制连 agent-model 都写不进去，且与 Python
  // （channels.py 的 allow_absent=True）行为分歧。
  const current = records(output)
  validateReplay(current, desired, { allowAbsent: true })
  // absent 占位不对应任何真实站点，按顺序映射回 located.sites 时要跳过它们。
  let siteIndex = 0
  let edits = 0
  for (let index = 0; index < current.length; index++) {
    if (current[index].state === ABSENT) continue
    const site = located.sites[siteIndex++]
    if (desired[index].state === CLEAN && site.kind === 'decision' && site.state !== CLEAN) {
      throw substateError('channels decision cannot be reversed without a clean baseline')
    }
    if (desired[index].state !== site.state) {
      replacementFor(site, desired[index].state, output).copy(output, site.localOffset)
      edits += 1
    }
  }
  return { bytes: output, edits }
}

export const channelsFeature = new Feature({
  name: 'channels',
  title: 'Channels',
  description: 'Enable Claude channels through essential and best-effort equal-length owned-site rewrites.',
  requires: ['source-exec'],
  reversible: false,
  detect,
  probe_windows: probeWindows,
  detect_windows: detectWindows,
  observe_substates: records,
  observe_raw_sites: rawRecords,
  aggregate_raw_sites: aggregateRecords,
  replay_substates: replaySubstates,
  apply,
})