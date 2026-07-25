import { afterEach, describe, expect, test } from 'bun:test'
import { access, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const repositoryRoot = path.resolve(import.meta.dir, '../..')
const goldenPath = path.join(repositoryRoot, 'contract/golden/claude-v1/synthetic-2.1.175-clean.bin')
const runners = {
  js: ['bun', path.join(import.meta.dir, 'js-transaction-runner.mjs')],
  python: ['python3', path.join(import.meta.dir, 'python-transaction-runner.py')],
}
const temporaryRoots = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unbun-store-interop-'))
  temporaryRoots.push(root)
  const binary = path.join(root, '2.1.175')
  const store = path.join(root, 'store')
  await writeFile(binary, await readFile(goldenPath), { mode: 0o751 })
  return { binary, store }
}

function replaceVersion(bytes, version) {
  const replaced = Buffer.from(bytes.toString('latin1').replace('VERSION:"2.1.175"', `VERSION:"${version}"`), 'latin1')
  expect(replaced).not.toEqual(bytes)
  expect(replaced.length).toBe(bytes.length)
  return replaced
}

async function waitForPath(candidate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await access(candidate)
      return
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      await Bun.sleep(10)
    }
  }
  throw new Error(`timed out waiting for ${candidate}`)
}

async function run(implementation, request) {
  const process = Bun.spawn(runners[implementation], {
    cwd: repositoryRoot,
    env: { ...Bun.env, UNBUN_CC_STORE: request.store },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  process.stdin.write(JSON.stringify(request))
  process.stdin.end()
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ])
  expect(stderr).toBe('')
  expect(stdout.trim().split('\n')).toHaveLength(1)
  const result = JSON.parse(stdout)
  expect(exitCode).toBe(result.ok ? 0 : result.exit)
  return result
}

for (const [producer, consumer] of [['js', 'python'], ['python', 'js']]) {
  describe(`${producer} snapshot producer`, () => {
    test(`${consumer} lists, restores, and removes the same asset`, async () => {
      const context = await fixture()
      const write = await run(producer, { action: 'write-features', ...context, features: ['agent-model'] })
      expect(write.ok).toBe(true)
      const snapshotBytes = await readFile(context.binary)
      const snapshot = await run(producer, { action: 'snapshot-save', ...context, snapshot: 'shared' })
      expect(snapshot).toMatchObject({ ok: true, action: 'snapshot-save' })

      expect((await run(consumer, { action: 'snapshot-list', ...context })).snapshots).toEqual([
        { slug: 'shared', version: '2.1.175', invalid: false },
      ])

      await run(consumer, { action: 'write-features', ...context, features: [] })
      const restored = await run(consumer, { action: 'snapshot-restore', ...context, snapshot: 'shared' })
      expect(restored).toMatchObject({ ok: true, states: { 'agent-model': 'patched' } })
      expect(await readFile(context.binary)).toEqual(snapshotBytes)

      const removed = await run(consumer, { action: 'snapshot-rm', ...context, snapshot: 'shared' })
      expect(removed.ok).toBe(true)
      expect((await run(producer, { action: 'snapshot-list', ...context })).snapshots).toEqual([])
      expect(removed.storeTree).toEqual((await run(producer, { action: 'inspect-store', ...context })).storeTree)
    })

    test('force replaces the active same-version manifest and retains content-addressed blobs', async () => {
      const context = await fixture()
      const first = await run(producer, { action: 'snapshot-save', ...context, snapshot: 'forced' })
      expect(first.ok).toBe(true)
      await run(consumer, { action: 'write-features', ...context, features: ['agent-model'] })
      const beforeRejectedSave = await run(consumer, { action: 'inspect-store', ...context })
      const activeManifestBefore = beforeRejectedSave.storeTree.find((entry) => entry.path.endsWith('/forced/snapshot.json'))

      const rejected = await run(producer, { action: 'snapshot-save', ...context, snapshot: 'forced' })
      expect(rejected).toMatchObject({ ok: false, code: 'snapshot_exists', exit: 1 })
      const afterRejectedSave = await run(consumer, { action: 'inspect-store', ...context })
      expect(afterRejectedSave.storeTree.find((entry) => entry.path.endsWith('/forced/snapshot.json'))).toEqual(activeManifestBefore)
      expect(afterRejectedSave.storeTree.filter((entry) => !entry.path.includes('/blobs/'))).toEqual(beforeRejectedSave.storeTree.filter((entry) => !entry.path.includes('/blobs/')))

      const forced = await run(producer, { action: 'snapshot-save', ...context, snapshot: 'forced', force: true })
      expect(forced.ok).toBe(true)
      const blobPaths = forced.storeTree.filter((entry) => entry.path.includes('/snapshots/') && entry.path.includes('/blobs/'))
      expect(blobPaths).toHaveLength(2)
      expect(new Set(blobPaths.map((entry) => entry.sha256)).size).toBe(2)
      expect(forced.storeTree).toEqual((await run(consumer, { action: 'inspect-store', ...context })).storeTree)
    })

    test('keeps the same slug independently addressable across constructed versions', async () => {
      const context = await fixture()
      const clean175 = await readFile(context.binary)
      await run(producer, { action: 'snapshot-save', ...context, snapshot: 'cross-version' })
      await writeFile(context.binary, replaceVersion(clean175, '2.1.176'), { mode: 0o751 })
      await run(consumer, { action: 'snapshot-save', ...context, snapshot: 'cross-version' })

      expect((await run(producer, { action: 'snapshot-list', ...context })).snapshots).toEqual([
        { slug: 'cross-version', version: '2.1.175', invalid: false },
        { slug: 'cross-version', version: '2.1.176', invalid: false },
      ])

      await writeFile(context.binary, replaceVersion(clean175, '2.1.177'), { mode: 0o751 })
      const ambiguous = await run(consumer, { action: 'snapshot-restore', ...context, snapshot: 'cross-version' })
      expect(ambiguous).toMatchObject({ ok: false, code: 'snapshot_ambiguous', exit: 1 })
      expect(await readFile(context.binary)).toEqual(replaceVersion(clean175, '2.1.177'))

      const restored = await run(consumer, {
        action: 'snapshot-restore',
        ...context,
        snapshot: 'cross-version',
        version: '2.1.175',
        force: true,
      })
      expect(restored).toMatchObject({ ok: true })
      expect(await readFile(context.binary)).toEqual(clean175)
    })

    test('both readers report an invalid active manifest without changing binary or blobs', async () => {
      const context = await fixture()
      const saved = await run(producer, { action: 'snapshot-save', ...context, snapshot: 'invalid' })
      const binaryBefore = await readFile(context.binary)
      const manifest = saved.storeTree.find((entry) => entry.path.endsWith('/invalid/snapshot.json'))
      const blob = saved.storeTree.find((entry) => entry.path.includes('/invalid/blobs/'))
      expect(manifest).toBeDefined()
      expect(blob).toBeDefined()
      await writeFile(path.join(context.store, 'v1', manifest.path), '{invalid-json}\n')

      const producerView = await run(producer, { action: 'snapshot-list', ...context })
      const consumerView = await run(consumer, { action: 'snapshot-list', ...context })
      expect(producerView.snapshots).toEqual([{ slug: 'invalid', version: '2.1.175', invalid: true }])
      expect(consumerView.snapshots).toEqual(producerView.snapshots)
      expect(consumerView.storeTree).toEqual(producerView.storeTree)
      expect(producerView.storeTree.find((entry) => entry.path === blob.path)).toEqual(blob)
      expect(await readFile(context.binary)).toEqual(binaryBefore)
    })

    test('both readers ignore an orphan blob while preserving its exact hash', async () => {
      const context = await fixture()
      const saved = await run(producer, { action: 'snapshot-save', ...context, snapshot: 'orphan' })
      const binaryBefore = await readFile(context.binary)
      const manifest = saved.storeTree.find((entry) => entry.path.endsWith('/orphan/snapshot.json'))
      const blob = saved.storeTree.find((entry) => entry.path.includes('/orphan/blobs/'))
      expect(manifest).toBeDefined()
      expect(blob).toBeDefined()
      await unlink(path.join(context.store, 'v1', manifest.path))

      const producerView = await run(producer, { action: 'snapshot-list', ...context })
      const consumerView = await run(consumer, { action: 'snapshot-list', ...context })
      expect(producerView.snapshots).toEqual([])
      expect(consumerView.snapshots).toEqual([])
      expect(consumerView.storeTree).toEqual(producerView.storeTree)
      expect(producerView.storeTree.find((entry) => entry.path === blob.path)).toEqual(blob)
      expect(await readFile(context.binary)).toEqual(binaryBefore)
    })
  })
}

for (const [holder, contender] of [['js', 'python'], ['python', 'js']]) {
  test(`${holder} live mkdir lock blocks ${contender} without changing binary or store assets`, async () => {
    const context = await fixture()
    await run(holder, { action: 'write-features', ...context, features: [] })
    const release = `${context.binary}.release-lock`
    const holderProcess = Bun.spawn(runners[holder], {
      cwd: repositoryRoot,
      env: { ...Bun.env, UNBUN_CC_STORE: context.store },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    holderProcess.stdin.write(JSON.stringify({ action: 'lock-hold', ...context, release }))
    holderProcess.stdin.end()
    const beforeBinary = await readFile(context.binary)
    const beforeAssets = (await run(contender, { action: 'inspect-store', ...context })).storeTree.filter((entry) => !entry.path.endsWith('/write.lock/owner.json'))
    const target = beforeAssets.find((entry) => entry.path.endsWith('/target.json')).path.split('/target.json')[0]
    await waitForPath(path.join(context.store, 'v1', target, 'write.lock', 'owner.json'))

    const blocked = await run(contender, { action: 'write-features', ...context, features: ['agent-model'] })
    expect(blocked).toMatchObject({ ok: false, code: 'target_locked', exit: 1 })
    expect(await readFile(context.binary)).toEqual(beforeBinary)
    expect((await run(contender, { action: 'inspect-store', ...context })).storeTree.filter((entry) => !entry.path.endsWith('/write.lock/owner.json'))).toEqual(beforeAssets)

    await writeFile(release, '')
    const [holderExit, holderStdout, holderStderr] = await Promise.all([
      holderProcess.exited,
      new Response(holderProcess.stdout).text(),
      new Response(holderProcess.stderr).text(),
    ])
    expect(holderExit).toBe(0)
    expect(holderStderr).toBe('')
    expect(JSON.parse(holderStdout)).toMatchObject({ ok: true, action: 'lock-hold' })
  })
}

for (const cleaner of ['js', 'python']) {
  test(`${cleaner} only removes an unknown-owner stale lock with explicit force`, async () => {
    const context = await fixture()
    const initial = await run(cleaner === 'js' ? 'python' : 'js', { action: 'write-features', ...context, features: [] })
    const target = initial.storeTree.find((entry) => entry.path.endsWith('/target.json')).path.split('/target.json')[0]
    const lockDirectory = path.join(context.store, 'v1', target, 'write.lock')
    await mkdir(lockDirectory)
    await writeFile(path.join(lockDirectory, 'owner.json'), '{not-json}\n')
    const binaryBefore = await readFile(context.binary)
    const treeBefore = (await run(cleaner, { action: 'inspect-store', ...context })).storeTree

    const refused = await run(cleaner, { action: 'lock-cleanup', ...context })
    expect(refused).toMatchObject({ ok: false, code: 'target_locked', exit: 1 })
    expect(await readFile(context.binary)).toEqual(binaryBefore)
    expect((await run(cleaner, { action: 'inspect-store', ...context })).storeTree).toEqual(treeBefore)

    const cleaned = await run(cleaner, { action: 'lock-cleanup', ...context, force: true })
    expect(cleaned).toMatchObject({ ok: true, action: 'lock-cleanup' })
    await expect(access(lockDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  })
}