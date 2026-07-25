import { closeFeatures } from '../core/dependencies.mjs'
import { claudeFeatureRegistry } from '../targets/claude/index.mjs'

function closeTargets(features) {
  return closeFeatures(claudeFeatureRegistry, features)
}

function targetRows(group) {
  return group.rows.filter((row) => row.selectable && row.target).map((row) => row.feature)
}

function currentTargets(group) {
  return group.rows.filter((row) => row.selectable && row.state === 'patched').map((row) => row.feature)
}

function sameFeatures(left, right) {
  return left.length === right.length && left.every((feature, index) => feature === right[index])
}

export function createTuiState(binaries) {
  if (!Array.isArray(binaries)) throw new TypeError('loadRows must return an array')
  return {
    groups: binaries.map((binary, groupIndex) => ({
      path: binary.path,
      version: binary.version,
      hasBaseline: binary.hasBaseline === true,
      entryDigest: binary.entryDigest,
      rows: claudeFeatureRegistry.topologicalNames().map((feature) => {
        const status = binary.features?.[feature] ?? { state: 'unsupported', details: ['missing_feature_status'] }
        return {
          id: `${groupIndex}:${feature}`,
          path: binary.path,
          version: binary.version,
          feature,
          state: status.state,
          details: status.details ?? [],
          selectable: status.state !== 'unsupported',
          target: status.state === 'patched' || status.state === 'mixed',
        }
      }),
    })),
  }
}

export function visibleRows(state, filter = '') {
  const tokens = filter.trim().toLowerCase().split(/\s+/).filter(Boolean)
  return state.groups.flatMap((group) => group.rows).filter((row) => {
    const haystack = `${row.path} ${row.version} ${row.feature} ${row.state}`.toLowerCase()
    return tokens.every((token) => haystack.includes(token))
  })
}

export function toggleRow(state, rowId) {
  const selected = state.groups.flatMap((group) => group.rows).find((row) => row.id === rowId)
  if (!selected?.selectable) return state
  return {
    groups: state.groups.map((group) => ({
      ...group,
      rows: group.rows.map((row) => row.id === rowId ? { ...row, target: !row.target } : row),
    })),
  }
}

export function toggleAllVisible(state, filter = '') {
  const actionable = visibleRows(state, filter).filter((row) => row.selectable)
  if (actionable.length === 0) return state
  const ids = new Set(actionable.map((row) => row.id))
  const target = actionable.some((row) => !row.target)
  return {
    groups: state.groups.map((group) => ({
      ...group,
      rows: group.rows.map((row) => ids.has(row.id) ? { ...row, target } : row),
    })),
  }
}

export function planTargets(state) {
  const plans = []
  for (const group of state.groups) {
    const targetFeatures = closeTargets(targetRows(group))
    const currentFeatures = closeTargets(currentTargets(group))
    const mixed = group.rows.some((row) => row.selectable && row.state === 'mixed')
    if (sameFeatures(targetFeatures, currentFeatures) && !mixed) continue
    const selectedMixed = group.rows.some((row) => row.state === 'mixed' && row.target)
    plans.push({
      binary: group.path,
      targetFeatures,
      entryDigest: group.entryDigest,
      kind: mixed ? selectedMixed ? 'replay-mixed' : 'revert-mixed' : targetFeatures.length === 0 ? 'revert-all' : 'patch',
    })
  }
  return plans
}

export function planLabel(plan) {
  if (plan.kind === 'replay-mixed') return `replay mixed -> [${plan.targetFeatures.join(',')}]`
  if (plan.kind === 'revert-mixed') return `revert mixed -> [${plan.targetFeatures.join(',')}]`
  if (plan.kind === 'revert-all') return 'revert all'
  return `patch[${plan.targetFeatures.join(',')}]`
}