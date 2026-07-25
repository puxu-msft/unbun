import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { sha256, validateManifest } from './manifests.mjs'

const RELATIVE_PATH = /^(?!\/)(?![A-Za-z]:[\\/])(?!.*(?:^|\/)\.\.(?:\/|$))[^\\]+(?:\/[^\\]+)*$/
const REASON = /^[a-z0-9]+(?:_[a-z0-9]+)*$/

function timestamp(date) {
  return date.toISOString().replaceAll(':', '').replaceAll('.', '')
}

export async function quarantineArtifact(targetDirectory, originalPath, reason, {
  implementation = 'js',
  now = () => new Date(),
  uuid = randomUUID,
} = {}) {
  if (typeof originalPath !== 'string' || !RELATIVE_PATH.test(originalPath)) throw new TypeError('quarantine original path must be a constrained relative path')
  if (typeof reason !== 'string' || !REASON.test(reason)) throw new TypeError('quarantine reason must be a stable reason code')
  const sourcePath = path.join(targetDirectory, ...originalPath.split('/'))
  const bytes = await readFile(sourcePath)
  const discoveredAt = now()
  const quarantineRoot = path.join(targetDirectory, 'quarantine')
  const directory = path.join(quarantineRoot, `${timestamp(discoveredAt)}-${reason}-${uuid()}`)
  await mkdir(quarantineRoot, { recursive: true, mode: 0o700 })
  await mkdir(directory, { recursive: false, mode: 0o700 })
  const artifactPath = path.join(directory, 'artifact')
  await rename(sourcePath, artifactPath)
  const manifest = {
    schema: 'unbun.cc.quarantine',
    schema_version: 1,
    original_path: originalPath,
    reason,
    observed_sha256: sha256(bytes),
    discovered_at: discoveredAt.toISOString(),
    discovered_by: implementation,
  }
  validateManifest('quarantine', manifest)
  const manifestPath = path.join(directory, 'quarantine.json')
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  return { directory, artifactPath, manifestPath, manifest }
}