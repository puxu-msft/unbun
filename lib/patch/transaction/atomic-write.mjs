import { randomUUID } from 'node:crypto'
import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'

import { StoreError, sha256, validateManifest } from '../store/manifests.mjs'

function transactionError(code, message, exitCode = 2, details = {}) {
  return new StoreError(code, message, exitCode, details)
}

async function syncHandle(handle) {
  await handle.sync()
}

function isBinaryInUse(error) {
  return ['EBUSY', 'EACCES', 'EPERM'].includes(error?.code)
}

function quarantineTimestamp(date) {
  return date.toISOString().replaceAll(':', '').replaceAll('.', '')
}

async function prepareTemp(binaryPath, bytes, mode, {
  syncFile,
  uuid,
  afterTempWrite,
  afterTempReadback,
}) {
  const temporaryPath = path.join(path.dirname(binaryPath), `.${path.basename(binaryPath)}.tmp.${uuid()}`)
  const handle = await open(temporaryPath, 'wx', mode)
  try {
    await handle.writeFile(bytes)
    await handle.chmod(mode)
    await syncFile(handle)
  } finally {
    await handle.close()
  }
  await afterTempWrite?.({ binaryPath, temporaryPath, bytes })
  const written = await readFile(temporaryPath)
  if (!written.equals(bytes)) {
    await unlink(temporaryPath).catch(() => {})
    throw transactionError('content_mismatch', 'temporary binary readback mismatch')
  }
  await afterTempReadback?.({ binaryPath, temporaryPath, bytes: written })
  return temporaryPath
}

async function quarantineReadyTemp(temporaryPath, targetDirectory, {
  now,
  uuid,
  implementation,
}) {
  const bytes = await readFile(temporaryPath)
  const discoveredAt = now()
  const directory = path.join(
    targetDirectory,
    'quarantine',
    `${quarantineTimestamp(discoveredAt)}-binary_in_use-${uuid()}`,
  )
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const artifactPath = path.join(directory, 'artifact')
  await rename(temporaryPath, artifactPath)
  const manifest = {
    schema: 'unbun.cc.quarantine',
    schema_version: 1,
    original_path: path.basename(temporaryPath),
    reason: 'binary_in_use',
    observed_sha256: sha256(bytes),
    discovered_at: discoveredAt.toISOString(),
    discovered_by: implementation,
  }
  validateManifest('quarantine', manifest)
  try {
    await writeFile(path.join(directory, 'quarantine.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    await rename(artifactPath, temporaryPath).catch(() => {})
    throw error
  }
  return { directory, artifactPath, manifest }
}

export function createAtomicWriteAdapter({
  syncFile = syncHandle,
  replace = rename,
  beforeReplace,
  afterTempWrite,
  afterTempReadback,
  now = () => new Date(),
  uuid = randomUUID,
  implementation = 'js',
} = {}) {
  const common = { syncFile, uuid, afterTempWrite, afterTempReadback }

  async function publish({
    binaryPath,
    entryBytes,
    resultBytes,
    mode,
    targetDirectory,
    proof,
  }) {
    let temporaryPath = await prepareTemp(binaryPath, resultBytes, mode, common)
    let replaced = false
    try {
      await beforeReplace?.({ binaryPath, temporaryPath, entryBytes, resultBytes })
      const current = await readFile(binaryPath)
      if (!current.equals(entryBytes)) {
        throw transactionError('concurrent_binary_change', 'binary changed immediately before replace', 1)
      }
      await proof?.({ current, entryBytes, resultBytes })
      try {
        await replace(temporaryPath, binaryPath)
        temporaryPath = null
        replaced = true
      } catch (error) {
        if (!isBinaryInUse(error)) throw error
        const quarantined = await quarantineReadyTemp(temporaryPath, targetDirectory, { now, uuid, implementation })
        temporaryPath = null
        throw transactionError('binary_in_use', 'binary is in use; verified replacement moved to quarantine', 3, {
          quarantinePath: quarantined.directory,
          artifactPath: quarantined.artifactPath,
        })
      }
      const written = await readFile(binaryPath)
      if (!written.equals(resultBytes)) throw transactionError('content_mismatch', 'atomic replace readback mismatch')
      return { replaced: true, temporaryPath: null }
    } catch (error) {
      if (temporaryPath !== null) await unlink(temporaryPath).catch(() => {})
      if (replaced) error.replaced = true
      throw error
    }
  }

  async function restore({ binaryPath, entryBytes, mode }) {
    let temporaryPath = await prepareTemp(binaryPath, entryBytes, mode, common)
    try {
      await replace(temporaryPath, binaryPath)
      temporaryPath = null
      const restored = await readFile(binaryPath)
      if (!restored.equals(entryBytes)) throw transactionError('content_mismatch', 'rollback readback mismatch')
      return { restored: true }
    } catch (error) {
      if (temporaryPath) error.temporaryPath = temporaryPath
      throw error
    }
  }

  return Object.freeze({ publish, restore })
}