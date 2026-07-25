import {describe, expect, test} from 'bun:test'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))

function runPty(extraEnv = {}) {
  return spawnSync('uv', ['run', '--with', 'pyte==0.8.2', 'python', 'tests/test_pty.py'], {
    cwd: root,
    encoding: 'utf8',
    env: {...process.env, POC_BUN: process.execPath, ...extraEnv},
  })
}

describe('Ink real PTY proof', () => {
  test('screen-grid oracle rejects a deliberately overflowing layout', () => {
    const result = runPty({POC_BAD_LAYOUT: '1'})
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("'RIGHT-EDGE' not found")
  }, 15_000)

  test('passes the pyte screen-grid interaction suite', () => {
    const result = runPty()
    expect(result.stderr).toContain('Ran 6 tests')
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
  }, 15_000)
})