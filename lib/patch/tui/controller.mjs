import { createTuiState, planTargets, toggleAllVisible, toggleRow } from './model.mjs'

function initialSnapshot() {
  return {
    phase: 'loading',
    state: createTuiState([]),
    progress: { completed: 0, total: 0, succeeded: 0, failed: 0 },
    outcomes: [],
    errors: [],
    refreshGeneration: 0,
  }
}

function formalError(error, binary = null) {
  return {
    binary,
    code: error?.code ?? 'content_mismatch',
    message: error?.message ?? String(error),
    exitCode: error?.exitCode ?? error?.exit ?? 2,
  }
}

export function createTuiController({ loadRows, applyTargets }) {
  if (typeof loadRows !== 'function' || typeof applyTargets !== 'function') {
    throw new TypeError('loadRows and applyTargets adapters are required')
  }
  let current = initialSnapshot()
  const listeners = new Set()
  const publish = (patch) => {
    current = { ...current, ...patch }
    for (const listener of listeners) listener()
  }

  const controller = {
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    snapshot() {
      return current
    },
    async load({ refresh = false } = {}) {
      publish({ phase: refresh ? 'refreshing' : 'loading', errors: refresh ? current.errors : [] })
      try {
        const binaries = await loadRows()
        publish({
          phase: refresh ? 'done' : 'ready',
          state: createTuiState(binaries),
          refreshGeneration: current.refreshGeneration + (refresh ? 1 : 0),
        })
        return true
      } catch (error) {
        publish({ phase: 'error', errors: [formalError(error)] })
        return false
      }
    },
    toggle(rowId) {
      if (['loading', 'applying', 'refreshing'].includes(current.phase)) return false
      const next = toggleRow(current.state, rowId)
      if (next === current.state) return false
      publish({ state: next, phase: current.phase === 'done' ? 'ready' : current.phase })
      return true
    },
    toggleVisible(filter) {
      if (['loading', 'applying', 'refreshing'].includes(current.phase)) return false
      const next = toggleAllVisible(current.state, filter)
      if (next === current.state) return false
      publish({ state: next, phase: current.phase === 'done' ? 'ready' : current.phase })
      return true
    },
    async submit() {
      if (['loading', 'applying', 'refreshing'].includes(current.phase)) return { ignored: true, reason: 'busy' }
      if (current.phase === 'error') return { ignored: true, reason: 'error' }
      const plans = planTargets(current.state)
      if (plans.length === 0) {
        publish({ phase: 'done', progress: { completed: 0, total: 0, succeeded: 0, failed: 0 }, outcomes: [], errors: [] })
        return { ignored: true, reason: 'empty' }
      }
      let progress = { completed: 0, total: plans.length, succeeded: 0, failed: 0 }
      const outcomes = []
      const errors = []
      publish({ phase: 'applying', progress, outcomes, errors })
      for (const plan of plans) {
        try {
          outcomes.push(await applyTargets(plan))
          progress = { ...progress, completed: progress.completed + 1, succeeded: progress.succeeded + 1 }
        } catch (error) {
          errors.push(formalError(error, plan.binary))
          progress = { ...progress, completed: progress.completed + 1, failed: progress.failed + 1 }
        }
        publish({ progress, outcomes: [...outcomes], errors: [...errors] })
      }
      const refreshed = await controller.load({ refresh: true })
      if (!refreshed) {
        const mergedErrors = [...errors, ...current.errors]
        publish({ progress, outcomes, errors: mergedErrors })
        return { ignored: false, refreshFailed: true, outcomes, errors: mergedErrors }
      }
      publish({ phase: 'done', progress, outcomes, errors })
      return { ignored: false, refreshFailed: false, outcomes, errors }
    },
  }
  return controller
}