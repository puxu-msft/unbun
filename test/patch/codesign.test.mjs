import { describe, expect, test } from 'bun:test'

import { createMacOSCodesigner } from '../../lib/patch/transaction/codesign.mjs'

describe('injectable macOS ad-hoc codesign', () => {
  test('removes the old signature before applying an ad-hoc signature', async () => {
    const calls = []
    const codesign = createMacOSCodesigner({
      resolveExecutable: async () => '/usr/bin/codesign',
      run: async (command, args) => { calls.push([command, args]); return { exitCode: 0, stdout: '', stderr: '' } },
    })
    await expect(codesign('/tmp/claude')).resolves.toEqual({ resigned: true })
    expect(calls).toEqual([
      ['/usr/bin/codesign', ['--remove-signature', '/tmp/claude']],
      ['/usr/bin/codesign', ['-s', '-', '/tmp/claude']],
    ])
  })

  test('reports a missing executable and either subprocess failure as codesign_failed', async () => {
    const missing = createMacOSCodesigner({ resolveExecutable: async () => null })
    await expect(missing('/tmp/claude')).rejects.toMatchObject({ code: 'codesign_failed', exitCode: 3 })

    for (const failingCall of [1, 2]) {
      let calls = 0
      const codesign = createMacOSCodesigner({
        resolveExecutable: async () => 'codesign',
        run: async () => ({ exitCode: ++calls === failingCall ? 1 : 0, stdout: '', stderr: 'failed' }),
      })
      await expect(codesign('/tmp/claude')).rejects.toMatchObject({
        code: 'codesign_failed',
        exitCode: 3,
        details: { stage: failingCall === 1 ? 'remove-signature' : 'sign' },
      })
    }
  })
})