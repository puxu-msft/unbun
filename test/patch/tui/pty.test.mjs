import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'

const root = new URL('../../..', import.meta.url).pathname

function runPty(harness) {
  return spawnSync('uv', ['run', '--with', 'pyte==0.8.2', 'python', harness], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, JS_TUI_BUN: process.execPath },
  })
}

describe('production Ink real PTY', () => {
  test('screen-grid oracle rejects the deliberately overflowing layout', () => {
    const result = runPty('test/pty/js-tui/positive_control.py')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("'RIGHT-EDGE' not found")
  }, 20_000)

  test('passes interaction, layout, trace, and terminal restoration scenarios', () => {
    const result = runPty('test/pty/js-tui/screen_grid.py')
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    expect(result.stderr).toContain('Ran 6 tests')
  }, 40_000)
})
