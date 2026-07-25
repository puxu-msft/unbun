import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { PUBLIC_CLI_BOUNDARIES, runCli } from './cli-harness.mjs'

const repositoryRoot = path.resolve(import.meta.dir, '../..')
const goldenPath = path.join(repositoryRoot, 'contract/golden/claude-v1/synthetic-2.1.175-clean.bin')
const temporaryRoots = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(label) {
  const root = await mkdtemp(path.join(os.tmpdir(), `unbun-fault-${label}-`))
  temporaryRoots.push(root)
  const binary = path.join(root, 'claude')
  await writeFile(binary, await readFile(goldenPath), { mode: 0o751 })
  return { root, binary, store: path.join(root, 'store') }
}

async function run(implementation, context, args) {
  return runCli(PUBLIC_CLI_BOUNDARIES[implementation], {
    args,
    env: { UNBUN_CC_STORE: context.store },
  })
}

function writeArgs(action, binary, features = []) {
  return [action, '--binary', binary, ...features.flatMap((feature) => ['--feature', feature]), '--json']
}

async function quarantineFiles(store) {
  const targets = path.join(store, 'v1', 'targets')
  const found = []
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch((error) => {
      if (error.code === 'ENOENT') return []
      throw error
    })) {
      const candidate = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(candidate)
      else if (candidate.includes(`${path.sep}quarantine${path.sep}`)) found.push(path.relative(targets, candidate))
    }
  }
  await visit(targets)
  return found.sort()
}

async function singleTargetDirectory(store) {
  const targets = path.join(store, 'v1', 'targets')
  const entries = await readdir(targets, { withFileTypes: true })
  const directories = entries.filter((entry) => entry.isDirectory())
  expect(directories).toHaveLength(1)
  return path.join(targets, directories[0].name)
}

function errorView(result) {
  return {
    exit: result.exitCode,
    success: result.output.success,
    code: result.output.errors[0]?.code,
    results: result.output.results,
  }
}

describe('public CLI transaction faults', () => {
  for (const [producer, consumer] of [
    ['javascript', 'python'],
    ['python', 'javascript'],
  ]) {
    test(`${producer} baseline rejects a same-version different build through ${consumer}`, async () => {
      const context = await fixture(`${producer}-${consumer}-stale-build`)
      expect((await run(producer, context, writeArgs('patch', context.binary, ['agent-model']))).exitCode).toBe(0)
      expect((await run(producer, context, writeArgs('revert', context.binary))).exitCode).toBe(0)

      const altered = Buffer.concat([await readFile(context.binary), Buffer.from([0])])
      await writeFile(context.binary, altered)
      const quarantineBefore = await quarantineFiles(context.store)
      expect(quarantineBefore).toEqual([])

      const rejected = await run(consumer, context, writeArgs('patch', context.binary, ['agent-model']))
      expect(rejected.exitCode).toBe(2)
      expect(rejected.output).toMatchObject({
        success: false,
        exit_code: 2,
        results: [],
        errors: [{ code: 'baseline_stale_build' }],
      })
      expect(await readFile(context.binary)).toEqual(altered)
      expect(await quarantineFiles(context.store)).toEqual(quarantineBefore)
    }, 30_000)
  }

  for (const [producer, consumer] of [
    ['javascript', 'python'],
    ['python', 'javascript'],
  ]) {
    test(`${producer} baseline manifest corruption is rejected through ${consumer}`, async () => {
      const context = await fixture(`${producer}-${consumer}-manifest`)
      expect((await run(producer, context, writeArgs('patch', context.binary, ['agent-model']))).exitCode).toBe(0)
      expect((await run(producer, context, writeArgs('revert', context.binary))).exitCode).toBe(0)
      const binaryBefore = await readFile(context.binary)
      const targetDirectory = await singleTargetDirectory(context.store)
      const manifest = path.join(targetDirectory, 'baselines', '2.1.175', 'baseline.json')
      await writeFile(manifest, '{broken-json\n')
      const quarantineBefore = await quarantineFiles(context.store)
      expect(quarantineBefore).toEqual([])

      const rejected = await run(consumer, context, writeArgs('patch', context.binary, ['agent-model']))
      expect(errorView(rejected)).toEqual({
        exit: 2,
        success: false,
        code: 'baseline_invalid',
        results: [],
      })
      expect(await readFile(context.binary)).toEqual(binaryBefore)
      expect(await quarantineFiles(context.store)).toEqual(quarantineBefore)
    }, 30_000)
  }

  test('both public CLIs observe one occupied lock and the peer cleans it explicitly', async () => {
    const context = await fixture('shared-lock')
    expect((await run('javascript', context, writeArgs('patch', context.binary, ['agent-model']))).exitCode).toBe(0)
    expect((await run('python', context, writeArgs('revert', context.binary))).exitCode).toBe(0)
    const binaryBefore = await readFile(context.binary)
    const lockDirectory = path.join(await singleTargetDirectory(context.store), 'write.lock')
    await mkdir(lockDirectory)
    await writeFile(path.join(lockDirectory, 'owner.json'), '{unknown-owner\n')
    const quarantineBefore = await quarantineFiles(context.store)
    expect(quarantineBefore).toEqual([])

    const javascriptInspection = await run('javascript', context, ['lock', 'inspect', '--binary', context.binary, '--json'])
    const pythonInspection = await run('python', context, ['lock', 'inspect', '--binary', context.binary, '--json'])
    expect(javascriptInspection.exitCode).toBe(0)
    expect(pythonInspection.exitCode).toBe(0)
    expect(javascriptInspection.output).toMatchObject({ locked: true, owner_known: false, owner: null })
    expect(pythonInspection.output).toMatchObject({ locked: true, owner_known: false, owner: null })

    const javascriptBlocked = await run('javascript', context, writeArgs('patch', context.binary, ['channels']))
    const pythonBlocked = await run('python', context, writeArgs('patch', context.binary, ['channels']))
    expect(errorView(javascriptBlocked)).toEqual({ exit: 1, success: false, code: 'target_locked', results: [] })
    expect(errorView(pythonBlocked)).toEqual(errorView(javascriptBlocked))
    expect(await readFile(context.binary)).toEqual(binaryBefore)
    expect(await quarantineFiles(context.store)).toEqual(quarantineBefore)

    const cleaned = await run('python', context, ['lock', 'cleanup', '--binary', context.binary, '--force', '--json'])
    expect(cleaned.exitCode).toBe(0)
    expect(cleaned.output).toMatchObject({ success: true, action: 'lock-cleanup', errors: [] })
    const after = await run('javascript', context, ['lock', 'inspect', '--binary', context.binary, '--json'])
    expect(after.output).toMatchObject({ locked: false, owner_known: false, owner: null })
    expect(await readFile(context.binary)).toEqual(binaryBefore)
  }, 30_000)
})