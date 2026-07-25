#!/usr/bin/env bun

import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

import { publishTargetMetadata } from '../../lib/patch/store/assets.mjs'
import { targetIdentity } from '../../lib/patch/store/identity.mjs'
import { acquireTargetLock, cleanupStaleLock, releaseTargetLock } from '../../lib/patch/store/lock.mjs'
import { sha256 } from '../../lib/patch/store/manifests.mjs'
import { resolveStoreRoot, storeV1Root } from '../../lib/patch/store/root.mjs'
import { inspectClaudeBytes } from '../../lib/patch/targets/claude/probe.mjs'
import { claudeFeatureRegistry } from '../../lib/patch/targets/claude/index.mjs'
import {
  listSnapshots,
  removeSnapshot,
  restoreSnapshot,
  saveSnapshot,
} from '../../lib/patch/transaction/snapshots.mjs'
import { runPatchTransaction } from '../../lib/patch/transaction/transaction.mjs'

async function readRequest() {
  const text = await new Response(Bun.stdin.stream()).text()
  const request = JSON.parse(text)
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new TypeError('request must be a JSON object')
  return request
}

async function context(request) {
  if (request.store !== resolveStoreRoot()) throw new TypeError('request store must equal UNBUN_CC_STORE')
  const identity = await targetIdentity(request.binary)
  const targetDirectory = path.join(storeV1Root(request.store), 'targets', identity.pathKey)
  await publishTargetMetadata(targetDirectory, {
    schema: 'unbun.cc.target',
    schema_version: 1,
    path_key: identity.pathKey,
    canonical_path: identity.canonicalPath,
    display_name: path.basename(request.binary),
    created_at: new Date().toISOString(),
  })
  return { identity, targetDirectory }
}

function states(bytes) {
  return Object.fromEntries(claudeFeatureRegistry.features().map((feature) => [feature.name, feature.detect(bytes).state]))
}

async function storeTree(store) {
  const root = storeV1Root(store)
  const entries = []
  async function walk(directory, prefix = '') {
    let children
    try {
      children = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (error.code === 'ENOENT') return
      throw error
    }
    for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = prefix ? `${prefix}/${child.name}` : child.name
      const absolute = path.join(directory, child.name)
      if (child.isDirectory()) await walk(absolute, relative)
      else if (child.isFile()) {
        const bytes = await readFile(absolute)
        entries.push({ path: relative, sha256: sha256(bytes), size: bytes.length })
      }
    }
  }
  await walk(root)
  return entries
}

async function execute(request) {
  const { identity, targetDirectory } = await context(request)
  let result
  if (request.action === 'write-features') {
    result = await runPatchTransaction({
      binaryPath: request.binary,
      targetDirectory,
      pathKey: identity.pathKey,
      requestedFeatures: request.features,
      registry: claudeFeatureRegistry,
      platform: process.platform,
    })
  } else if (request.action === 'snapshot-save') {
    result = await saveSnapshot({
      binaryPath: request.binary,
      targetDirectory,
      pathKey: identity.pathKey,
      slug: request.snapshot,
      force: request.force === true,
    })
  } else if (request.action === 'snapshot-list') {
    const snapshots = await listSnapshots({ targetDirectory, pathKey: identity.pathKey })
    result = {
      snapshots: snapshots.map((snapshot) => snapshot.invalid
        ? { slug: snapshot.slug, version: snapshot.version, invalid: true }
        : { slug: snapshot.manifest.slug, version: snapshot.manifest.embedded_version, invalid: false }),
    }
  } else if (request.action === 'snapshot-restore') {
    result = await restoreSnapshot({
      binaryPath: request.binary,
      targetDirectory,
      pathKey: identity.pathKey,
      slug: request.snapshot,
      currentVersion: request.version,
      confirmVersionChange: request.force === true,
      platform: process.platform,
    })
  } else if (request.action === 'snapshot-rm') {
    result = await removeSnapshot({
      targetDirectory,
      pathKey: identity.pathKey,
      slug: request.snapshot,
      currentVersion: request.version ?? inspectClaudeBytes(await readFile(request.binary)).embeddedVersion,
    })
  } else if (request.action === 'lock-hold') {
    const owner = await acquireTargetLock(targetDirectory, { command: 'interop lock hold' })
    try {
      while (true) {
        try {
          await readFile(request.release)
          break
        } catch (error) {
          if (error.code !== 'ENOENT') throw error
          await Bun.sleep(10)
        }
      }
    } finally {
      await releaseTargetLock(targetDirectory, owner.token)
    }
    result = { released: true }
  } else if (request.action === 'lock-cleanup') {
    result = await cleanupStaleLock(targetDirectory, { force: request.force === true })
  } else if (request.action === 'inspect-store') {
    result = {}
  } else {
    throw new TypeError(`unknown action: ${request.action}`)
  }
  const bytes = await readFile(request.binary)
  return {
    ok: true,
    action: request.action,
    implementation: 'js',
    applied: result.applied,
    edits: result.edits,
    snapshots: result.snapshots,
    states: result.states ?? states(bytes),
    binarySha256: sha256(bytes),
    storeTree: await storeTree(request.store),
  }
}

let request
try {
  request = await readRequest()
  console.log(JSON.stringify(await execute(request)))
} catch (error) {
  const exit = error.exitCode ?? 2
  console.log(JSON.stringify({
    ok: false,
    action: request?.action ?? null,
    implementation: 'js',
    code: error.code ?? 'runner_error',
    exit,
    message: error.message,
  }))
  process.exitCode = exit
}