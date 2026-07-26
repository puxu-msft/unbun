import { Feature } from '../../core/feature.mjs'
import {
  CLEAN,
  PATCHED,
  findAll,
  normalizeWindows,
  stateOf,
  validateReplay,
  writable,
} from './variants.mjs'

const PREFIX = Buffer.from('// @bun ', 'latin1')
const CLEAN_TAG = Buffer.from(' @bytecode', 'latin1')
const PATCHED_TAG = Buffer.from(' @source__', 'latin1')
const PROBE_WINDOW = 8_000
const CENSUS_CHUNK = 32 * 1024 * 1024

function locate(bytes, baseOffset = 0) {
  const sites = []
  for (const prefixOffset of findAll(bytes, PREFIX)) {
    const localOffset = prefixOffset + PREFIX.length - 1
    const value = bytes.subarray(localOffset, localOffset + CLEAN_TAG.length)
    const state = value.equals(CLEAN_TAG) ? CLEAN : value.equals(PATCHED_TAG) ? PATCHED : null
    if (state) sites.push({ offset: baseOffset + localOffset, localOffset, length: CLEAN_TAG.length, state })
  }
  return sites
}

function records(bytes) {
  const sites = locate(bytes)
  return sites.map((entry, index) => ({
    id: `source-exec:tag:${index}`,
    offset: entry.offset,
    length: entry.length,
    state: entry.state,
  }))
}

function detect(bytes) {
  const sites = locate(bytes)
  return { state: stateOf(sites.map((site) => site.state)), sites: sites.length }
}

// 全文件锚点 census：对每个 `// @bun` 命中开一个 ±8,000 的小窗。
//
// 旧实现只扫首尾各 32,000,000 bytes，中段的标记会被**静默漏掉**——而 candidatesComplete 只检查
// 候选是否跨越 discovery 边界、不检查「有没有从未扫过的区域」，所以连 fail-closed 回落都不会
// 触发，直接违反「不允许返回较少站点的快速近似」。census 反而更省：`Buffer.indexOf` 走 mmap
// 只需几十毫秒，而回落整读要对 268MB 做 `toString('latin1')`（每次约 200ms）。
function probeWindows(readerOrSize) {
  const size = typeof readerOrSize === 'number' ? readerOrSize : readerOrSize?.size
  if (!Number.isSafeInteger(size) || size < 0) throw new TypeError('size must be a non-negative safe integer')
  // 只给了 size（没有 reader）就无法 census，退回整窗——由调用方保证完整性。
  if (typeof readerOrSize?.slice !== 'function' || size === 0) return [[0, size]]
  const windows = []
  for (const anchor of censusAnchors(readerOrSize, size)) {
    windows.push([
      Math.max(0, anchor - PROBE_WINDOW),
      Math.min(size, anchor + PREFIX.length + CLEAN_TAG.length + PROBE_WINDOW),
    ])
  }
  return windows.length > 0 ? mergeRanges(windows) : [[0, size]]
}

// 分块扫描，块间保留 PREFIX 长度的重叠，避免锚点恰好跨块边界被漏掉。
function censusAnchors(reader, size) {
  const anchors = []
  const overlap = PREFIX.length - 1
  for (let start = 0; start < size; start += CENSUS_CHUNK - overlap) {
    const end = Math.min(size, start + CENSUS_CHUNK)
    const chunk = reader.slice(start, end - start)
    for (const offset of findAll(chunk, PREFIX)) {
      const absolute = start + offset
      if (anchors.at(-1) !== absolute) anchors.push(absolute)
    }
    if (end === size) break
  }
  return anchors
}

function mergeRanges(ranges) {
  const merged = []
  for (const [start, end] of [...ranges].sort((left, right) => left[0] - right[0])) {
    const previous = merged.at(-1)
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end)
    else merged.push([start, end])
  }
  return merged
}

function detectWindows(windows) {
  const byOffset = new Map()
  for (const window of normalizeWindows(windows)) {
    for (const site of locate(window.bytes, window.offset)) {
      byOffset.set(site.offset, site)
    }
  }
  const sites = [...byOffset.values()].sort((left, right) => left.offset - right.offset)
  return { state: stateOf(sites.map((site) => site.state)), sites: sites.map((site) => site.offset) }
}

function transform(bytes, from, to, options) {
  const output = writable(bytes, options)
  let edits = 0
  for (const site of locate(output)) {
    if (site.state !== from) continue
    ;(to === PATCHED ? PATCHED_TAG : CLEAN_TAG).copy(output, site.localOffset)
    edits++
  }
  return { bytes: output, edits }
}

function replaySubstates(bytes, desired, options) {
  const output = writable(bytes, options)
  const current = records(output)
  validateReplay(current, desired)
  for (let index = 0; index < current.length; index++) {
    const replacement = desired[index].state === PATCHED ? PATCHED_TAG : CLEAN_TAG
    replacement.copy(output, current[index].offset)
  }
  return { bytes: output, edits: current.filter((site, index) => site.state !== desired[index].state).length }
}

export const sourceExecFeature = new Feature({
  name: 'source-exec',
  title: 'Source execution',
  description: 'Use embedded Bun source instead of bytecode at every audited source marker.',
  requires: [],
  reversible: true,
  detect,
  probe_windows: probeWindows,
  detect_windows: detectWindows,
  observe_substates: records,
  replay_substates: replaySubstates,
  apply: (bytes, options) => transform(bytes, CLEAN, PATCHED, options),
  reverse: (bytes, options) => transform(bytes, PATCHED, CLEAN, options),
})