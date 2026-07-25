import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { PUBLIC_CLI_BOUNDARIES, runCli } from './cli-harness.mjs'

const repositoryRoot = path.resolve(import.meta.dir, '../..')
const goldenPath = path.join(repositoryRoot, 'contract/golden/claude-v1/synthetic-2.1.175-clean.bin')
const missingEssentialPath = path.join(repositoryRoot, 'contract/vectors/known-bad-v1/fixtures/channels-missing-essential.txt')
const temporaryRoots = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(source = goldenPath) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unbun-cli-differential-'))
  temporaryRoots.push(root)
  const binary = path.join(root, 'claude')
  await writeFile(binary, await readFile(source), { mode: 0o751 })
  return { binary, store: path.join(root, 'store') }
}

function argsFor(implementation, action, binary, extra = []) {
  if (implementation === 'javascript') {
    if (action === 'snapshot-restore') return ['revert', '--snapshot', extra[0], '--binary', binary, '--json']
    if (action.startsWith('snapshot-')) return ['snapshot', action.slice('snapshot-'.length), ...extra, '--binary', binary, '--json']
    return [action, '--binary', binary, ...extra, '--json']
  }
  if (action === 'status') return ['--check', '--binary', binary, '--json']
  if (action === 'snapshot-restore') return ['--json', 'revert', '--snapshot', extra[0], '--binary', binary]
  if (action.startsWith('snapshot-')) return ['--json', 'snapshot', action.slice('snapshot-'.length), ...extra, '--binary', binary]
  return [action, '--binary', binary, ...extra, '--json']
}

async function invoke(implementation, context, action, extra = []) {
  const result = await runCli(PUBLIC_CLI_BOUNDARIES[implementation], {
    args: argsFor(implementation, action, context.binary, extra),
    env: { UNBUN_CC_STORE: context.store },
  })
  expect(result.exitCode, result.stderr).toBe(0)
  return result.output
}

function publicStatus(status) {
  return Object.fromEntries(Object.entries(status.features).map(([feature, observation]) => [feature, {
    state: observation.state,
    sites: observation.sites,
    details: observation.details,
    substates: observation.substates,
  }]))
}

function singleStatus(output) {
  return Array.isArray(output) ? output[0] : output
}

describe('public CLI differential', () => {
  test('matches state, sites, detail codes, and substates for a clean golden', async () => {
    const context = await fixture()
    const env = { UNBUN_CC_STORE: context.store }
    const [javascript, python] = await Promise.all([
      runCli(PUBLIC_CLI_BOUNDARIES.javascript, {
        args: ['status', '--binary', context.binary, '--json'],
        env,
      }),
      runCli(PUBLIC_CLI_BOUNDARIES.python, {
        args: ['--check', '--binary', context.binary, '--json'],
        env,
      }),
    ])

    expect(javascript.exitCode).toBe(0)
    expect(python.exitCode).toBe(0)
    expect(python.output).toHaveLength(1)
    for (const status of [singleStatus(javascript.output), singleStatus(python.output)]) {
      for (const feature of Object.values(status.features)) expect(Array.isArray(feature.substates)).toBe(true)
    }
    expect(publicStatus(singleStatus(javascript.output))).toEqual(publicStatus(singleStatus(python.output)))
  }, 30_000)

  test('matches non-empty detail codes and absent substates for a frozen fault fixture', async () => {
    const context = await fixture(missingEssentialPath)
    const env = { UNBUN_CC_STORE: context.store }
    const [javascript, python] = await Promise.all([
      runCli(PUBLIC_CLI_BOUNDARIES.javascript, {
        args: ['status', '--binary', context.binary, '--json'],
        env,
      }),
      runCli(PUBLIC_CLI_BOUNDARIES.python, {
        args: ['--check', '--binary', context.binary, '--json'],
        env,
      }),
    ])

    expect(javascript.exitCode).toBe(0)
    expect(python.exitCode).toBe(0)
    const javascriptStatus = singleStatus(javascript.output)
    const pythonStatus = singleStatus(python.output)
    expect(javascriptStatus.features.channels.details).toEqual(['channels_essential_site_missing'])
    expect(pythonStatus.features.channels.details).toEqual(['channels_essential_site_missing'])
    expect(publicStatus(javascriptStatus)).toEqual(publicStatus(pythonStatus))
  }, 30_000)

  test('matches substates when channels has no decision site', async () => {
    const context = await fixture()
    await writeFile(context.binary, 'fixture overview",VERSION:"2.1.999" without feature anchors')
    const env = { UNBUN_CC_STORE: context.store }
    const [javascript, python] = await Promise.all([
      runCli(PUBLIC_CLI_BOUNDARIES.javascript, {
        args: ['status', '--binary', context.binary, '--json'],
        env,
      }),
      runCli(PUBLIC_CLI_BOUNDARIES.python, {
        args: ['--check', '--binary', context.binary, '--json'],
        env,
      }),
    ])

    expect(javascript.exitCode).toBe(0)
    expect(python.exitCode).toBe(0)
    expect(publicStatus(singleStatus(javascript.output))).toEqual(publicStatus(singleStatus(python.output)))
  }, 30_000)

  for (const [producer, consumer] of [
    ['javascript', 'python'],
    ['python', 'javascript'],
  ]) {
    test(`${producer} snapshot is listed, restored, and removed by ${consumer}`, async () => {
      const context = await fixture()
      await invoke(producer, context, 'patch', ['--feature', 'agent-model'])
      const snapshotBytes = await readFile(context.binary)

      const saved = await invoke(producer, context, 'snapshot-save', ['shared'])
      expect(saved).toMatchObject({ success: true, action: 'snapshot-save', errors: [] })

      const listed = await invoke(consumer, context, 'snapshot-list')
      expect(listed.snapshots).toEqual([
        { binary: context.binary, slug: 'shared', version: '2.1.175', invalid: false },
      ])

      await invoke(producer, context, 'revert')
      const restored = await invoke(consumer, context, 'snapshot-restore', ['shared'])
      expect(restored).toMatchObject({ success: true, action: 'snapshot-restore', errors: [] })
      expect(await readFile(context.binary)).toEqual(snapshotBytes)

      const removed = await invoke(consumer, context, 'snapshot-rm', ['shared'])
      expect(removed).toMatchObject({ success: true, action: 'snapshot-rm', errors: [] })
      expect((await invoke(producer, context, 'snapshot-list')).snapshots).toEqual([])
    }, 30_000)
  }
})