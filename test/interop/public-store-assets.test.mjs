import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { PUBLIC_CLI_BOUNDARIES, runCli } from './cli-harness.mjs'

const repositoryRoot = path.resolve(import.meta.dir, '../..')
const goldenPath = path.join(repositoryRoot, 'contract/golden/claude-v1/synthetic-2.1.175-clean.bin')
const temporaryRoots = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unbun-public-snapshot-'))
  temporaryRoots.push(root)
  const binary = path.join(root, 'claude')
  const store = path.join(root, 'store')
  const original = await readFile(goldenPath)
  await writeFile(binary, original, { mode: 0o751 })
  return { root, binary, store, original }
}

async function invoke(implementation, context, args, expectedExit = 0) {
  const result = await runCli(PUBLIC_CLI_BOUNDARIES[implementation], {
    args,
    env: { UNBUN_CC_STORE: context.store },
  })
  expect(result.exitCode, result.stderr).toBe(expectedExit)
  return result.output
}

function patchArgs(binary, action, features = []) {
  return [action, '--binary', binary, ...features.flatMap((feature) => ['--feature', feature]), '--json']
}

function snapshotArgs(implementation, binary, action, slug, extra = []) {
  const json = implementation === 'python' ? ['--json'] : []
  const trailingJson = implementation === 'javascript' ? ['--json'] : []
  if (action === 'restore') return [...json, 'revert', '--binary', binary, '--snapshot', slug, ...extra, ...trailingJson]
  const args = ['snapshot', action]
  if (slug !== null) args.push(slug)
  return [...json, ...args, '--binary', binary, ...extra, ...trailingJson]
}

async function snapshotBlobs(store, slug) {
  const found = []
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch((error) => {
      if (error.code === 'ENOENT') return []
      throw error
    })) {
      const candidate = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(candidate)
      else if (candidate.includes(`${path.sep}${slug}${path.sep}blobs${path.sep}`)) found.push(candidate)
    }
  }
  await visit(store)
  return found.sort()
}

describe('public CLI cross-language snapshot assets', () => {
  for (const [producer, consumer] of [['javascript', 'python'], ['python', 'javascript']]) {
    test(`${producer} saves and ${consumer} lists, restores, and removes`, async () => {
      const context = await fixture()
      await invoke(producer, context, patchArgs(context.binary, 'patch', ['agent-model']))
      const snapshotBytes = await readFile(context.binary)
      const saved = await invoke(producer, context, snapshotArgs(producer, context.binary, 'save', 'shared'))
      expect(saved).toMatchObject({ success: true, action: 'snapshot-save', errors: [] })

      const listed = await invoke(consumer, context, snapshotArgs(consumer, context.binary, 'list', null))
      expect(listed.snapshots).toEqual([
        { binary: context.binary, slug: 'shared', version: '2.1.175', invalid: false },
      ])

      await invoke(consumer, context, patchArgs(context.binary, 'revert'))
      expect(await readFile(context.binary)).toEqual(context.original)
      const restored = await invoke(consumer, context, snapshotArgs(consumer, context.binary, 'restore', 'shared'))
      expect(restored).toMatchObject({ success: true, action: 'snapshot-restore', errors: [] })
      expect(await readFile(context.binary)).toEqual(snapshotBytes)

      const removed = await invoke(consumer, context, snapshotArgs(consumer, context.binary, 'rm', 'shared'))
      expect(removed).toMatchObject({ success: true, action: 'snapshot-rm', errors: [] })
      expect((await invoke(producer, context, snapshotArgs(producer, context.binary, 'list', null))).snapshots).toEqual([])
    }, 30_000)

    test(`${producer} force-activates a replacement manifest consumed by ${consumer}`, async () => {
      const context = await fixture()
      await invoke(producer, context, snapshotArgs(producer, context.binary, 'save', 'forced'))
      await invoke(consumer, context, patchArgs(context.binary, 'patch', ['agent-model']))
      const replacementBytes = await readFile(context.binary)

      const rejected = await invoke(producer, context, snapshotArgs(producer, context.binary, 'save', 'forced'), 1)
      expect(rejected).toMatchObject({ success: false, errors: [{ code: 'snapshot_exists' }] })

      const forced = await invoke(producer, context, snapshotArgs(producer, context.binary, 'save', 'forced', ['--force']))
      expect(forced).toMatchObject({ success: true, action: 'snapshot-save', errors: [] })
      expect(await snapshotBlobs(context.store, 'forced')).toHaveLength(2)

      await invoke(consumer, context, patchArgs(context.binary, 'revert'))
      await invoke(consumer, context, snapshotArgs(consumer, context.binary, 'restore', 'forced'))
      expect(await readFile(context.binary)).toEqual(replacementBytes)
    }, 30_000)
  }
})
