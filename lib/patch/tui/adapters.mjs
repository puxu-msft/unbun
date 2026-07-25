import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { applyFeatureTargets } from '../cli/actions.mjs'
import { readStatus } from '../cli/status.mjs'

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function concurrentChange(binary) {
  const error = new Error(`binary changed while probing TUI state: ${binary}`)
  error.code = 'concurrent_binary_change'
  error.exitCode = 1
  return error
}

export function createProductionTuiAdapters({
  binaries,
  readStatus: loadStatus = readStatus,
  readBinary = readFile,
  applyFeatureTargets: apply = applyFeatureTargets,
}) {
  if (!Array.isArray(binaries) || binaries.length === 0) throw new TypeError('at least one TUI binary is required')
  return {
    async loadRows() {
      const loaded = []
      for (const binary of binaries) {
        const before = await readBinary(binary)
        const status = await loadStatus(binary)
        const after = await readBinary(binary)
        const entryDigest = sha256(after)
        if (sha256(before) !== entryDigest) throw concurrentChange(binary)
        loaded.push({
          path: status.path,
          version: status.version,
          hasBaseline: status.has_baseline,
          entryDigest,
          features: Object.fromEntries(Object.entries(status.features).map(([feature, value]) => [feature, {
            state: value.state,
            details: value.details ?? [],
          }])),
        })
      }
      return loaded
    },
    async applyTargets({ binary, targetFeatures, entryDigest }) {
      return apply(binary, targetFeatures, entryDigest)
    },
  }
}