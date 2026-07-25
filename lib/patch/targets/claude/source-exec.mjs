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
const DISCOVERY_BYTES = 32_000_000

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

function probeWindows(readerOrSize) {
  const size = typeof readerOrSize === 'number' ? readerOrSize : readerOrSize?.size
  if (!Number.isSafeInteger(size) || size < 0) throw new TypeError('size must be a non-negative safe integer')
  if (size <= DISCOVERY_BYTES * 2) return [[0, size]]
  return [[0, DISCOVERY_BYTES], [size - DISCOVERY_BYTES, size]]
}

function detectWindows(windows) {
  const byOffset = new Map()
  for (const window of normalizeWindows(windows)) {
    for (const site of locate(window.bytes, window.offset)) {
      byOffset.set(site.offset, site)
    }
  }
  const sites = [...byOffset.values()].sort((left, right) => left.offset - right.offset)
  if (sites.length === 1) return null
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