import { randomUUID } from 'node:crypto'
import {
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
} from 'node:fs/promises'
import path from 'node:path'

import {
  StoreError,
  parseManifest,
  sha256,
  validateAssetManifest,
  validateManifest,
} from './manifests.mjs'

async function defaultSyncFile(handle) {
  await handle.sync()
}

async function defaultSyncDirectory(directory) {
  const handle = await open(directory, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export function createDurabilityAdapter({
  platform = process.platform,
  syncFile = defaultSyncFile,
  syncDirectory = defaultSyncDirectory,
} = {}) {
  const windows = platform === 'win32'
  return Object.freeze({
    boundary: windows ? 'file-flush-and-atomic-rename-no-directory-fsync' : 'file-and-directory-fsync',
    fsyncFile: syncFile,
    fsyncDirectory: windows ? async () => {} : syncDirectory,
  })
}

async function writeVerifiedTemp(finalPath, data, durability) {
  const temporaryPath = path.join(path.dirname(finalPath), `.${path.basename(finalPath)}.tmp.${randomUUID()}`)
  const handle = await open(temporaryPath, 'wx', 0o600)
  try {
    await handle.writeFile(data)
    await durability.fsyncFile(handle)
  } finally {
    await handle.close()
  }
  const written = await readFile(temporaryPath)
  const expected = Buffer.isBuffer(data) ? data : Buffer.from(data)
  if (!written.equals(expected)) {
    await unlink(temporaryPath)
    throw new StoreError('content_mismatch', 'temporary asset readback mismatch', 2)
  }
  return temporaryPath
}

async function noClobberPublish(temporaryPath, finalPath) {
  try {
    await link(temporaryPath, finalPath)
    return true
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    return false
  } finally {
    await unlink(temporaryPath).catch((error) => {
      if (error.code !== 'ENOENT') throw error
    })
  }
}

async function publishBlob(blobPath, bytes, durability) {
  await mkdir(path.dirname(blobPath), { recursive: true, mode: 0o700 })
  const temporaryPath = await writeVerifiedTemp(blobPath, bytes, durability)
  const created = await noClobberPublish(temporaryPath, blobPath)
  const active = await readFile(blobPath)
  if (active.length !== bytes.length || sha256(active) !== sha256(bytes)) {
    throw new StoreError('content_mismatch', 'content-addressed blob collision or corruption', 2)
  }
  await durability.fsyncDirectory(path.dirname(blobPath))
  return created
}

async function publishManifest(manifestPath, manifest, durability, { force = false } = {}) {
  const encoded = `${JSON.stringify(manifest, null, 2)}\n`
  const temporaryPath = await writeVerifiedTemp(manifestPath, encoded, durability)
  parseManifest(await readFile(temporaryPath), manifest.schema.slice('unbun.cc.'.length))
  if (force) {
    const replaced = await readOptional(manifestPath) !== null
    await rename(temporaryPath, manifestPath)
    await durability.fsyncDirectory(path.dirname(manifestPath))
    return { created: !replaced, replaced }
  }
  const created = await noClobberPublish(temporaryPath, manifestPath)
  if (created) await durability.fsyncDirectory(path.dirname(manifestPath))
  return { created, replaced: false }
}

async function readOptional(filePath, encoding) {
  try {
    return await readFile(filePath, encoding)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

export async function publishTargetMetadata(targetDirectory, target, {
  durability = createDurabilityAdapter(),
} = {}) {
  validateManifest('target', target)
  if (path.basename(targetDirectory) !== target.path_key) {
    throw new StoreError('target_identity_mismatch', 'target directory does not match path key', 2)
  }
  await mkdir(targetDirectory, { recursive: true, mode: 0o700 })
  const manifestPath = path.join(targetDirectory, 'target.json')
  const { created } = await publishManifest(manifestPath, target, durability)
  const active = parseManifest(await readFile(manifestPath), 'target')
  if (active.path_key !== target.path_key || active.canonical_path !== target.canonical_path) {
    throw new StoreError('target_identity_mismatch', 'active target metadata describes a different target', 2)
  }
  return { created, manifest: active }
}

function baselinePaths(targetDirectory, embeddedVersion, manifest) {
  const slot = path.join(targetDirectory, 'baselines', embeddedVersion)
  return { slot, manifestPath: path.join(slot, 'baseline.json'), blobPath: path.join(slot, ...manifest.blob.split('/')) }
}

function targetPathKey(targetDirectory, explicitPathKey) {
  if (explicitPathKey !== undefined) return explicitPathKey
  const directoryKey = path.basename(targetDirectory)
  if (/^[0-9a-f]{64}$/.test(directoryKey)) return directoryKey
  throw new StoreError('target_identity_mismatch', 'target path key is required when the directory is not keyed by identity', 2)
}

function snapshotPaths(targetDirectory, embeddedVersion, slug, manifest) {
  const slot = path.join(targetDirectory, 'snapshots', embeddedVersion, slug)
  return { slot, manifestPath: path.join(slot, 'snapshot.json'), blobPath: path.join(slot, ...manifest.blob.split('/')) }
}

export async function loadBaseline(targetDirectory, embeddedVersion, options = {}) {
  const slot = path.join(targetDirectory, 'baselines', embeddedVersion)
  const manifestText = await readOptional(path.join(slot, 'baseline.json'))
  if (manifestText === null) return null
  const manifest = parseManifest(manifestText, 'baseline')
  const bytes = await readFile(path.join(slot, ...manifest.blob.split('/'))).catch((error) => {
    if (error.code === 'ENOENT') throw new StoreError('baseline_invalid', 'active baseline blob is missing', 2)
    throw error
  })
  await validateAssetManifest('baseline', manifest, bytes, {
    ...options,
    directoryVersion: embeddedVersion,
    pathKey: targetPathKey(targetDirectory, options.pathKey),
  })
  return { manifest, bytes }
}

export async function publishBaseline(targetDirectory, manifest, bytes, {
  durability = createDurabilityAdapter(),
  pathKey: explicitPathKey,
  ...validation
} = {}) {
  validateManifest('baseline', manifest)
  const pathKey = targetPathKey(targetDirectory, explicitPathKey)
  await validateAssetManifest('baseline', manifest, bytes, {
    ...validation,
    directoryVersion: manifest.embedded_version,
    pathKey,
  })
  const paths = baselinePaths(targetDirectory, manifest.embedded_version, manifest)
  await mkdir(paths.slot, { recursive: true, mode: 0o700 })
  await publishBlob(paths.blobPath, bytes, durability)
  const { created } = await publishManifest(paths.manifestPath, manifest, durability)
  if (!created) {
    const active = parseManifest(await readFile(paths.manifestPath), 'baseline')
    if (active.sha256 !== manifest.sha256) throw new StoreError('baseline_conflict', 'a different baseline is already active', 2)
  }
  const active = await loadBaseline(targetDirectory, manifest.embedded_version, {
    ...validation,
    pathKey,
  })
  return { created, ...active }
}

export async function loadSnapshot(targetDirectory, embeddedVersion, slug, options = {}) {
  const slot = path.join(targetDirectory, 'snapshots', embeddedVersion, slug)
  const manifestText = await readOptional(path.join(slot, 'snapshot.json'))
  if (manifestText === null) return null
  const manifest = parseManifest(manifestText, 'snapshot')
  const bytes = await readFile(path.join(slot, ...manifest.blob.split('/'))).catch((error) => {
    if (error.code === 'ENOENT') throw new StoreError('snapshot_invalid', 'active snapshot blob is missing', 2)
    throw error
  })
  await validateAssetManifest('snapshot', manifest, bytes, {
    ...options,
    directoryVersion: embeddedVersion,
    pathKey: targetPathKey(targetDirectory, options.pathKey),
  })
  return { manifest, bytes }
}

export async function selectSnapshot(targetDirectory, slug, {
  currentVersion,
  ...options
} = {}) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new StoreError('snapshot_not_found', 'snapshot slug is invalid', 1)
  }
  if (currentVersion) {
    const current = await loadSnapshot(targetDirectory, currentVersion, slug, options)
    if (current) return current
  }
  const snapshotsRoot = path.join(targetDirectory, 'snapshots')
  let versions
  try {
    versions = await readdir(snapshotsRoot, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') throw new StoreError('snapshot_not_found', 'snapshot does not exist', 1)
    throw error
  }
  const matches = []
  for (const entry of versions) {
    if (!entry.isDirectory() || !/^[0-9]+(?:\.[0-9]+)*$/.test(entry.name)) continue
    const snapshot = await loadSnapshot(targetDirectory, entry.name, slug, options)
    if (snapshot) matches.push(snapshot)
  }
  if (matches.length === 0) throw new StoreError('snapshot_not_found', 'snapshot does not exist', 1)
  if (matches.length > 1) throw new StoreError('snapshot_ambiguous', 'snapshot exists across multiple versions', 1)
  return matches[0]
}

export async function publishSnapshot(targetDirectory, manifest, bytes, {
  durability = createDurabilityAdapter(),
  force = false,
  pathKey: explicitPathKey,
  ...validation
} = {}) {
  validateManifest('snapshot', manifest)
  const pathKey = targetPathKey(targetDirectory, explicitPathKey)
  await validateAssetManifest('snapshot', manifest, bytes, {
    ...validation,
    directoryVersion: manifest.embedded_version,
    pathKey,
  })
  const paths = snapshotPaths(targetDirectory, manifest.embedded_version, manifest.slug, manifest)
  await mkdir(paths.slot, { recursive: true, mode: 0o700 })
  await publishBlob(paths.blobPath, bytes, durability)
  const activation = await publishManifest(paths.manifestPath, manifest, durability, { force })
  const { created, replaced } = activation
  if (!force && !created) throw new StoreError('snapshot_exists', 'snapshot is already active', 1)
  const active = await loadSnapshot(targetDirectory, manifest.embedded_version, manifest.slug, {
    ...validation,
    pathKey,
  })
  return { created, replaced, ...active }
}

export async function assessBaselineCreation(targetDirectory, embeddedVersion, states) {
  const active = await readOptional(path.join(targetDirectory, 'baselines', embeddedVersion, 'baseline.json'))
  if (active !== null) return { accepted: true, existing: true }
  if (states.channels === 'patched') return { accepted: false, code: 'channels_patched_no_baseline', exit: 1 }
  if (Object.values(states).some((state) => state === 'mixed' || state === 'unsupported')) {
    return { accepted: false, code: 'unsupported_or_mixed_no_baseline', exit: 1 }
  }
  return { accepted: true, existing: false }
}