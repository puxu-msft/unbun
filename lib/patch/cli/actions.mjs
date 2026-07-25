import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'

import { closeFeatures } from '../core/dependencies.mjs'
import { assertPlatformWriteEnabled } from '../store/lineage.mjs'
import { sha256 } from '../store/manifests.mjs'
import { claudeFeatureRegistry } from '../targets/claude/index.mjs'
import { inspectClaudeBytes } from '../targets/claude/probe.mjs'
import {
  listSnapshots,
  removeSnapshot,
  restoreSnapshot,
  saveSnapshot,
} from '../transaction/snapshots.mjs'
import { runPatchTransaction } from '../transaction/transaction.mjs'
import { targetContext } from './context.mjs'
import { CliUsageError } from './errors.mjs'
import { structuredError, writeEnvelope } from './output.mjs'

const DEFAULT_PLATFORM_MATRIX = JSON.parse(readFileSync(new URL('../../../contract/vectors/platform-writes-v1.json', import.meta.url), 'utf8'))

function patchedFeatures(inspection) {
  return claudeFeatureRegistry.topologicalNames().filter((name) => ['patched', 'mixed'].includes(inspection.states[name]))
}

function requestedFeatures(options) {
  if (options.all && options.feature.length > 0) throw new CliUsageError('--all and --feature are mutually exclusive')
  if (options.all) return claudeFeatureRegistry.topologicalNames()
  if (options.feature.length === 0) return null
  const requested = [...new Set(options.feature.flatMap((value) => value.split(',')).map((value) => value.trim()).filter(Boolean))]
  const unknown = requested.filter((feature) => !claudeFeatureRegistry.has(feature))
  if (unknown.length > 0) throw new CliUsageError(`unknown feature: ${unknown.join(', ')}`)
  return requested
}

function targetFeatures(command, current, requested) {
  if (command === 'patch') {
    const selected = requested ?? claudeFeatureRegistry.topologicalNames()
    return claudeFeatureRegistry.topologicalNames().filter((name) => new Set([...current, ...selected]).has(name))
  }
  if (requested === null || optionsAll(requested)) return []
  const remaining = current.filter((name) => !requested.includes(name))
  const stillRequired = requested.find((removed) => remaining.some((name) => closeFeatures(claudeFeatureRegistry, [name]).includes(removed)))
  if (stillRequired) {
    const error = new Error(`cannot revert ${stillRequired} while another enabled feature depends on it`)
    error.code = 'unsupported_or_mixed_no_baseline'
    error.exitCode = 1
    error.details = { reason: 'feature_dependency_conflict' }
    error.feature = stillRequired
    throw error
  }
  const removedClosure = new Set(closeFeatures(claudeFeatureRegistry, requested))
  const remainingRoots = remaining.filter((name) => !removedClosure.has(name))
  return closeFeatures(claudeFeatureRegistry, remainingRoots)
}

function optionsAll(requested) {
  return requested.length === claudeFeatureRegistry.names().length
    && requested.every((name) => claudeFeatureRegistry.has(name))
}

// L4-04：平台 gate 必须在**任何落盘之前**执行。此前 `targetContext(..., { publish: true })` 会先写出
// `store/v1/targets/<key>/target.json`，gate 随后在 runPatchTransaction 内才拒绝，于是未启用平台上
// 仍留下 store 残留——与 README/ARCHITECTURE「目标与 store 均不被触碰」的承诺字面不符，也与 Python
// （gate 在 _get_store() 之前）的可观察边界不可互换。gate 只依赖 platform + matrix，可安全前置。
function assertWriteAllowedHere() {
  assertPlatformWriteEnabled(process.platform, DEFAULT_PLATFORM_MATRIX)
}

async function featureWrite(binaryPath, command, options) {
  assertWriteAllowedHere()
  const context = await targetContext(binaryPath, { publish: true })
  const entry = await readFile(context.binary)
  const inspection = inspectClaudeBytes(entry)
  const current = patchedFeatures(inspection)
  const requested = requestedFeatures(options)
  const targets = targetFeatures(command, current, requested)
  return applyFeatureTargets(context.binary, targets, sha256(entry), { context })
}

export async function applyFeatureTargets(binaryPath, targetFeatures, entryDigest, adapters = {}) {
  if (!adapters.context) assertWriteAllowedHere()
  const context = adapters.context ?? await targetContext(binaryPath, { publish: true })
  const runTransaction = adapters.runTransaction ?? runPatchTransaction
  return runTransaction({
    binaryPath: context.binary,
    targetDirectory: context.targetDirectory,
    pathKey: context.identity.pathKey,
    requestedFeatures: targetFeatures,
    entryDigest,
    registry: claudeFeatureRegistry,
    platform: process.platform,
  })
}

export async function runFeatureWrites(command, options) {
  requestedFeatures(options)
  const results = []
  const errors = []
  for (const binary of options.binary) {
    try {
      results.push(await featureWrite(binary, command, options))
    } catch (error) {
      const structured = structuredError(error, binary, error.feature ?? options.feature[0] ?? null)
      errors.push(structured)
      console.error(`${structured.value.code}: ${structured.value.message}`)
    }
  }
  return writeEnvelope(command, results, errors)
}

function snapshotResult(binary, applied, value = {}) {
  return { binary, applied, edits: 0, resigned: value.resigned === true }
}

async function snapshotContext(binaryPath, publish) {
  const context = await targetContext(binaryPath, { publish })
  const entryBytes = await readFile(context.binary)
  const inspection = inspectClaudeBytes(entryBytes)
  // 把读到 inspection 时的字节摘要一并带出：跨版本确认与后续 restore 必须绑定到**同一个**二进制，
  // 否则确认与写入之间目标被替换（自动升级等）会让用户确认的「用 A 覆盖 B」变成覆盖另一个 build。
  return { ...context, inspection, entryDigest: sha256(entryBytes) }
}

export async function runSnapshotWrite(action, options) {
  const results = []
  const errors = []
  for (const binary of options.binary) {
    try {
      const context = await snapshotContext(binary, true)
      let value
      if (action === 'snapshot-save') {
        value = await saveSnapshot({
          binaryPath: context.binary,
          targetDirectory: context.targetDirectory,
          pathKey: context.identity.pathKey,
          slug: options.name,
          force: options.force,
        })
      } else if (action === 'snapshot-rm') {
        value = await removeSnapshot({
          targetDirectory: context.targetDirectory,
          pathKey: context.identity.pathKey,
          slug: options.name,
          currentVersion: options.snapshotVersion ?? context.inspection.embeddedVersion,
        })
      } else {
        value = await restoreSnapshot({
          binaryPath: context.binary,
          targetDirectory: context.targetDirectory,
          pathKey: context.identity.pathKey,
          slug: options.snapshot,
          currentVersion: options.snapshotVersion ?? context.inspection.embeddedVersion,
          confirmVersionChange: options.force || options.yes,
          // 绑定到确认时读到的字节：目标在确认与写入之间被替换 → concurrent_binary_change，不写。
          // 与 Python 的 bound confirmation payload（L3C-05）语义对齐。
          entryDigest: context.entryDigest,
          platform: process.platform,
        })
      }
      const finalInspection = inspectClaudeBytes(await readFile(context.binary))
      results.push(snapshotResult(context.binary, patchedFeatures(finalInspection), value))
    } catch (error) {
      const structured = structuredError(error, binary)
      errors.push(structured)
      console.error(`${structured.value.code}: ${structured.value.message}`)
    }
  }
  return writeEnvelope(action, results, errors)
}

export async function runSnapshotList(options) {
  const snapshots = []
  for (const binary of options.binary) {
    const context = await snapshotContext(binary, false)
    const listed = await listSnapshots({ targetDirectory: context.targetDirectory, pathKey: context.identity.pathKey })
    for (const snapshot of listed) {
      snapshots.push(snapshot.invalid
        ? { binary: context.binary, slug: snapshot.slug, version: snapshot.version, invalid: true }
        : {
            binary: context.binary,
            slug: snapshot.manifest.slug,
            version: snapshot.manifest.embedded_version,
            invalid: false,
          })
    }
  }
  return { schema_version: 1, snapshots }
}