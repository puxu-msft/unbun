import { createHash } from 'node:crypto'

import { StoreError } from './manifests.mjs'

const PLATFORM_ALIASES = Object.freeze({
  linux: 'linux',
  win32: 'windows',
  windows: 'windows',
  darwin: 'macos',
  macos: 'macos',
})

function assertNoWritesShortcut(value, location) {
  if (value && typeof value === 'object' && Object.hasOwn(value, 'writes')) {
    throw new Error(`platform matrix ${location} must not contain aggregate writes`)
  }
}

export function platformLineageCapability(platform, matrix) {
  const name = PLATFORM_ALIASES[platform]
  if (!name || !matrix?.platforms?.[name]) throw new Error(`unknown platform: ${platform}`)
  assertNoWritesShortcut(matrix, 'root')
  const record = matrix.platforms[name]
  assertNoWritesShortcut(record, name)
  assertNoWritesShortcut(record.capabilities, `${name}.capabilities`)
  if (matrix.lineage_algorithm !== 'claude-v1-exact-replay') throw new Error('unsupported lineage algorithm in platform matrix')
  return Object.freeze({
    platform: name,
    format: record.format,
    formatExactReplay: record.capabilities.format_exact_replay?.status,
    sharedStoreTransaction: record.capabilities.shared_store_transaction?.status,
    productionWriteGate: record.capabilities.production_write_gate?.status,
  })
}

// production 写 fail-closed gate（L1B-01）。每个 mutating 入口在取 lock / 建 baseline / 写盘之前调用。
// 只有 production_write_gate.status === 'enabled' 的平台放行；否则拒绝、目标二进制不被触碰。
//   - 平台在 matrix 中但 gate 未 enabled → platform_write_disabled(exit 1)（Windows/macOS 现状）。
//   - 平台完全不在 matrix → platform_write_unsupported(exit 1)（与 Python lineage 层同码同层）。
// gate 数据驱动于传入 matrix：生产用冻结的 platform-writes-v1.json；测试可注入 enabled matrix 演练平台写内部。
export function assertPlatformWriteEnabled(platform, matrix) {
  let capability
  try {
    capability = platformLineageCapability(platform, matrix)
  } catch (error) {
    // platformLineageCapability 对未知平台抛通用 Error；归一为 fail-closed 的平台策略码。
    throw new StoreError('platform_write_unsupported', `platform ${platform} is not a supported write target`, 1, {
      platform,
      cause: error.message,
    })
  }
  if (capability.productionWriteGate !== 'enabled') {
    throw new StoreError('platform_write_disabled', `production write gate is not enabled for ${capability.platform}`, 1, {
      platform: capability.platform,
      productionWriteGate: capability.productionWriteGate ?? null,
    })
  }
  return capability
}

function normalizedBytes(bytes, { platform = process.platform, matrix, normalizers = {} }) {
  if (!Buffer.isBuffer(bytes)) throw new TypeError('lineage input must be a Buffer')
  const capability = platformLineageCapability(platform, matrix)
  if (capability.format === 'elf' || capability.format === 'pe') return bytes
  if (capability.format === 'macho') {
    if (typeof normalizers.macho !== 'function') throw new Error('Mach-O lineage requires an explicit proven normalizer')
    const normalized = normalizers.macho(bytes)
    if (!Buffer.isBuffer(normalized)) throw new TypeError('Mach-O normalizer must return a Buffer')
    return normalized
  }
  throw new Error(`unsupported lineage format: ${capability.format}`)
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

export function lineageSha256(bytes, options) {
  return digest(normalizedBytes(bytes, options))
}

function stale(message, details = {}) {
  return new StoreError('baseline_stale_build', message, 2, details)
}

function registryFeatures(registry) {
  if (!registry || typeof registry.features !== 'function') throw new TypeError('feature registry is required')
  const features = registry.features()
  if (!Array.isArray(features) || features.length === 0) throw new TypeError('feature registry must contain features')
  return features
}

export function assertExactReplayLineage({
  baseline,
  current,
  manifest,
  registry,
  platform = process.platform,
  matrix,
  normalizers = {},
}) {
  if (manifest?.lineage_algorithm !== 'claude-v1-exact-replay') throw stale('unsupported baseline lineage algorithm')
  const normalization = { platform, matrix, normalizers }
  let normalizedBaseline
  let normalizedCurrent
  try {
    normalizedBaseline = normalizedBytes(baseline, normalization)
    normalizedCurrent = normalizedBytes(current, normalization)
  } catch (error) {
    if (error instanceof StoreError) throw error
    throw stale('platform normalization failed', { cause: error.message })
  }
  const baselineHash = digest(normalizedBaseline)
  if (baselineHash !== manifest.lineage_sha256) throw stale('baseline lineage hash does not match manifest')
  if (baseline.length !== manifest.size) throw stale('baseline size does not match manifest')

  let expected = Buffer.from(baseline)
  const observed = {}
  try {
    for (const feature of registryFeatures(registry)) {
      if (typeof feature.observe_substates !== 'function' || typeof feature.replay_substates !== 'function') {
        throw new Error(`feature ${feature.name} lacks exact replay methods`)
      }
      const substates = feature.observe_substates(current)
      if (!Array.isArray(substates)) throw new Error(`feature ${feature.name} returned incomplete substates`)
      observed[feature.name] = structuredClone(substates)
    }
    for (const feature of registryFeatures(registry)) {
      expected = feature.replay_substates(expected, observed[feature.name]).bytes
      if (!Buffer.isBuffer(expected)) throw new Error(`feature ${feature.name} replay did not return bytes`)
    }
  } catch (error) {
    throw stale('feature substates cannot be exactly replayed', { cause: error.message, featureCode: error.code ?? null })
  }

  let normalizedExpected
  try {
    normalizedExpected = normalizedBytes(expected, normalization)
  } catch (error) {
    throw stale('expected bytes could not be normalized', { cause: error.message })
  }
  const byteEqual = normalizedExpected.length === normalizedCurrent.length && normalizedExpected.equals(normalizedCurrent)
  const expectedSha256 = digest(normalizedExpected)
  const currentSha256 = digest(normalizedCurrent)
  if (!byteEqual) {
    throw stale('full normalized byte comparison failed', {
      expectedSha256,
      currentSha256,
    })
  }
  if (expectedSha256 !== currentSha256) throw stale('normalized replay hashes differ after byte equality')
  return {
    accepted: true,
    byteEqual: true,
    baselineLineageSha256: baselineHash,
    expectedSha256,
    currentSha256,
    normalizedSize: normalizedCurrent.length,
    observedSubstates: observed,
    expected,
  }
}