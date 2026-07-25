import { readFileSync } from 'node:fs'
import path from 'node:path'

import { loadBaseline } from '../store/assets.mjs'
import { lineageSha256 } from '../store/lineage.mjs'
import { inspectClaudeBytes, probeClaudeBinary } from '../targets/claude/probe.mjs'
import { targetContext } from './context.mjs'

const platformMatrix = JSON.parse(readFileSync(new URL('../../../contract/vectors/platform-writes-v1.json', import.meta.url), 'utf8'))

function featureStatus(slug, status) {
  return {
    slug,
    state: status.state,
    details: status.detail_codes,
    sites: status.sites,
    substates: status.substates.map((substate) => ({
      identity: substate.id,
      state: substate.state,
    })),
  }
}

export async function readStatus(binaryPath, { profile = false } = {}) {
  const displayPath = path.resolve(binaryPath)
  const context = await targetContext(displayPath)
  const probe = probeClaudeBinary(displayPath)
  const baseline = await loadBaseline(context.targetDirectory, probe.version, {
    pathKey: context.identity.pathKey,
    inspect: async (bytes) => inspectClaudeBytes(bytes),
    computeLineageSha256: async (bytes) => lineageSha256(bytes, { platform: process.platform, matrix: platformMatrix }),
  })
  const status = {
    schema_version: 1,
    path: displayPath,
    version: probe.version,
    size_bytes: probe.size,
    has_baseline: baseline !== null,
    probe_error: null,
    features: Object.fromEntries(Object.entries(probe.features).map(([slug, value]) => [slug, featureStatus(slug, value)])),
  }
  if (profile) status.profile = { implementation: 'js', ...probe.timing }
  return status
}

export function formatStatus(status) {
  const features = Object.values(status.features).map((feature) => `${feature.slug}=${feature.state}`).join(' ')
  const profile = status.profile
    ? ` implementation=${status.profile.implementation} total_ms=${status.profile.total_ms}`
    : ''
  return `${status.path} ${status.version} ${features}${profile}`
}