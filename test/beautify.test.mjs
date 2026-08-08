// test/beautify.test.mjs — beautify 必须在 Bun 下完成，不能卡死在 esbuild 同步 worker 路径。
import { test, expect } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultBinary } from '../lib/bun-binary.mjs'

const beautifyUrl = new URL('../lib/beautify.mjs', import.meta.url).href
const cliUrl = new URL('../cli.mjs', import.meta.url).href

test('beautify 在 Bun 下及时完成', async () => {
  const script = `
    import { beautify } from ${JSON.stringify(beautifyUrl)}
    const pretty = await beautify('const x=1')
    process.stdout.write(pretty)
  `
  const child = Bun.spawn([process.execPath, '-e', script], {
    stdout: 'pipe',
    stderr: 'pipe',
  })

  let timer
  const result = await Promise.race([
    Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]).then(([code, stdout, stderr]) => ({ code, stdout, stderr, timedOut: false })),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve({ timedOut: true }), 2_000)
    }),
  ])
  clearTimeout(timer)

  if (result.timedOut) {
    child.kill()
    await child.exited
  }

  expect(result).toEqual({
    code: 0,
    stdout: 'const x = 1;\n',
    stderr: '',
    timedOut: false,
  })
}, 5_000)

test('strings 提前失败仍由 runExtract 调用者捕获', async () => {
  const root = mkdtempSync(join(tmpdir(), 'unbun-beautify-error-'))
  const binDir = join(root, 'bin')
  const outdir = join(root, 'out')
  mkdirSync(binDir)
  const fakeStrings = join(binDir, 'strings')
  writeFileSync(fakeStrings, '#!/bin/sh\nexit 7\n')
  chmodSync(fakeStrings, 0o755)

  const script = `
    import { runExtract } from ${JSON.stringify(cliUrl)}
    try {
      await runExtract({ bin: ${JSON.stringify(defaultBinary())}, outdir: ${JSON.stringify(outdir)} })
      process.stdout.write('unexpected success')
      process.exitCode = 2
    } catch (error) {
      process.stdout.write(error.message)
    }
  `

  try {
    const child = Bun.spawn([process.execPath, '-e', script], {
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])

    expect(code).toBe(0)
    expect(stdout).toBe('strings exit 7')
    expect(stderr).not.toContain('Unhandled')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)
