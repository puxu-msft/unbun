import { randomUUID } from 'node:crypto'
import { hostname as systemHostname } from 'node:os'
import {
  mkdir,
  readFile,
  readdir,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'

import { StoreError, parseManifest, validateManifest } from './manifests.mjs'

function lockDirectory(targetDirectory) {
  return path.join(targetDirectory, 'write.lock')
}

function locked(message) {
  return new StoreError('target_locked', message, 1)
}

export async function inspectTargetLock(targetDirectory) {
  const directory = lockDirectory(targetDirectory)
  let entries
  try {
    entries = await readdir(directory)
  } catch (error) {
    if (error.code === 'ENOENT') return { locked: false, owner: null, ownerKnown: false }
    throw error
  }
  if (!entries.includes('owner.json')) return { locked: true, owner: null, ownerKnown: false }
  try {
    const owner = parseManifest(await readFile(path.join(directory, 'owner.json')), 'lock-owner')
    return { locked: true, owner, ownerKnown: true }
  } catch {
    return { locked: true, owner: null, ownerKnown: false }
  }
}

export async function acquireTargetLock(targetDirectory, {
  token = randomUUID(),
  implementation = 'js',
  pid = process.pid,
  hostname = systemHostname(),
  startedAt = new Date().toISOString(),
  command,
} = {}) {
  if (typeof command !== 'string' || command.length === 0) throw new TypeError('lock command is required')
  await mkdir(targetDirectory, { recursive: true, mode: 0o700 })
  const directory = lockDirectory(targetDirectory)
  try {
    await mkdir(directory, { mode: 0o700 })
  } catch (error) {
    if (error.code === 'EEXIST') throw locked('target write lock already exists')
    throw error
  }
  const owner = {
    schema: 'unbun.cc.lock-owner',
    schema_version: 1,
    token,
    implementation,
    pid,
    hostname,
    started_at: startedAt,
    command,
  }
  try {
    validateManifest('lock-owner', owner)
    await writeFile(path.join(directory, 'owner.json'), `${JSON.stringify(owner, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    return owner
  } catch (error) {
    await rmdir(directory).catch(() => {})
    throw error
  }
}

export async function releaseTargetLock(targetDirectory, token) {
  const directory = lockDirectory(targetDirectory)
  const state = await inspectTargetLock(targetDirectory)
  if (!state.locked) throw locked('target write lock does not exist')
  if (!state.ownerKnown || state.owner.token !== token) throw locked('target write lock token does not match owner')
  const entries = await readdir(directory)
  if (entries.length !== 1 || entries[0] !== 'owner.json') throw locked('target write lock contains unknown entries')
  await unlink(path.join(directory, 'owner.json'))
  await rmdir(directory)
}

export async function cleanupStaleLock(targetDirectory, { force = false } = {}) {
  const directory = lockDirectory(targetDirectory)
  const state = await inspectTargetLock(targetDirectory)
  if (!state.locked) return { removed: false, owner: null }
  if (!force) throw locked('stale lock cleanup requires explicit force')
  const entries = await readdir(directory)
  if (entries.length === 0) {
    await rmdir(directory)
    return { removed: true, owner: null }
  }
  if (entries.length !== 1 || entries[0] !== 'owner.json') throw locked('refusing to remove lock with unknown entries')
  await unlink(path.join(directory, 'owner.json'))
  await rmdir(directory)
  return { removed: true, owner: state.ownerKnown ? state.owner : null }
}