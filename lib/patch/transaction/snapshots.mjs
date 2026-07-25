import { readFile, readdir, stat, unlink } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import {
  publishSnapshot,
  selectSnapshot,
} from '../store/assets.mjs'
import { assertPlatformWriteEnabled } from '../store/lineage.mjs'
import { acquireTargetLock, releaseTargetLock, withTargetLock } from '../store/lock.mjs'
import { StoreError, sha256 } from '../store/manifests.mjs'
import { inspectClaudeBytes } from '../targets/claude/probe.mjs'
import { createAtomicWriteAdapter } from './atomic-write.mjs'
import { createMacOSCodesigner } from './codesign.mjs'

const DEFAULT_PLATFORM_MATRIX = JSON.parse(readFileSync(new URL('../../../contract/vectors/platform-writes-v1.json', import.meta.url), 'utf8'))

function error(code, message, exitCode = 2, details = {}) {
  return new StoreError(code, message, exitCode, details)
}

const defaultLock = Object.freeze({ acquire: acquireTargetLock, release: releaseTargetLock })

function assetValidation(inspect) {
  return {
    inspect: async (bytes, manifest) => inspect(bytes, manifest),
  }
}

function snapshotManifest({ bytes, inspection, pathKey, slug, now, implementation }) {
  const digest = sha256(bytes)
  return {
    schema: 'unbun.cc.snapshot',
    schema_version: 1,
    feature_contract: 'claude-v1',
    path_key: pathKey,
    embedded_version: inspection.embeddedVersion,
    slug,
    blob: `blobs/${digest}.ccsnap`,
    sha256: digest,
    size: bytes.length,
    observed_states: inspection.states,
    created_at: now().toISOString(),
    created_by: implementation,
  }
}

function statesMatch(left, right) {
  return ['source-exec', 'agent-model', 'channels'].every((name) => left?.[name] === right?.[name])
}

// L3B-02：复用共享 helper，保证 lock 释放失败不会掩盖主体错误。此前这里是裸 `finally { release }`，
// 实测会把「二进制已损坏且回滚失败」（rollback_failed/exit 2）降级成 target_locked/exit 1。
async function withLock(targetDirectory, lock, command, action) {
  return withTargetLock(targetDirectory, lock, command, action)
}

export async function saveSnapshot({
  binaryPath,
  targetDirectory,
  pathKey,
  slug,
  inspect = inspectClaudeBytes,
  force = false,
  lock = defaultLock,
  now = () => new Date(),
  implementation = 'js',
}) {
  return withLock(targetDirectory, lock, `snapshot save ${slug}`, async () => {
    const bytes = await readFile(binaryPath)
    const inspection = inspect(bytes)
    if (!inspection?.embeddedVersion) throw error('version_probe_failed', 'snapshot source version is unavailable', 1)
    const manifest = snapshotManifest({ bytes, inspection, pathKey, slug, now, implementation })
    return publishSnapshot(targetDirectory, manifest, bytes, {
      pathKey,
      force,
      ...assetValidation(inspect),
    })
  })
}

export async function listSnapshots({ targetDirectory, pathKey, inspect = inspectClaudeBytes }) {
  const root = path.join(targetDirectory, 'snapshots')
  let versions
  try {
    versions = await readdir(root, { withFileTypes: true })
  } catch (caught) {
    if (caught.code === 'ENOENT') return []
    throw caught
  }
  const snapshots = []
  for (const version of versions) {
    if (!version.isDirectory()) continue
    const slots = await readdir(path.join(root, version.name), { withFileTypes: true })
    for (const slot of slots) {
      if (!slot.isDirectory()) continue
      try {
        await readFile(path.join(root, version.name, slot.name, 'snapshot.json'))
      } catch (caught) {
        if (caught.code === 'ENOENT') continue
        throw caught
      }
      try {
        const snapshot = await selectSnapshot(targetDirectory, slot.name, {
          currentVersion: version.name,
          pathKey,
          ...assetValidation(inspect),
        })
        if (snapshot.manifest.embedded_version === version.name) snapshots.push(snapshot)
      } catch (caught) {
        snapshots.push({ invalid: true, version: version.name, slug: slot.name, error: caught })
      }
    }
  }
  return snapshots.sort((left, right) => {
    const leftKey = `${left.manifest?.embedded_version ?? left.version}/${left.manifest?.slug ?? left.slug}`
    const rightKey = `${right.manifest?.embedded_version ?? right.version}/${right.manifest?.slug ?? right.slug}`
    return leftKey.localeCompare(rightKey)
  })
}

export async function removeSnapshot({
  targetDirectory,
  pathKey,
  slug,
  currentVersion,
  inspect = inspectClaudeBytes,
  lock = defaultLock,
}) {
  return withLock(targetDirectory, lock, `snapshot remove ${slug}`, async () => {
    const snapshot = await selectSnapshot(targetDirectory, slug, {
      currentVersion,
      pathKey,
      ...assetValidation(inspect),
    })
    const manifestPath = path.join(
      targetDirectory,
      'snapshots',
      snapshot.manifest.embedded_version,
      snapshot.manifest.slug,
      'snapshot.json',
    )
    await unlink(manifestPath)
    return { manifestRemoved: true, manifest: snapshot.manifest }
  })
}

export async function restoreSnapshot({
  binaryPath,
  targetDirectory,
  pathKey,
  slug,
  entryDigest,
  inspect = inspectClaudeBytes,
  currentVersion,
  confirmVersionChange = false,
  select = selectSnapshot,
  lock = defaultLock,
  atomicWrite = createAtomicWriteAdapter(),
  platform = process.platform,
  matrix = DEFAULT_PLATFORM_MATRIX,
  codesign = platform === 'darwin' ? createMacOSCodesigner() : null,
}) {
  // fail-closed 平台 gate（L1B-01）：snapshot restore 同样写目标二进制，未启用平台在取 lock 前拒绝。
  assertPlatformWriteEnabled(platform, matrix)
  return withLock(targetDirectory, lock, `snapshot restore ${slug}`, async () => {
    const entryBytes = await readFile(binaryPath)
    if (entryDigest !== undefined && sha256(entryBytes) !== entryDigest) {
      throw error('concurrent_binary_change', 'binary differs from the snapshot restore entry digest', 1)
    }
    const entryInspection = inspect(entryBytes)
    if (!entryInspection?.embeddedVersion) throw error('version_probe_failed', 'current binary version is unavailable', 1)
    const snapshot = await select(targetDirectory, slug, {
      currentVersion: currentVersion ?? entryInspection.embeddedVersion,
      pathKey,
      ...assetValidation(inspect),
    })
    const snapshotInspection = inspect(snapshot.bytes)
    if (!snapshotInspection?.embeddedVersion || snapshotInspection.embeddedVersion !== snapshot.manifest.embedded_version) {
      throw error('snapshot_invalid', 'snapshot content version does not match its manifest')
    }
    if (snapshotInspection.embeddedVersion !== entryInspection.embeddedVersion && !confirmVersionChange) {
      throw error('snapshot_invalid', 'cross-version snapshot restore requires explicit confirmation', 1, {
        currentVersion: entryInspection.embeddedVersion,
        snapshotVersion: snapshotInspection.embeddedVersion,
        confirmationRequired: true,
      })
    }
    const mode = stat(binaryPath).then((value) => value.mode & 0o777)
    let replaced = false
    try {
      const published = await atomicWrite.publish({
        binaryPath,
        entryBytes,
        resultBytes: snapshot.bytes,
        mode: await mode,
        targetDirectory,
      })
      replaced = published.replaced === true
      let resigned = false
      if (platform === 'darwin') {
        try {
          await codesign(binaryPath)
        } catch (caught) {
          if (caught instanceof StoreError && caught.code === 'codesign_failed') throw caught
          throw error('codesign_failed', 'macOS snapshot restore codesign failed', 3, { cause: caught.message })
        }
        resigned = true
      }
      const restoredBytes = await readFile(binaryPath)
      const restoredInspection = inspect(restoredBytes)
      if (
        platform !== 'darwin' && !restoredBytes.equals(snapshot.bytes)
        || restoredInspection.embeddedVersion !== snapshotInspection.embeddedVersion
        || !statesMatch(restoredInspection.states, snapshot.manifest.observed_states)
      ) {
        throw error('content_mismatch', 'snapshot restore postverification failed')
      }
      if (platform === 'darwin') {
        const restoredStat = await stat(binaryPath)
        if (!restoredStat.isFile() || (restoredStat.mode & 0o111) === 0) throw error('content_mismatch', 'restored binary is not executable')
      }
      return { restored: true, resigned, embeddedVersion: restoredInspection.embeddedVersion, states: restoredInspection.states }
    } catch (caught) {
      replaced ||= caught.replaced === true
      if (!replaced) throw caught
      try {
        await atomicWrite.restore({ binaryPath, entryBytes, mode: await mode })
        if (!(await readFile(binaryPath)).equals(entryBytes)) throw new Error('entry bytes do not match after snapshot rollback')
      } catch (rollbackError) {
        throw error('rollback_failed', 'snapshot restore entry bytes could not be restored', 2, {
          originalCode: caught.code ?? null,
          rollbackMessage: rollbackError.message,
          diagnosticTemporaryPath: rollbackError.temporaryPath ?? null,
        })
      }
      throw caught
    }
  })
}