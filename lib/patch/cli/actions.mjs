import { readFile } from 'node:fs/promises'

import { closeFeatures } from '../core/dependencies.mjs'
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

async function featureWrite(binaryPath, command, options) {
  const context = await targetContext(binaryPath, { publish: true })
  const entry = await readFile(context.binary)
  const inspection = inspectClaudeBytes(entry)
  const current = patchedFeatures(inspection)
  const requested = requestedFeatures(options)
  const targets = targetFeatures(command, current, requested)
  return applyFeatureTargets(context.binary, targets, sha256(entry), { context })
}

export async function applyFeatureTargets(binaryPath, targetFeatures, entryDigest, adapters = {}) {
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
  const inspection = inspectClaudeBytes(await readFile(context.binary))
  return { ...context, inspection }
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