import { performance } from 'node:perf_hooks'

import { openFileReader } from '../../io/raw-reader.mjs'
import { claudeFeatureRegistry } from './index.mjs'
import { ABSENT } from './variants.mjs'

const VERSION_ANCHOR = Buffer.from('overview",VERSION:"', 'latin1')
const VERSION_MAX_LENGTH = 24
const VERSION_PATTERN = /^\d+(?:\.\d+)*$/
const CANDIDATE_RADIUS = 8_000
const SOURCE_DISCOVERY_BYTES = 32_000_000
const CLAUDE_FEATURES = new Set(['source-exec', 'agent-model', 'channels'])

function validateRange(range, size) {
  if (!Array.isArray(range) || range.length !== 2) throw new TypeError('probe window must be a [start, end] pair')
  const [start, end] = range
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > size) {
    throw new RangeError(`probe window [${start}, ${end}) is outside binary size ${size}`)
  }
  return [start, end]
}

function mergeRanges(ranges) {
  const merged = []
  for (const [start, end] of [...ranges].sort((left, right) => left[0] - right[0] || left[1] - right[1])) {
    const previous = merged.at(-1)
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end)
    else merged.push([start, end])
  }
  return merged
}

function readRanges(reader, ranges) {
  return ranges.map(([start, end]) => ({ offset: start, bytes: reader.slice(start, end - start) }))
}

function sliceFromCache(cache, start, end) {
  const containing = cache.find((window) => window.offset <= start && window.offset + window.bytes.length >= end)
  if (!containing) throw new Error(`probe window [${start}, ${end}) was not read`)
  const localStart = start - containing.offset
  return { offset: start, bytes: containing.bytes.subarray(localStart, localStart + end - start) }
}

function featureSlices(cache, ranges) {
  return mergeRanges(ranges).map(([start, end]) => sliceFromCache(cache, start, end))
}

function extractVersion(windows) {
  for (let windowIndex = windows.length - 1; windowIndex >= 0; windowIndex--) {
    const bytes = windows[windowIndex].bytes
    const anchor = bytes.lastIndexOf(VERSION_ANCHOR)
    if (anchor === -1) continue
    const start = anchor + VERSION_ANCHOR.length
    const end = bytes.indexOf(0x22, start)
    if (end === -1 || end - start > VERSION_MAX_LENGTH) continue
    const version = bytes.subarray(start, end).toString('latin1')
    if (VERSION_PATTERN.test(version)) return version
  }
  return null
}

function substateKind(id) {
  return id.replace(/:\d+$/, '')
}

export function normalizeSubstates(feature, windows, size) {
  // 带跨窗语义的 feature 先收原始站点、跨窗合并，再一次性定序号与缺失占位——单窗视角判不出
  // 「站点真缺失」还是「站点在别的窗里」（见 channels 的 observe_raw_sites 注释）。
  if (typeof feature.observe_raw_sites === 'function' && typeof feature.aggregate_raw_sites === 'function') {
    const raw = windows.flatMap((window) => feature.observe_raw_sites(window.bytes).map((record) => ({
      ...record,
      offset: record.offset + window.offset,
    })))
    return feature.aggregate_raw_sites(raw, size ?? windows.reduce((end, window) => Math.max(end, window.offset + window.bytes.length), 0))
  }
  const records = windows.flatMap((window) => feature.observe_substates(window.bytes).map((record) => ({
    ...record,
    offset: record.offset + window.offset,
    id: substateKind(record.id),
  })))
  const indexes = new Map()
  return records.map((record) => {
    // absent 占位（`channels:<kind>:absent`）不是真实站点，也没有序号可言：substateKind 的
    // `/:\d+$/` 剥不掉它的后缀，若照常补序号会得到 `...:absent:0`，与 full detect 不等。
    if (record.state === ABSENT) return record
    const kind = record.id
    const index = indexes.get(kind) ?? 0
    indexes.set(kind, index + 1)
    // 序号无条件保留（与 Python 的 `f"{kind}:{index}"` 一致）。曾按「该 kind 只有一个站点
    // 就省略序号」处理，导致 windowed 与 full 的 id 分歧，只能靠单站点守卫回落 full 掩盖。
    return { ...record, id: `${kind}:${index}` }
  })
}

function candidateRanges(feature, discoveryWindows, size) {
  if (!CLAUDE_FEATURES.has(feature.name)) return null
  return mergeRanges(normalizeSubstates(feature, discoveryWindows, size)
    .filter((record) => record.state !== ABSENT)
    .map((record) => [
      Math.max(0, record.offset - CANDIDATE_RADIUS),
      Math.min(size, record.offset + record.length + CANDIDATE_RADIUS),
    ]))
}

function candidatesComplete(feature, ranges, discoveryWindows, size) {
  const covered = ranges.every(([start, end]) => discoveryWindows.some(
    (window) => window.offset <= start && window.offset + window.bytes.length >= end,
  ))
  if (!covered || feature.name !== 'source-exec' || size <= SOURCE_DISCOVERY_BYTES * 2) return covered
  const headEnd = SOURCE_DISCOVERY_BYTES
  const tailStart = size - SOURCE_DISCOVERY_BYTES
  return !ranges.some(([start, end]) => start < headEnd && headEnd < end || start < tailStart && tailStart < end)
}

function featureStatus(detected, substates) {
  return {
    state: detected.state,
    sites: Array.isArray(detected.sites) ? detected.sites.length : detected.sites,
    detail_codes: detected.code ? [detected.code] : [],
    substates,
  }
}

export function inspectClaudeBytes(bytes, { features = claudeFeatureRegistry.features() } = {}) {
  if (!Buffer.isBuffer(bytes)) throw new TypeError('Claude binary inspection requires a Buffer')
  const featureStatuses = Object.fromEntries(features.map((feature) => {
    const detected = feature.detect(bytes)
    return [feature.name, featureStatus(detected, feature.observe_substates(bytes))]
  }))
  return {
    embeddedVersion: extractVersion([{ offset: 0, bytes }]),
    states: Object.fromEntries(Object.entries(featureStatuses).map(([name, status]) => [name, status.state])),
    features: featureStatuses,
  }
}

export function probeClaudeBinary(path, options = {}) {
  const openReader = options.openReader ?? openFileReader
  const features = options.features ?? claudeFeatureRegistry.features()
  const now = options.now ?? (() => performance.now())
  const started = now()
  const reader = openReader(path)

  try {
    const rangesByFeature = new Map(features.map((feature) => [
      feature,
      (feature.probe_windows(reader) ?? []).map((range) => validateRange(range, reader.size)),
    ]))
    const allRanges = [...rangesByFeature.values()].flat()
    const cachedWindows = readRanges(reader, mergeRanges(allRanges))
    const version = extractVersion(cachedWindows)
    const versionFinished = now()
    const statuses = {}
    const byFeature = {}
    let fullBytes = null

    const getFullBytes = () => {
      if (fullBytes) return fullBytes
      const cachedFull = cachedWindows.find((window) => window.offset === 0 && window.bytes.length === reader.size)
      fullBytes = cachedFull?.bytes ?? reader.slice(0, reader.size)
      return fullBytes
    }

    let featureStarted = versionFinished
    for (const feature of features) {
      const ranges = rangesByFeature.get(feature)
      const discoveryWindows = featureSlices(cachedWindows, ranges)
      const candidates = candidateRanges(feature, discoveryWindows, reader.size)
      const complete = candidates == null || candidates.length > 0 && candidatesComplete(feature, candidates, discoveryWindows, reader.size)
      const windows = candidates == null || !complete ? discoveryWindows : featureSlices(cachedWindows, candidates)
      const detected = complete ? feature.detect_windows(windows) : null
      if (detected == null || detected.state === 'unsupported') {
        const bytes = getFullBytes()
        statuses[feature.name] = featureStatus(feature.detect(bytes), feature.observe_substates(bytes))
      } else {
        statuses[feature.name] = featureStatus(detected, normalizeSubstates(feature, windows, reader.size))
      }
      const featureFinished = now()
      byFeature[feature.name] = featureFinished - featureStarted
      featureStarted = featureFinished
    }

    const finished = now()
    return {
      version,
      size: reader.size,
      timing: {
        version_ms: versionFinished - started,
        features_ms: finished - versionFinished,
        total_ms: finished - started,
        by_feature_ms: byFeature,
      },
      features: statuses,
    }
  } finally {
    reader.close()
  }
}