import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  acquireTargetLock,
  cleanupStaleLock,
  inspectTargetLock,
  releaseTargetLock,
} from '../../../lib/patch/store/lock.mjs'

const temporary = []
afterEach(async () => Promise.all(temporary.splice(0).map((entry) => rm(entry, { recursive: true, force: true }))))

async function targetDirectory() {
  const root = await mkdtemp(path.join(tmpdir(), 'unbun-lock-js-'))
  temporary.push(root)
  return root
}

describe('cooperative target lock', () => {
  test('uses atomic mkdir and reports contention from the frozen store vector', async () => {
    const target = await targetDirectory()
    const owner = await acquireTargetLock(target, { command: 'patch', pid: 123, hostname: 'host' })
    expect(owner.token).toMatch(/^[0-9a-f-]{36}$/)
    await expect(acquireTargetLock(target, { command: 'snapshot' })).rejects.toMatchObject({ code: 'target_locked', exitCode: 1 })
    expect((await inspectTargetLock(target)).owner).toEqual(owner)
    await releaseTargetLock(target, owner.token)
    expect((await inspectTargetLock(target)).locked).toBe(false)
  })

  test('requires the matching owner token to release', async () => {
    const target = await targetDirectory()
    const owner = await acquireTargetLock(target, { command: 'patch' })
    await expect(releaseTargetLock(target, '00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({ code: 'target_locked' })
    expect((await inspectTargetLock(target)).locked).toBe(true)
    await releaseTargetLock(target, owner.token)
  })

  test('treats missing or corrupt owner metadata as a valid unknown lock', async () => {
    const target = await targetDirectory()
    const lockDirectory = path.join(target, 'write.lock')
    await mkdir(lockDirectory)
    expect(await inspectTargetLock(target)).toEqual({ locked: true, owner: null, ownerKnown: false })
    await writeFile(path.join(lockDirectory, 'owner.json'), '{bad json')
    expect(await inspectTargetLock(target)).toEqual({ locked: true, owner: null, ownerKnown: false })
    await expect(cleanupStaleLock(target)).rejects.toMatchObject({ code: 'target_locked' })
    expect(await inspectTargetLock(target)).toMatchObject({ locked: true })
  })

  test('force cleanup removes only empty locks or the sole owner.json', async () => {
    const emptyTarget = await targetDirectory()
    await mkdir(path.join(emptyTarget, 'write.lock'))
    expect(await cleanupStaleLock(emptyTarget, { force: true })).toEqual({ removed: true, owner: null })

    const ownedTarget = await targetDirectory()
    const owner = await acquireTargetLock(ownedTarget, { command: 'patch' })
    expect(await cleanupStaleLock(ownedTarget, { force: true })).toEqual({ removed: true, owner })

    const unknownTarget = await targetDirectory()
    const lockDirectory = path.join(unknownTarget, 'write.lock')
    await mkdir(lockDirectory)
    await writeFile(path.join(lockDirectory, 'unknown'), 'do not delete')
    await expect(cleanupStaleLock(unknownTarget, { force: true })).rejects.toMatchObject({ code: 'target_locked' })
    expect(await readdir(lockDirectory)).toEqual(['unknown'])
  })
})