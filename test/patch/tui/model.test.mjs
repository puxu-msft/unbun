import { describe, expect, test } from 'bun:test'

import {
  createTuiState,
  planTargets,
  toggleAllVisible,
  toggleRow,
  visibleRows,
} from '../../../lib/patch/tui/model.mjs'

const binaries = [
  {
    path: '/opt/claude/stable',
    version: '2.1.217',
    hasBaseline: true,
    entryDigest: 'stable-entry',
    features: {
      'source-exec': { state: 'clean' },
      'agent-model': { state: 'patched' },
      channels: { state: 'mixed' },
    },
  },
  {
    path: '/srv/claude/canary',
    version: '2.1.218',
    hasBaseline: false,
    entryDigest: 'canary-entry',
    features: {
      'source-exec': { state: 'unsupported' },
      'agent-model': { state: 'clean' },
      channels: { state: 'unsupported' },
    },
  },
]

describe('TUI target model', () => {
  test('groups rows by binary and filters by path or feature without dropping hidden targets', () => {
    const state = createTuiState(binaries)
    expect(state.groups).toHaveLength(2)
    expect(state.groups[0].rows.map((row) => [row.feature, row.target])).toEqual([
      ['source-exec', false],
      ['agent-model', true],
      ['channels', true],
    ])

    expect(visibleRows(state, 'stable source').map((row) => row.feature)).toEqual(['source-exec'])
    expect(visibleRows(state, 'channels').map((row) => row.path)).toEqual(['/opt/claude/stable', '/srv/claude/canary'])
    expect(planTargets(state)).toEqual([
      {
        binary: '/opt/claude/stable',
        targetFeatures: ['source-exec', 'agent-model', 'channels'],
        entryDigest: 'stable-entry',
        kind: 'replay-mixed',
      },
    ])
  })

  test('space ignores unsupported and a only changes visible actionable rows', () => {
    let state = createTuiState(binaries)
    const unsupported = visibleRows(state, 'canary source')[0]
    expect(toggleRow(state, unsupported.id)).toBe(state)

    state = toggleAllVisible(state, 'agent-model')
    expect(planTargets(state)).toEqual([
      {
        binary: '/opt/claude/stable',
        targetFeatures: ['source-exec', 'agent-model', 'channels'],
        entryDigest: 'stable-entry',
        kind: 'replay-mixed',
      },
      {
        binary: '/srv/claude/canary',
        targetFeatures: ['agent-model'],
        entryDigest: 'canary-entry',
        kind: 'patch',
      },
    ])
  })

  test('agent-model is independent while channels submits the dependency-closed final target set', () => {
    const clean = createTuiState([{ ...binaries[0], features: {
      'source-exec': { state: 'clean' },
      'agent-model': { state: 'clean' },
      channels: { state: 'clean' },
    } }])
    const agent = toggleRow(clean, '0:agent-model')
    expect(planTargets(agent)[0].targetFeatures).toEqual(['agent-model'])

    const channels = toggleRow(clean, '0:channels')
    expect(planTargets(channels)[0].targetFeatures).toEqual(['source-exec', 'channels'])
  })
})