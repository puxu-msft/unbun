import { Feature } from '../../core/feature.mjs'
import {
  CLEAN,
  PATCHED,
  UNSUPPORTED,
  findAll,
  normalizeWindows,
  stateOf,
  substateError,
  validateReplay,
  writable,
} from './variants.mjs'

const ENUM_CORE = Buffer.from('enum(["sonnet","opus","haiku","fable"])', 'latin1')
const DESCRIBE_PREFIX = Buffer.from('.optional().describe(`Optional model override for this agent', 'latin1')
const MODEL_PREFIX = Buffer.from('model:', 'latin1')
const SCAN_TAIL_BYTES = 64 * 1024 * 1024
const UNKNOWN_LOOKBACK = 512

function patchedCore() {
  const base = 'string()'
  const fill = ENUM_CORE.length - base.length - 4
  const label = ' any model '
  if (fill < label.length) throw new Error('agent-model replacement cannot remain equal length')
  return Buffer.from(`${base}/*${label}${'.'.repeat(fill - label.length)}*/`, 'latin1')
}

const PATCHED_CORE = patchedCore()

function receiverAt(bytes, coreOffset) {
  if (coreOffset === 0 || bytes[coreOffset - 1] !== 0x2e) return null
  const modelOffset = bytes.lastIndexOf(MODEL_PREFIX, coreOffset - 1)
  if (modelOffset < Math.max(0, coreOffset - 128)) return null
  return bytes.subarray(modelOffset + MODEL_PREFIX.length, coreOffset - 1).toString('latin1')
}

function locate(bytes, baseOffset = 0) {
  const sites = []
  for (const suffixOffset of findAll(bytes, DESCRIBE_PREFIX)) {
    const localOffset = suffixOffset - ENUM_CORE.length
    if (localOffset < 0) continue
    const value = bytes.subarray(localOffset, suffixOffset)
    const state = value.equals(ENUM_CORE) ? CLEAN : value.equals(PATCHED_CORE) ? PATCHED : null
    if (!state) continue
    sites.push({
      offset: baseOffset + localOffset,
      localOffset,
      length: ENUM_CORE.length,
      receiver: receiverAt(bytes, localOffset),
      state,
      suffixOffset,
    })
  }
  return sites.sort((left, right) => left.offset - right.offset)
}

function locateUnknown(bytes, baseOffset = 0) {
  const sites = []
  const knownSuffixes = new Set(locate(bytes).map((site) => site.suffixOffset))
  for (const suffixOffset of findAll(bytes, DESCRIBE_PREFIX)) {
    if (knownSuffixes.has(suffixOffset)) continue
    const modelOffset = bytes.lastIndexOf(MODEL_PREFIX, suffixOffset)
    if (modelOffset < Math.max(0, suffixOffset - UNKNOWN_LOOKBACK)) continue
    const dotOffset = bytes.indexOf(0x2e, modelOffset + MODEL_PREFIX.length)
    if (dotOffset === -1 || dotOffset >= suffixOffset - 1) continue
    const localOffset = dotOffset + 1
    sites.push({
      offset: baseOffset + localOffset,
      localOffset,
      length: suffixOffset - localOffset,
      receiver: bytes.subarray(modelOffset + MODEL_PREFIX.length, dotOffset).toString('latin1'),
      state: UNSUPPORTED,
      suffixOffset,
    })
  }
  return sites
}

function hasUnknownVariant(bytes) {
  return locateUnknown(bytes).length > 0
}

function records(bytes) {
  const sites = [...locate(bytes), ...locateUnknown(bytes)].sort((left, right) => left.offset - right.offset)
  return sites.map((entry, index) => ({
    id: `agent-model:schema:${index}`,
    offset: entry.offset,
    length: entry.length,
    receiver: entry.receiver,
    state: entry.state,
  }))
}

function detect(bytes) {
  if (hasUnknownVariant(bytes)) return { state: UNSUPPORTED, sites: 0, code: 'agent_model_variant_unsupported' }
  const sites = locate(bytes)
  const result = { state: stateOf(sites.map((site) => site.state)), sites: sites.length }
  if (sites.length === 1 && sites[0].state === CLEAN) result.replacement_prefix = `model:${sites[0].receiver}.string()`
  return result
}

function probeWindows(readerOrSize) {
  const size = typeof readerOrSize === 'number' ? readerOrSize : readerOrSize?.size
  if (!Number.isSafeInteger(size) || size < 0) throw new TypeError('size must be a non-negative safe integer')
  return [[Math.max(0, size - SCAN_TAIL_BYTES), size]]
}

function detectWindows(windows) {
  const normalized = normalizeWindows(windows)
  if (normalized.some((window) => locateUnknown(window.bytes, window.offset).length > 0)) {
    return { state: UNSUPPORTED, sites: 0, code: 'agent_model_variant_unsupported' }
  }
  const sites = normalized.flatMap((window) => locate(window.bytes, window.offset))
  if (sites.length === 1) return null
  return { state: stateOf(sites.map((site) => site.state)), sites: sites.map((site) => site.offset) }
}

function transform(bytes, from, to, options) {
  if (hasUnknownVariant(bytes)) {
    const error = new Error('agent_model_variant_unsupported: unaudited model enum')
    error.code = 'agent_model_variant_unsupported'
    throw error
  }
  const output = writable(bytes, options)
  let edits = 0
  for (const site of locate(output)) {
    if (site.state !== from) continue
    ;(to === PATCHED ? PATCHED_CORE : ENUM_CORE).copy(output, site.localOffset)
    edits++
  }
  return { bytes: output, edits }
}

function replaySubstates(bytes, desired, options) {
  if (hasUnknownVariant(bytes)) throw substateError('agent-model baseline contains an unaudited variant')
  const output = writable(bytes, options)
  const current = records(output)
  validateReplay(current, desired)
  for (let index = 0; index < current.length; index++) {
    if (desired[index].receiver !== current[index].receiver) throw substateError(`receiver mismatch for ${current[index].id}`)
    ;(desired[index].state === PATCHED ? PATCHED_CORE : ENUM_CORE).copy(output, current[index].offset)
  }
  return { bytes: output, edits: current.filter((site, index) => site.state !== desired[index].state).length }
}

export const agentModelFeature = new Feature({
  name: 'agent-model',
  title: 'Agent model override',
  description: 'Replace every audited Agent model enum with an equal-length receiver-preserving string schema.',
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