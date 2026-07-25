import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'

import { probeClaudeBinary } from '../../lib/patch/targets/claude/probe.mjs'
import { PUBLIC_CLI_BOUNDARIES, runCli } from './cli-harness.mjs'

const BINARIES = Object.freeze([
  Object.freeze({ label: 'clean 2.1.214', path: '/home/xp/.local/share/claude/versions/2.1.214' }),
  Object.freeze({ label: 'patched 2.1.217', path: '/home/xp/.local/share/claude/versions/2.1.217' }),
])

function publicFeatures(features) {
  return Object.fromEntries(Object.entries(features).map(([name, feature]) => [name, {
    state: feature.state,
    sites: feature.sites,
  }]))
}

describe('live Claude probe differential', () => {
  for (const binary of BINARIES) {
    const liveTest = existsSync(binary.path) ? test : test.skip
    liveTest(`matches Python claude-v1 wire fields for ${binary.label}`, async () => {
      const python = await runCli(PUBLIC_CLI_BOUNDARIES.python, {
        args: ['--check', '--binary', binary.path, '--json'],
      })

      expect(python.exitCode).toBe(0)
      expect(python.stderr).toBe('')
      expect(python.output).toHaveLength(1)

      const javascript = probeClaudeBinary(binary.path)
      expect(javascript.version).toBe(python.output[0].version)
      expect(publicFeatures(javascript.features)).toEqual(publicFeatures(python.output[0].features))
    }, 30_000)
  }
})