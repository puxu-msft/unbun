import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { claudeFeatureRegistry } from '../../lib/patch/targets/claude/index.mjs'
import { inspectClaudeBytes, probeClaudeBinary } from '../../lib/patch/targets/claude/probe.mjs'

const ROOT = path.resolve(import.meta.dir, '../..')
const VECTOR_ROOT = path.join(ROOT, 'contract', 'vectors', 'feature-claude-v1', 'fixtures')
const GOLDEN_ROOT = path.join(ROOT, 'contract', 'golden', 'claude-v1')
const sourceInput = JSON.parse(readFileSync(path.join(VECTOR_ROOT, 'source-exec-input.json'), 'utf8'))
const agentInput = JSON.parse(readFileSync(path.join(VECTOR_ROOT, 'agent-model-input.json'), 'utf8'))
const channelsInput = JSON.parse(readFileSync(path.join(VECTOR_ROOT, 'channels-input.json'), 'utf8'))

function support({ feature = 'clean', permissions = 'clean', capStrip = 'clean' } = {}) {
  return [
    feature === 'absent' ? '' : channelsInput.support[`essential_${feature}`],
    permissions === 'absent' ? '' : channelsInput.support[`permissions_${permissions}`],
    capStrip === 'absent' ? '' : channelsInput.support[`cap_strip_${capStrip}`],
  ].filter(Boolean).join(';')
}

function channelsCase(decision, options) {
  return Buffer.from(`${decision};${support(options)}`, 'latin1')
}

function corpus() {
  const cases = []
  for (const [name, segments] of Object.entries(sourceInput.cases.find((entry) => entry.id === 'states').inputs)) {
    cases.push([`source-exec/${name}`, Buffer.from(segments.join('|'), 'latin1')])
  }
  for (const variant of agentInput.audited_variants) cases.push([`agent-model/${variant.id}`, Buffer.from(variant.ascii, 'latin1')])
  cases.push(['agent-model/unknown', Buffer.from(agentInput.unknown_variant, 'latin1')])
  cases.push(['agent-model/multiple', Buffer.from(agentInput.multiple_suffixes, 'latin1')])
  cases.push(['agent-model/known-and-unknown', Buffer.from(`${agentInput.multiple_suffixes};${agentInput.unknown_variant}`, 'latin1')])
  cases.push(['channels/tail-decoy', channelsCase(channelsInput.tail_register_decoy.replace('REAL_DECISION', channelsInput.decision_clean))])
  cases.push(['channels/multiple-decoys', channelsCase(channelsInput.multiple_decoys.replace('REAL_DECISION', channelsInput.decision_clean))])
  cases.push(['channels/clean', channelsCase(channelsInput.decision_clean)])
  cases.push(['channels/patched', channelsCase(channelsInput.decision_patched, { feature: 'patched', permissions: 'patched', capStrip: 'patched' })])
  cases.push(['channels/essential-missing', channelsCase(channelsInput.decision_clean, { feature: 'absent' })])
  cases.push(['channels/permissions-absent', channelsCase(channelsInput.decision_clean, { permissions: 'absent' })])
  cases.push(['channels/cap-strip-absent', channelsCase(channelsInput.decision_clean, { capStrip: 'absent' })])
  cases.push(['channels/mixed', channelsCase(channelsInput.decision_patched, { feature: 'clean', permissions: 'patched', capStrip: 'clean' })])
  cases.push(['golden/clean', readFileSync(path.join(GOLDEN_ROOT, 'synthetic-2.1.175-clean.bin'))])
  cases.push(['golden/patched', readFileSync(path.join(GOLDEN_ROOT, 'synthetic-2.1.175-all-patched.bin'))])
  return cases
}

function fullStatus(feature, bytes) {
  const detected = feature.detect(bytes)
  return {
    state: detected.state,
    sites: detected.sites,
    detail_codes: detected.code ? [detected.code] : [],
    substates: feature.observe_substates(bytes),
  }
}

function spyReader(bytes) {
  const reads = []
  let closes = 0
  return {
    size: bytes.length,
    reads,
    get closes() { return closes },
    slice(offset, length) {
      reads.push([offset, offset + length])
      return bytes.subarray(offset, offset + length)
    },
    close() { closes++ },
  }
}

function virtualBytes(testCase, start = 0, end = testCase.size) {
  const bytes = Buffer.alloc(end - start)
  for (const segment of testCase.segments) {
    const value = Buffer.from(segment.ascii, 'latin1')
    const overlapStart = Math.max(start, segment.offset)
    const overlapEnd = Math.min(end, segment.offset + value.length)
    if (overlapStart < overlapEnd) value.copy(bytes, overlapStart - start, overlapStart - segment.offset, overlapEnd - segment.offset)
  }
  return bytes
}

function sparseReader(testCase) {
  const reads = []
  let closes = 0
  return {
    size: testCase.size,
    reads,
    get closes() { return closes },
    slice(offset, length) {
      reads.push([offset, offset + length])
      return virtualBytes(testCase, offset, offset + length)
    },
    close() { closes++ },
  }
}

function fixedClock(values) {
  let index = 0
  return () => values[index++]
}

describe('Claude windowed probe', () => {
  test('inspects already-read transaction bytes without reopening the target', () => {
    const bytes = readFileSync(path.join(GOLDEN_ROOT, 'synthetic-2.1.175-clean.bin'))
    expect(inspectClaudeBytes(bytes)).toMatchObject({
      embeddedVersion: '2.1.175',
      states: { 'source-exec': 'clean', 'agent-model': 'clean', channels: 'clean' },
      features: {
        'source-exec': { state: 'clean' },
        'agent-model': { state: 'clean' },
        channels: { state: 'clean' },
      },
    })
  })

  test('matches full state, sites, detail codes, and substates across the frozen contract corpus', () => {
    for (const [name, bytes] of corpus()) {
      const reader = spyReader(bytes)
      const result = probeClaudeBinary(`/virtual/${name}`, {
        openReader: () => reader,
        now: fixedClock([0, 1, 2, 3, 4, 5]),
      })
      expect(result.features, name).toEqual(Object.fromEntries(
        claudeFeatureRegistry.features().map((feature) => [feature.name, fullStatus(feature, bytes)]),
      ))
      expect(reader.closes, name).toBe(1)
      if (name.startsWith('golden/')) expect(result.version, name).toBe('2.1.175')
    }
  })

  test('matches full detection for every sparse source-exec boundary vector', () => {
    const cases = sourceInput.cases.filter((entry) => entry.segments)
    for (const testCase of cases) {
      const reader = sparseReader(testCase)
      const result = probeClaudeBinary(`/virtual/${testCase.id}`, {
        openReader: () => reader,
        now: fixedClock([0, 1, 2, 3, 4, 5]),
      })
      const full = virtualBytes(testCase)
      expect(result.features['source-exec'], testCase.id).toEqual(fullStatus(claudeFeatureRegistry.get('source-exec'), full))
      expect(reader.closes, testCase.id).toBe(1)
    }
  })

  test('opens once, merges overlapping ranges globally, and exposes deterministic profile timing', () => {
    const bytes = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz', 'latin1')
    const reader = spyReader(bytes)
    let opens = 0
    const features = [
      windowFeature('left', [[0, 12], [20, 24]]),
      windowFeature('right', [[8, 20], [23, 30]]),
    ]

    const result = probeClaudeBinary('/virtual/claude', {
      features,
      openReader: () => { opens++; return reader },
      now: fixedClock([100, 102, 105, 109, 114]),
    })

    expect(opens).toBe(1)
    expect(reader.closes).toBe(1)
    expect(reader.reads).toEqual([[0, 30]])
    expect(result).toMatchObject({
      version: null,
      size: bytes.length,
      timing: {
        version_ms: 2,
        features_ms: 12,
        total_ms: 14,
        by_feature_ms: { left: 3, right: 4 },
      },
    })
  })

  test('uses large ranges only for discovery and gives detect_windows bounded candidate slices', () => {
    const testCase = {
      size: 250_000_000,
      segments: [
        { offset: 1000, ascii: '// @bun @bytecode' },
        { offset: 249_999_000, ascii: '// @bun @bytecode' },
      ],
    }
    const reader = sparseReader(testCase)
    const source = claudeFeatureRegistry.get('source-exec')
    const detectedLengths = []
    const feature = {
      ...source,
      detect_windows(windows) {
        detectedLengths.push(...windows.map((window) => window.bytes.length))
        return source.detect_windows(windows)
      },
    }

    const result = probeClaudeBinary('/virtual/large-claude', {
      features: [feature],
      openReader: () => reader,
      now: fixedClock([0, 1, 2, 3]),
    })

    expect(reader.reads).toEqual([[0, 32_000_000], [218_000_000, 250_000_000]])
    expect(detectedLengths).toHaveLength(2)
    expect(Math.max(...detectedLengths)).toBeLessThanOrEqual(16_018)
    expect(result.features['source-exec'].sites).toBe(2)
  })

  test('falls back before slicing a source candidate that crosses a discovery boundary', () => {
    const testCase = {
      size: 100_000_000,
      segments: [{ offset: 31_999_990, ascii: '// @bun @bytecode' }],
    }
    const reader = sparseReader(testCase)

    const result = probeClaudeBinary('/virtual/boundary-claude', {
      features: [claudeFeatureRegistry.get('source-exec')],
      openReader: () => reader,
      now: fixedClock([0, 1, 2, 3]),
    })

    expect(reader.reads).toEqual([[0, 32_000_000], [68_000_000, 100_000_000], [0, 100_000_000]])
    expect(result.features['source-exec'].sites).toBe(1)
  })

  test('falls back when a non-source candidate extends beyond its discovery cache', () => {
    const variant = agentInput.audited_variants[0].ascii
    const tailStart = 100_000_000 - 64 * 1024 * 1024
    const testCase = {
      size: 100_000_000,
      segments: [{ offset: tailStart + 10, ascii: variant }],
    }
    const reader = sparseReader(testCase)

    const result = probeClaudeBinary('/virtual/agent-boundary-claude', {
      features: [claudeFeatureRegistry.get('agent-model')],
      openReader: () => reader,
      now: fixedClock([0, 1, 2, 3]),
    })

    expect(reader.reads).toEqual([[tailStart, 100_000_000], [0, 100_000_000]])
    expect(result.features['agent-model'].state).toBe('clean')
    expect(result.features['agent-model'].sites).toBe(1)
  })

  test('aggregates distant channels candidate windows without decoding their gap', () => {
    const compact = channelsCase(channelsInput.decision_clean)
    const separators = [
      Buffer.from('tengu_harbor",!', 'latin1'),
      Buffer.from('tengu_harbor_permissions",!', 'latin1'),
      Buffer.from('["claude/channel"]&&(', 'latin1'),
    ]
    const parts = []
    let start = 0
    for (const separator of separators) {
      const offset = compact.indexOf(separator, start)
      parts.push(compact.subarray(start, offset), Buffer.alloc(7_000_000, 0x78))
      start = offset
    }
    parts.push(compact.subarray(start))
    const bytes = Buffer.concat(parts)
    const reader = spyReader(bytes)
    const channels = claudeFeatureRegistry.get('channels')
    const detectedLengths = []
    const feature = {
      ...channels,
      detect_windows(windows) {
        detectedLengths.push(...windows.map((window) => window.bytes.length))
        return channels.detect_windows(windows)
      },
    }

    const result = probeClaudeBinary('/virtual/distant-channels', {
      features: [feature],
      openReader: () => reader,
      now: fixedClock([0, 1, 2, 3]),
    })

    expect(result.features.channels).toEqual(fullStatus(channels, bytes))
    expect(detectedLengths.length).toBeGreaterThan(1)
    expect(detectedLengths.reduce((sum, length) => sum + length, 0)).toBeLessThanOrEqual(80_000)
  })

  test('falls back when candidates are incomplete and shares one full read across features', () => {
    const bytes = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz', 'latin1')
    const reader = spyReader(bytes)
    const features = [
      windowFeature('partial-a', [[2, 8]], { incomplete: true }),
      windowFeature('partial-b', [[6, 12]], { incomplete: true }),
    ]

    const result = probeClaudeBinary('/virtual/claude', {
      features,
      openReader: () => reader,
      now: fixedClock([0, 1, 2, 3, 4]),
    })

    expect(reader.reads).toEqual([[2, 12], [0, bytes.length]])
    expect(result.features['partial-a'].sites).toBe(bytes.length)
    expect(result.features['partial-b'].sites).toBe(bytes.length)
    expect(reader.closes).toBe(1)
  })

  test('closes the sole reader when probing throws', () => {
    const reader = spyReader(Buffer.from('fixture'))
    const broken = windowFeature('broken', [[0, 2]])
    broken.detect_windows = () => { throw new Error('probe failed') }
    expect(() => probeClaudeBinary('/virtual/claude', {
      features: [broken],
      openReader: () => reader,
      now: fixedClock([0, 1, 2]),
    })).toThrow('probe failed')
    expect(reader.closes).toBe(1)
  })
})

function windowFeature(name, windows, { incomplete = false } = {}) {
  return {
    name,
    probe_windows: () => windows,
    detect_windows: (slices) => incomplete ? null : { state: 'clean', sites: slices.reduce((sum, slice) => sum + slice.bytes.length, 0) },
    detect: (bytes) => ({ state: 'clean', sites: bytes.length }),
    observe_substates: () => [],
  }
}