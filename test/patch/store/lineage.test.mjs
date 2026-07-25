import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'

import { closeFeatures } from '../../../lib/patch/core/dependencies.mjs'
import { claudeFeatureRegistry } from '../../../lib/patch/targets/claude/index.mjs'
import {
  assertExactReplayLineage,
  lineageSha256,
  platformLineageCapability,
} from '../../../lib/patch/store/lineage.mjs'

const clean = await readFile(new URL('../../../contract/golden/claude-v1/synthetic-2.1.175-clean.bin', import.meta.url))
const lineageCases = JSON.parse(await readFile(new URL('../../../contract/vectors/lineage-v1/fixtures/lineage-cases.json', import.meta.url), 'utf8'))
const lineageExpected = JSON.parse(await readFile(new URL('../../../contract/vectors/lineage-v1/fixtures/lineage-expected.json', import.meta.url), 'utf8'))
const platformMatrix = JSON.parse(await readFile(new URL('../../../contract/vectors/platform-writes-v1.json', import.meta.url), 'utf8'))

function applyTarget(requested) {
  let bytes = Buffer.from(clean)
  for (const name of closeFeatures(claudeFeatureRegistry, requested)) {
    bytes = claudeFeatureRegistry.get(name).apply(bytes).bytes
  }
  return bytes
}

function baselineManifest() {
  return {
    lineage_algorithm: lineageCases.algorithm,
    lineage_sha256: lineageSha256(clean, { platform: 'linux', matrix: platformMatrix }),
    size: clean.length,
  }
}

describe('claude-v1 exact replay lineage', () => {
  test('reads the frozen platform matrix without a writes shortcut', () => {
    expect(platformLineageCapability('linux', platformMatrix)).toMatchObject({
      format: 'elf',
      formatExactReplay: 'proven',
      sharedStoreTransaction: 'proven',
      productionWriteGate: 'enabled',
    })
    expect(platformLineageCapability('windows', platformMatrix)).toMatchObject({ format: 'pe', formatExactReplay: 'proven' })
    expect(platformLineageCapability('macos', platformMatrix)).toMatchObject({ format: 'macho', formatExactReplay: 'partial' })
    expect(() => platformLineageCapability('freebsd', platformMatrix)).toThrow(/unknown platform/)
    expect(() => platformLineageCapability('linux', { ...platformMatrix, writes: 'enabled' })).toThrow(/writes/)
    const polluted = structuredClone(platformMatrix)
    polluted.platforms.linux.capabilities.writes = 'enabled'
    expect(() => platformLineageCapability('linux', polluted)).toThrow(/writes/)
  })

  test('matches every frozen target set using new feature observe/replay methods', () => {
    for (const request of lineageCases.targets) {
      const current = applyTarget(request)
      const result = assertExactReplayLineage({
        baseline: clean,
        current,
        manifest: baselineManifest(),
        registry: claudeFeatureRegistry,
        platform: 'linux',
        matrix: platformMatrix,
      })
      expect(result.accepted).toBe(true)
      expect(result.byteEqual).toBe(true)
      expect(result.expectedSha256).toBe(result.currentSha256)
      expect(result.expected.equals(current)).toBe(true)
    }
    expect(lineageExpected.clean).toEqual({ accepted: true, byte_equal_after_replay: true })
  })

  test('accepts complete mixed substates only after full-byte reconstruction', () => {
    let current = applyTarget(['source-exec', 'channels'])
    const sourceFeature = claudeFeatureRegistry.get('source-exec')
    const sourceStates = sourceFeature.observe_substates(current)
    current = sourceFeature.replay_substates(current, sourceStates.map((site, index) => ({
      ...site,
      state: index === 0 ? 'clean' : site.state,
    }))).bytes
    const result = assertExactReplayLineage({
      baseline: clean, current, manifest: baselineManifest(), registry: claudeFeatureRegistry,
      platform: 'linux', matrix: platformMatrix,
    })
    expect(lineageCases.cases.mixed_replayable.complete).toBe(true)
    expect(result).toMatchObject({ accepted: true, byteEqual: true })
    expect(result.expected.equals(current)).toBe(true)
  })

  test('rejects incomplete substates and same-version different-build bytes', () => {
    const current = applyTarget(['agent-model'])
    const incompleteRegistry = {
      features: () => claudeFeatureRegistry.features().map((feature) => feature.name === 'agent-model'
        ? { ...feature, observe_substates: () => [{ id: 'unknown', offset: 0, length: 1, state: 'unknown-bytes' }] }
        : feature),
    }
    expect(() => assertExactReplayLineage({
      baseline: clean, current, manifest: baselineManifest(), registry: incompleteRegistry,
      platform: 'linux', matrix: platformMatrix,
    })).toThrow(expect.objectContaining({ code: lineageExpected.mixed_unreplayable.code, exitCode: 2 }))

    const drift = Buffer.from(current)
    drift[30] ^= 1
    expect(() => assertExactReplayLineage({
      baseline: clean, current: drift, manifest: baselineManifest(), registry: claudeFeatureRegistry,
      platform: 'linux', matrix: platformMatrix,
    })).toThrow(expect.objectContaining({ code: lineageExpected.same_path_version_different_build.code, exitCode: 2 }))
  })

  test('requires an explicit Mach-O normalizer and keeps the matrix gate disabled', () => {
    expect(() => lineageSha256(clean, { platform: 'macos', matrix: platformMatrix })).toThrow(/normalizer/)
    expect(lineageSha256(clean, {
      platform: 'macos', matrix: platformMatrix, normalizers: { macho: (bytes) => bytes.subarray(0, bytes.length - 1) },
    })).toMatch(/^[0-9a-f]{64}$/)
    expect(platformLineageCapability('macos', platformMatrix).productionWriteGate).toBe('disabled-not-proven')
  })
})