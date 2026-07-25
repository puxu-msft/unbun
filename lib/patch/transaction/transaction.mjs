import { readFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'

import { closeFeatures } from '../core/dependencies.mjs'
import { loadBaseline, publishBaseline } from '../store/assets.mjs'
import { assertExactReplayLineage, assertPlatformWriteEnabled, lineageSha256 } from '../store/lineage.mjs'
import { acquireTargetLock, releaseTargetLock } from '../store/lock.mjs'
import { StoreError, sha256 } from '../store/manifests.mjs'
import { inspectClaudeBytes } from '../targets/claude/probe.mjs'
import { createAtomicWriteAdapter } from './atomic-write.mjs'
import { createMacOSCodesigner } from './codesign.mjs'

const DEFAULT_PLATFORM_MATRIX = JSON.parse(readFileSync(new URL('../../../contract/vectors/platform-writes-v1.json', import.meta.url), 'utf8'))
const DEFAULT_LOCK = Object.freeze({ acquire: acquireTargetLock, release: releaseTargetLock })

function transactionError(code, message, exitCode = 2, details = {}) {
  return new StoreError(code, message, exitCode, details)
}

function observedStates(registry, bytes) {
  return Object.fromEntries(registry.features().map((feature) => [feature.name, feature.detect(bytes).state]))
}

function assertResult({ bytes, baseline, registry, requestedFeatures, inspect, allowSignatureDrift = false }) {
  if (!Buffer.isBuffer(bytes) || !allowSignatureDrift && bytes.length !== baseline.bytes.length) {
    throw transactionError('content_mismatch', 'transaction result is not an equal-length Buffer')
  }
  const inspected = inspect(bytes)
  if (inspected?.embeddedVersion !== baseline.embeddedVersion) {
    throw transactionError('content_mismatch', 'transaction result changed the embedded version')
  }
  const expected = new Set(requestedFeatures)
  for (const [name, state] of Object.entries(observedStates(registry, bytes))) {
    const wanted = expected.has(name) ? 'patched' : 'clean'
    if (state !== wanted) {
      throw transactionError('content_mismatch', `feature ${name} did not reach ${wanted}`, 2, { feature: name, state, wanted })
    }
  }
}

function replayTarget(registry, baselineBytes, requestedFeatures) {
  let bytes = Buffer.from(baselineBytes)
  let edits = 0
  for (const name of requestedFeatures) {
    let applied
    try {
      applied = registry.get(name).apply(bytes)
    } catch (error) {
      throw transactionError('content_mismatch', `feature ${name} could not be replayed from the clean baseline`, 2, {
        feature: name,
        featureCode: error.code ?? null,
        cause: error.message,
      })
    }
    if (!Buffer.isBuffer(applied?.bytes)) throw transactionError('content_mismatch', `feature ${name} returned invalid bytes`)
    bytes = applied.bytes
    edits += applied.edits ?? 0
  }
  return { bytes, edits }
}

function baselineValidation({ registry, platform, matrix, normalizers, inspect }) {
  return {
    inspect: async (bytes, manifest) => inspect(bytes, manifest),
    computeLineageSha256: async (bytes) => lineageSha256(bytes, { platform, matrix, normalizers }),
  }
}

function assertReplay({ baseline, current, registry, platform, matrix, normalizers }) {
  return assertExactReplayLineage({
    baseline: baseline.bytes,
    current,
    manifest: baseline.manifest,
    registry,
    platform,
    matrix,
    normalizers,
  })
}

function cleanCandidate(current, states, registry) {
  if (states.channels === 'patched') {
    throw transactionError('channels_patched_no_baseline', 'cannot establish a clean baseline from patched channels', 1)
  }
  if (Object.values(states).some((state) => state === 'mixed' || state === 'unsupported')) {
    throw transactionError('unsupported_or_mixed_no_baseline', 'cannot establish a baseline from mixed or unsupported feature state', 1)
  }
  let candidate = Buffer.from(current)
  const originallyPatched = registry.topologicalNames().filter((name) => states[name] === 'patched')
  for (const name of [...originallyPatched].reverse()) {
    const feature = registry.get(name)
    if (!feature.reversible) throw transactionError('unsupported_or_mixed_no_baseline', `feature ${name} cannot be reversed`, 1)
    candidate = feature.reverse(candidate).bytes
  }
  const candidateStates = observedStates(registry, candidate)
  if (Object.values(candidateStates).some((state) => state !== 'clean')) {
    throw transactionError('unsupported_or_mixed_no_baseline', 'reversed baseline candidate is not fully clean', 1)
  }
  const replayed = replayTarget(registry, candidate, originallyPatched).bytes
  if (!replayed.equals(current)) {
    throw transactionError('baseline_stale_build', 'reversible baseline candidate does not replay to entry bytes')
  }
  return candidate
}

export async function resolveTransactionBaseline({
  targetDirectory,
  current,
  registry,
  inspect = inspectClaudeBytes,
  pathKey,
  platform = process.platform,
  matrix = DEFAULT_PLATFORM_MATRIX,
  normalizers = {},
  now = () => new Date(),
  implementation = 'js',
}) {
  const inspection = inspect(current)
  const embeddedVersion = inspection?.embeddedVersion
  if (!embeddedVersion) throw transactionError('version_probe_failed', 'binary embedded version is unavailable', 1)
  const validation = baselineValidation({ registry, platform, matrix, normalizers, inspect })
  const existing = await loadBaseline(targetDirectory, embeddedVersion, { pathKey, ...validation })
  if (existing) {
    assertReplay({ baseline: existing, current, registry, platform, matrix, normalizers })
    return { ...existing, created: false }
  }

  const bytes = cleanCandidate(current, inspection.states ?? observedStates(registry, current), registry)
  const digest = sha256(bytes)
  const manifest = {
    schema: 'unbun.cc.baseline',
    schema_version: 1,
    feature_contract: 'claude-v1',
    path_key: pathKey,
    embedded_version: embeddedVersion,
    blob: `blobs/${digest}.ccbak`,
    sha256: digest,
    lineage_algorithm: 'claude-v1-exact-replay',
    lineage_sha256: lineageSha256(bytes, { platform, matrix, normalizers }),
    size: bytes.length,
    states: { 'source-exec': 'clean', 'agent-model': 'clean', channels: 'clean' },
    created_at: now().toISOString(),
    created_by: implementation,
  }
  const published = await publishBaseline(targetDirectory, manifest, bytes, { pathKey, ...validation })
  assertReplay({ baseline: published, current, registry, platform, matrix, normalizers })
  return published
}

function countChangedSites(registry, entryBytes, resultBytes) {
  let edits = 0
  for (const feature of registry.features()) {
    const before = feature.observe_substates(entryBytes)
    const after = feature.observe_substates(resultBytes)
    if (before.length !== after.length) throw transactionError('content_mismatch', `feature ${feature.name} changed site count`)
    edits += before.filter((site, index) => site.state !== after[index].state).length
  }
  return edits
}

async function unchanged(binaryPath, entryBytes) {
  return (await readFile(binaryPath)).equals(entryBytes)
}

export async function runPatchTransaction({
  binaryPath,
  targetDirectory,
  requestedFeatures,
  entryDigest,
  baseline,
  baselineResolver = resolveTransactionBaseline,
  registry,
  inspect = inspectClaudeBytes,
  lock = DEFAULT_LOCK,
  atomicWrite = createAtomicWriteAdapter(),
  verifyBaseline,
  platform = process.platform,
  pathKey,
  matrix = DEFAULT_PLATFORM_MATRIX,
  normalizers = {},
  codesign = platform === 'darwin' ? createMacOSCodesigner() : null,
}) {
  if (typeof binaryPath !== 'string' || binaryPath.length === 0) throw new TypeError('binaryPath is required')
  // fail-closed 平台 gate（L1B-01）：在取 lock / 建 baseline / 写盘之前拒绝未启用平台，目标二进制不被触碰。
  assertPlatformWriteEnabled(platform, matrix)
  const owner = await lock.acquire(targetDirectory, { command: `write ${binaryPath}` })
  let primaryError = null
  let transactionResult = null
  try {
    const entryBytes = await readFile(binaryPath)
    const entryMode = (await stat(binaryPath)).mode & 0o777
    if (entryDigest !== undefined && sha256(entryBytes) !== entryDigest) {
      throw transactionError('concurrent_binary_change', 'binary differs from the caller entry digest', 1)
    }

    const entryInspection = inspect(entryBytes)
    if (!entryInspection?.embeddedVersion) throw transactionError('version_probe_failed', 'binary embedded version is unavailable', 1)
    const activeBaseline = baseline ?? await baselineResolver({
      targetDirectory,
      current: entryBytes,
      registry,
      inspect,
      pathKey,
      platform,
      matrix,
      normalizers,
    })
    if (!activeBaseline?.manifest || !Buffer.isBuffer(activeBaseline.bytes)) throw new TypeError('verified baseline is required')
    if (entryInspection.embeddedVersion !== activeBaseline.manifest.embedded_version) {
      throw transactionError('baseline_stale_build', 'baseline version does not match transaction entry')
    }
    const verify = verifyBaseline ?? (({ baseline: value, current }) => assertReplay({
      baseline: value, current, registry, platform, matrix, normalizers,
    }))
    await verify({ baseline: activeBaseline, current: entryBytes, registry, platform })

    const applied = closeFeatures(registry, requestedFeatures)
    const replayed = replayTarget(registry, activeBaseline.bytes, applied)
    assertResult({
      bytes: replayed.bytes,
      baseline: { ...activeBaseline, embeddedVersion: activeBaseline.manifest.embedded_version },
      registry,
      requestedFeatures: applied,
      inspect,
    })
    const edits = countChangedSites(registry, entryBytes, replayed.bytes)

    if (replayed.bytes.equals(entryBytes)) {
      if (!await unchanged(binaryPath, entryBytes)) {
        throw transactionError('concurrent_binary_change', 'binary changed before idempotent return', 1)
      }
      transactionResult = { binary: binaryPath, applied, edits: 0, resigned: false }
      return transactionResult
    }

    let replaced = false
    try {
      const published = await atomicWrite.publish({
        binaryPath,
        entryBytes,
        resultBytes: replayed.bytes,
        mode: entryMode,
        targetDirectory,
        proof: async ({ current }) => verify({ baseline: activeBaseline, current, registry, platform }),
      })
      replaced = published.replaced === true
      let resigned = false
      if (platform === 'darwin') {
        if (typeof codesign !== 'function') throw transactionError('codesign_failed', 'macOS codesign adapter is required', 3)
        try {
          await codesign(binaryPath)
        } catch (error) {
          if (error instanceof StoreError && error.code === 'codesign_failed') throw error
          throw transactionError('codesign_failed', 'macOS ad-hoc codesign failed', 3, { cause: error.message })
        }
        resigned = true
      }
      const finalBytes = await readFile(binaryPath)
      if (platform !== 'darwin' && !finalBytes.equals(replayed.bytes)) {
        throw transactionError('content_mismatch', 'post-write bytes do not match transaction result')
      }
      assertResult({
        bytes: finalBytes,
        baseline: { ...activeBaseline, embeddedVersion: activeBaseline.manifest.embedded_version },
        registry,
        requestedFeatures: applied,
        inspect,
        allowSignatureDrift: platform === 'darwin',
      })
      if (platform === 'darwin') {
        const finalStat = await stat(binaryPath)
        if (!finalStat.isFile() || (finalStat.mode & 0o111) === 0) {
          throw transactionError('content_mismatch', 'signed binary is not an executable regular file')
        }
      }
      await verify({ baseline: activeBaseline, current: finalBytes, registry, platform })
      transactionResult = { binary: binaryPath, applied, edits, resigned, temporaryPath: published.temporaryPath ?? null }
      return transactionResult
    } catch (error) {
      replaced ||= error.replaced === true
      if (!replaced) throw error
      try {
        await atomicWrite.restore({ binaryPath, entryBytes, mode: entryMode })
        const restored = await readFile(binaryPath)
        if (!restored.equals(entryBytes)) throw new Error('restored bytes do not match transaction entry')
      } catch (rollbackError) {
        throw transactionError('rollback_failed', 'transaction entry bytes could not be restored', 2, {
          originalCode: error.code ?? null,
          originalMessage: error.message,
          rollbackMessage: rollbackError.message,
          diagnosticTemporaryPath: rollbackError.temporaryPath ?? null,
        })
      }
      throw error
    }
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    try {
      await lock.release(targetDirectory, owner.token)
    } catch (releaseError) {
      const diagnostic = { code: releaseError.code ?? null, message: releaseError.message }
      if (primaryError !== null) primaryError.releaseError = diagnostic
      // L3B-02：事务已成功写盘时，不能因为释放锁失败就把整体报成失败——调用方会误以为没写。
      // 把它降级为挂在成功结果上的告警；结果不是对象（无处挂载）时才抛出。
      else if (transactionResult !== null && typeof transactionResult === 'object') {
        transactionResult.releaseError = diagnostic
      } else throw releaseError
    }
  }
}