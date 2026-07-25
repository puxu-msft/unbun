import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const CHANNEL_DECISION_CLEAN = 'if(n6()!=="firstParty")return{action:"skip",kind:"provider",reason:"channels are not available on third-party providers"};if(!oYH())return{action:"skip",kind:"disabled",reason:"channels feature is not currently available"};let _=TGH(H);if(!_)return{action:"skip",kind:"session",reason:`not in list`};else if(!_.dev)return{action:"skip",kind:"allowlist",reason:`server ${_.name} is not on the approved channels allowlist`};return{action:"register"}'

function site(id, offset, clean, patched) {
  return { id, offset, clean: Buffer.from(clean, 'latin1'), patched: Buffer.from(patched, 'latin1') }
}

export const SYNTHETIC_SITES = {
  'source-exec': [
    site('source-marker', 9, 'bytecode', 'source__'),
  ],
  'agent-model': [
    site('model-core', 307, 'enum(["sonnet","opus","haiku","fable"])', 'string()/* any model ................*/'),
  ],
  channels: [
    site('decision', 583, CHANNEL_DECISION_CLEAN, 'return{action:"register"}'.padEnd(CHANNEL_DECISION_CLEAN.length)),
    site('feature_flag', 68, '1', '0'),
    site('permissions', 124, '1', '0'),
    site('cap_strip', 228, '||', '&&'),
  ],
}

const FEATURE_ORDER = ['source-exec', 'agent-model', 'channels']
const SITE_IDS = {
  'source-exec': ['source-marker'],
  'agent-model': ['model-core'],
  channels: ['decision', 'feature_flag', 'permissions', 'cap_strip'],
}

export class ReplayError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ReplayError'
    this.code = 'substate_unreplayable'
  }
}

export class UnsupportedFormatError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UnsupportedFormatError'
    this.code = 'unsupported_format'
  }
}

function parseArgs(args) {
  const values = {}
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]
    const value = args[index + 1]
    if (!flag?.startsWith('--') || value === undefined) throw new Error('expected --manifest, --case, and --current')
    values[flag.slice(2)] = value
  }
  if (!values.manifest || !values.case || !values.current) throw new Error('expected --manifest, --case, and --current')
  return values
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function assertState(state, label) {
  if (state !== 'clean' && state !== 'patched') throw new ReplayError(`unknown state for ${label}: ${JSON.stringify(state)}`)
}

function validateSites(bytes, sites) {
  for (const feature of FEATURE_ORDER) {
    const featureSites = sites[feature]
    if (!Array.isArray(featureSites)) throw new ReplayError(`missing site collection for ${feature}`)
    const byId = new Map(featureSites.map((entry) => [entry.id, entry]))
    for (const id of SITE_IDS[feature]) {
      const entry = byId.get(id)
      if (!entry) throw new ReplayError(`missing site ${feature}.${id}`)
      if (!Number.isInteger(entry.offset) || entry.offset < 0 || entry.offset + entry.clean.length > bytes.length) {
        throw new ReplayError(`site out of bounds: ${feature}.${id}`)
      }
      if (entry.clean.length !== entry.patched.length) throw new ReplayError(`site length mismatch: ${feature}.${id}`)
      if (!bytes.subarray(entry.offset, entry.offset + entry.clean.length).equals(entry.clean)) {
        throw new ReplayError(`clean baseline site mismatch: ${feature}.${id}`)
      }
    }
  }
}

function desiredSiteStates(feature, state) {
  if (feature !== 'channels' || typeof state === 'string') {
    assertState(state, feature)
    return Object.fromEntries(SITE_IDS[feature].map((id) => [id, state]))
  }
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new ReplayError(`unknown state for channels: ${JSON.stringify(state)}`)
  const desired = {}
  for (const id of SITE_IDS.channels) {
    assertState(state[id], `channels.${id}`)
    desired[id] = state[id]
  }
  const unknownSite = Object.keys(state).find((id) => !SITE_IDS.channels.includes(id))
  if (unknownSite) throw new ReplayError(`unknown site: channels.${unknownSite}`)
  return desired
}

export function replaySynthetic(cleanBytes, substates, sites = SYNTHETIC_SITES) {
  if (!substates || typeof substates !== 'object' || Array.isArray(substates)) throw new ReplayError('substate vector is missing')
  const unknownFeature = Object.keys(substates).find((feature) => !FEATURE_ORDER.includes(feature))
  if (unknownFeature) throw new ReplayError(`unknown feature: ${unknownFeature}`)
  const expected = Buffer.from(cleanBytes)
  validateSites(expected, sites)
  for (const feature of FEATURE_ORDER) {
    const desired = desiredSiteStates(feature, substates[feature])
    const byId = new Map(sites[feature].map((entry) => [entry.id, entry]))
    for (const id of SITE_IDS[feature]) {
      const entry = byId.get(id)
      const replacement = entry[desired[id]]
      replacement.copy(expected, entry.offset)
    }
  }
  return expected
}

export function compareNormalized(expected, current) {
  return expected.length === current.length && expected.equals(current)
}

function peError(detail) {
  throw new UnsupportedFormatError(`unsupported PE: ${detail}`)
}

export function normalizePe(bytes) {
  if (bytes.length < 0x40) peError('truncated DOS header')
  if (bytes[0] !== 0x4d || bytes[1] !== 0x5a) peError('invalid DOS magic')
  const peOffset = bytes.readUInt32LE(0x3c)
  if (peOffset < 0x40 || peOffset > bytes.length - 24) peError('PE header offset is out of bounds')
  if (!bytes.subarray(peOffset, peOffset + 4).equals(Buffer.from([0x50, 0x45, 0, 0]))) peError('invalid PE magic')

  const coffOffset = peOffset + 4
  const machine = bytes.readUInt16LE(coffOffset)
  const sectionCount = bytes.readUInt16LE(coffOffset + 2)
  const optionalSize = bytes.readUInt16LE(coffOffset + 16)
  if (machine !== 0x8664) peError('COFF machine is not x86_64')
  if (sectionCount === 0) peError('COFF section count is zero')
  if (optionalSize !== 0xf0) peError('contradictory PE32+ optional-header size')

  const optionalOffset = coffOffset + 20
  const optionalEnd = optionalOffset + optionalSize
  if (optionalEnd > bytes.length) peError('truncated optional header')
  if (bytes.readUInt16LE(optionalOffset) !== 0x20b) peError('contradictory PE32+ optional-header magic')
  const fileAlignment = bytes.readUInt32LE(optionalOffset + 36)
  const sizeOfHeaders = bytes.readUInt32LE(optionalOffset + 60)
  if (fileAlignment < 0x200 || (fileAlignment & (fileAlignment - 1)) !== 0) peError('invalid file alignment')

  const sectionTableEnd = optionalEnd + sectionCount * 40
  if (sectionTableEnd > bytes.length || sizeOfHeaders < sectionTableEnd || sizeOfHeaders > bytes.length) peError('section table exceeds headers')
  for (let index = 0; index < sectionCount; index += 1) {
    const sectionOffset = optionalEnd + index * 40
    const rawSize = bytes.readUInt32LE(sectionOffset + 16)
    const rawOffset = bytes.readUInt32LE(sectionOffset + 20)
    if (rawSize === 0) continue
    if (rawOffset < sizeOfHeaders || rawOffset % fileAlignment !== 0 || rawSize % fileAlignment !== 0 || rawOffset + rawSize > bytes.length) {
      peError(`section ${index} raw data is inconsistent`)
    }
  }
  return bytes
}

function shiftedSites(sites, offset) {
  return Object.fromEntries(Object.entries(sites).map(([feature, entries]) => [
    feature,
    entries.map((entry) => ({ ...entry, offset: entry.offset + offset })),
  ]))
}

function formatOperations(manifest, sites, replay) {
  if (manifest.format === 'synthetic-elf-like') {
    return { normalize: (bytes) => bytes, sites, replay }
  }
  if (manifest.format === 'pe') {
    if (!Number.isInteger(manifest.payload_offset) || manifest.payload_offset < 0) {
      return { normalize: () => peError('manifest payload offset is invalid'), sites, replay }
    }
    return { normalize: normalizePe, sites: shiftedSites(sites, manifest.payload_offset), replay }
  }
  return null
}

function baseResult(manifest, current, digest = sha256) {
  return {
    implementation: 'js',
    format: manifest.format,
    normalized_size: current.length,
    baseline_lineage_sha256: manifest.baseline.sha256,
    current_sha256: digest(current),
  }
}

export function evaluateCase(manifest, caseName, current, manifestPath, sites = SYNTHETIC_SITES, { replay = replaySynthetic, digest = sha256 } = {}) {
  const result = baseResult(manifest, current, digest)
  const operations = formatOperations(manifest, sites, replay)
  if (!operations) {
    return [{ ...result, supported: false, expected_sha256: null, byte_equal: false, error: 'unsupported_format' }, 3, `unsupported format: ${manifest.format}`]
  }
  const scenario = manifest.cases?.[caseName]
  if (!scenario) return [{ ...result, supported: false, expected_sha256: null, byte_equal: false, error: 'substate_unreplayable' }, 3, `unknown fixture case: ${caseName}`]

  try {
    const normalizedCurrent = operations.normalize(current)
    const baselinePath = path.resolve(path.dirname(manifestPath), manifest.baseline.path)
    const baseline = readFileSync(baselinePath)
    if (baseline.length !== manifest.normalized_size || sha256(baseline) !== manifest.baseline.sha256) {
      throw new Error('frozen baseline does not match manifest size and sha256')
    }
    operations.normalize(baseline)
    const expected = operations.replay(baseline, scenario.substates, operations.sites)
    const normalizedExpected = operations.normalize(expected)
    const expectedSha256 = digest(normalizedExpected)
    const byteEqual = normalizedCurrent.length === manifest.normalized_size
      && normalizedExpected.length === manifest.normalized_size
      && compareNormalized(normalizedExpected, normalizedCurrent)
    if (!byteEqual) {
      return [{ ...result, supported: true, expected_sha256: expectedSha256, byte_equal: false, error: 'baseline_stale_build' }, 4, 'full byte comparison failed']
    }
    return [{ ...result, supported: true, expected_sha256: expectedSha256, byte_equal: true, error: null }, 0, '']
  } catch (error) {
    if (error instanceof UnsupportedFormatError) {
      return [{ ...result, supported: false, expected_sha256: null, byte_equal: false, error: error.code }, 3, error.message]
    }
    if (!(error instanceof ReplayError)) throw error
    return [{ ...result, supported: false, expected_sha256: null, byte_equal: false, error: error.code }, 3, error.message]
  }
}

function materializeExpected(manifest, caseName, manifestPath) {
  const operations = formatOperations(manifest, SYNTHETIC_SITES, replaySynthetic)
  if (!operations) throw new UnsupportedFormatError(`unsupported format: ${manifest.format}`)
  const baselinePath = path.resolve(path.dirname(manifestPath), manifest.baseline.path)
  const baseline = readFileSync(baselinePath)
  operations.normalize(baseline)
  return operations.normalize(operations.replay(baseline, manifest.cases[caseName].substates, operations.sites))
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const manifest = JSON.parse(readFileSync(args.manifest, 'utf8'))
  const current = readFileSync(args.current)
  const [result, exitCode, diagnostic] = evaluateCase(manifest, args.case, current, args.manifest)
  if (args['write-expected'] && exitCode === 0) {
    const expected = materializeExpected(manifest, args.case, args.manifest)
    if (sha256(expected) !== result.expected_sha256) throw new Error('materialized expected bytes do not match result hash')
    writeFileSync(args['write-expected'], expected)
  }
  process.stdout.write(`${JSON.stringify(result)}\n`)
  if (diagnostic) process.stderr.write(`${diagnostic}\n`)
  process.exitCode = exitCode
}

if (import.meta.main) main()
