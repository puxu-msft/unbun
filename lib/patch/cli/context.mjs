import path from 'node:path'

import { publishTargetMetadata } from '../store/assets.mjs'
import { targetIdentity } from '../store/identity.mjs'
import { resolveStoreRoot, storeV1Root } from '../store/root.mjs'

export async function targetContext(binaryPath, { publish = false } = {}) {
  const binary = path.resolve(binaryPath)
  const identity = await targetIdentity(binary)
  const targetDirectory = path.join(storeV1Root(resolveStoreRoot()), 'targets', identity.pathKey)
  if (publish) {
    await publishTargetMetadata(targetDirectory, {
      schema: 'unbun.cc.target',
      schema_version: 1,
      path_key: identity.pathKey,
      canonical_path: identity.canonicalPath,
      display_name: path.basename(binary),
      created_at: new Date().toISOString(),
    })
  }
  return { binary, identity, targetDirectory }
}