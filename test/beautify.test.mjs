// test/beautify.test.mjs — beautify 必须在 Bun 下完成，不能卡死在 esbuild 同步 worker 路径。
import { test, expect } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultBinary } from '../lib/bun-binary.mjs'

const beautifyFile = new URL('../lib/beautify.mjs', import.meta.url)
const beautifyUrl = beautifyFile.href
const cliUrl = new URL('../cli.mjs', import.meta.url).href

test('beautify 只使用 esbuild 异步 transform API', () => {
  const source = readFileSync(beautifyFile, 'utf8')
  expect(source).toContain('await esbuild.transform(')
  expect(source).not.toContain('esbuild.transformSync(')
})

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
      timer = setTimeout(() => resolve({ timedOut: true }), 10_000)
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
}, 15_000)

test('beautify 失败时等待 strings 关闭后再返回调用者', async () => {
  const root = mkdtempSync(join(tmpdir(), 'unbun-beautify-cleanup-'))
  const binDir = join(root, 'bin')
  const outdir = join(root, 'out')
  const marker = join(root, 'strings-closed')
  const fakeEsbuild = join(root, 'esbuild')
  mkdirSync(binDir)

  const fakeStrings = join(binDir, 'strings')
  writeFileSync(fakeStrings, `#!/bin/sh
trap 'sleep 0.5; : > "$STRINGS_CLOSED_MARKER"; exit 0' TERM
while :; do sleep 1; done
`)
  chmodSync(fakeStrings, 0o755)

  writeFileSync(fakeEsbuild, `#!/usr/bin/env bun
await Bun.sleep(250)
process.exit(9)
`)
  chmodSync(fakeEsbuild, 0o755)

  const script = `
    import { existsSync } from 'node:fs'
    import { runExtract } from ${JSON.stringify(cliUrl)}
    try {
      await runExtract({ bin: ${JSON.stringify(defaultBinary())}, outdir: ${JSON.stringify(outdir)} })
      process.stdout.write('unexpected success')
      process.exitCode = 2
    } catch (error) {
      process.stdout.write((existsSync(${JSON.stringify(marker)}) ? 'closed:' : 'open:') + error.message)
    }
  `

  try {
    const child = Bun.spawn([process.execPath, '-e', script], {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        ESBUILD_BINARY_PATH: fakeEsbuild,
        STRINGS_CLOSED_MARKER: marker,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [code, stdout] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])

    expect(code).toBe(0)
    expect(stdout).toStartWith('closed:')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)

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
