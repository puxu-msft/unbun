import { describe, expect, test } from 'bun:test'

import { createTuiController } from '../../../lib/patch/tui/controller.mjs'

function binary(state = 'clean', digest = 'entry-1') {
  return {
    path: '/tmp/fixture/claude',
    version: '2.1.217',
    hasBaseline: true,
    entryDigest: digest,
    features: {
      'source-exec': { state },
      'agent-model': { state: 'clean' },
      channels: { state: 'clean' },
    },
  }
}

describe('TUI submit lifecycle', () => {
  test('guards a double submit, reports progress, reprobes in place, and permits a second submit', async () => {
    const snapshots = [[binary()], [binary('patched', 'entry-2')], [binary('clean', 'entry-3')]]
    const calls = []
    let release
    const firstApply = new Promise((resolve) => { release = resolve })
    const controller = createTuiController({
      loadRows: async () => snapshots.shift(),
      applyTargets: async (plan) => {
        calls.push(plan)
        if (calls.length === 1) await firstApply
        return { binary: plan.binary, applied: plan.targetFeatures, edits: 1, resigned: false }
      },
    })

    await controller.load()
    controller.toggle('0:source-exec')
    const first = controller.submit()
    expect(controller.snapshot().phase).toBe('applying')
    expect(controller.snapshot().progress).toEqual({ completed: 0, total: 1, succeeded: 0, failed: 0 })
    const duplicate = await controller.submit()
    expect(duplicate).toEqual({ ignored: true, reason: 'busy' })
    expect(calls).toHaveLength(1)

    release()
    await first
    expect(controller.snapshot()).toMatchObject({
      phase: 'done',
      refreshGeneration: 1,
      progress: { completed: 1, total: 1, succeeded: 1, failed: 0 },
    })
    expect(controller.snapshot().state.groups[0].rows[0]).toMatchObject({ state: 'patched', target: true })

    controller.toggle('0:source-exec')
    await controller.submit()
    expect(calls).toHaveLength(2)
    expect(calls[1].targetFeatures).toEqual([])
    expect(controller.snapshot()).toMatchObject({ phase: 'done', refreshGeneration: 2 })
    expect(controller.snapshot().state.groups[0].rows[0]).toMatchObject({ state: 'clean', target: false })
  })

  test('keeps a post-write reprobe failure visible instead of claiming refreshed done state', async () => {
    let loads = 0
    const controller = createTuiController({
      loadRows: async () => {
        if (loads++ > 0) {
          const error = new Error('binary changed before reprobe')
          error.code = 'concurrent_binary_change'
          error.exitCode = 1
          throw error
        }
        return [binary()]
      },
      applyTargets: async (plan) => ({ binary: plan.binary, applied: plan.targetFeatures, edits: 1, resigned: false }),
    })

    await controller.load()
    controller.toggle('0:source-exec')
    const result = await controller.submit()

    expect(result).toMatchObject({ ignored: false, refreshFailed: true })
    expect(controller.snapshot()).toMatchObject({
      phase: 'error',
      refreshGeneration: 0,
      progress: { completed: 1, total: 1, succeeded: 1, failed: 0 },
      errors: [{ code: 'concurrent_binary_change', message: 'binary changed before reprobe', exitCode: 1 }],
    })
    expect(controller.snapshot().state.groups[0].rows[0]).toMatchObject({ state: 'clean' })
  })

  test('merges write and reprobe errors so the highest cross-phase severity survives', async () => {
    let loads = 0
    const controller = createTuiController({
      loadRows: async () => {
        if (loads++ > 0) {
          const error = new Error('reprobe raced')
          error.code = 'concurrent_binary_change'
          error.exitCode = 1
          throw error
        }
        return [binary()]
      },
      applyTargets: async () => {
        const error = new Error('binary is executing')
        error.code = 'binary_in_use'
        error.exitCode = 3
        throw error
      },
    })

    await controller.load()
    controller.toggle('0:source-exec')
    const result = await controller.submit()

    expect(result.refreshFailed).toBe(true)
    expect(controller.snapshot().errors).toEqual([
      { binary: '/tmp/fixture/claude', code: 'binary_in_use', message: 'binary is executing', exitCode: 3 },
      { binary: null, code: 'concurrent_binary_change', message: 'reprobe raced', exitCode: 1 },
    ])
  })

  test('an empty submit after initial probe failure preserves the formal error', async () => {
    const controller = createTuiController({
      loadRows: async () => {
        const error = new Error('fixture cannot be probed')
        error.code = 'version_probe_failed'
        error.exitCode = 1
        throw error
      },
      applyTargets: async () => {},
    })

    await controller.load()
    const result = await controller.submit()
    expect(result).toEqual({ ignored: true, reason: 'error' })
    expect(controller.snapshot()).toMatchObject({
      phase: 'error',
      errors: [{ code: 'version_probe_failed', message: 'fixture cannot be probed', exitCode: 1 }],
    })
  })
})