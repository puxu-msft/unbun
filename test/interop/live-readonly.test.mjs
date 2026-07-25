import { describe, expect, test } from 'bun:test'
import { lstat, readdir, readFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { PUBLIC_CLI_BOUNDARIES, runCli } from './cli-harness.mjs'

const liveBinary = '/home/xp/.local/share/claude/versions/2.1.217'

async function sha256(file) {
  return new Bun.CryptoHasher('sha256').update(await readFile(file)).digest('hex')
}

async function treeSnapshot(root) {
  const entries = []
  let rootMetadata
  try {
    rootMetadata = await lstat(root, { bigint: true })
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, entries }
    throw error
  }
  async function visit(current, relative = '') {
    let names
    try {
      names = await readdir(current)
    } catch (error) {
      if (error.code === 'ENOENT') return
      throw error
    }
    for (const name of names.sort()) {
      const child = path.join(current, name)
      const childRelative = path.join(relative, name)
      const metadata = await lstat(child, { bigint: true })
      if (metadata.isDirectory()) {
        entries.push({ path: `${childRelative}/`, mtimeNs: metadata.mtimeNs.toString() })
        await visit(child, childRelative)
      } else {
        entries.push({
          path: childRelative,
          mtimeNs: metadata.mtimeNs.toString(),
          size: metadata.size.toString(),
          hash: metadata.isFile() ? await sha256(child) : null,
        })
      }
    }
  }
  await visit(root)
  return {
    exists: true,
    mtimeNs: rootMetadata.mtimeNs.toString(),
    entries,
  }
}

function singleStatus(output) {
  return Array.isArray(output) ? output[0] : output
}

function publicStatus(status) {
  return {
    version: status.version,
    size_bytes: status.size_bytes,
    has_baseline: status.has_baseline,
    features: Object.fromEntries(Object.entries(status.features).map(([slug, feature]) => [slug, {
      state: feature.state,
      sites: feature.sites,
      details: feature.details,
      substates: feature.substates,
    }])),
  }
}

describe('current live Claude is read-only', () => {
  test('both public status commands observe three patched features and mutate neither binary nor default store', async () => {
    const defaultStore = process.env.XDG_DATA_HOME
      ? path.join(process.env.XDG_DATA_HOME, 'unbun', 'cc-patch')
      : path.join(os.homedir(), '.local', 'share', 'unbun', 'cc-patch')
    const binaryBefore = { hash: await sha256(liveBinary), stat: await stat(liveBinary, { bigint: true }) }
    const storeBefore = await treeSnapshot(defaultStore)

    const javascript = await runCli(PUBLIC_CLI_BOUNDARIES.javascript, {
      args: ['status', '--binary', liveBinary, '--json'],
      unsetEnv: ['UNBUN_CC_STORE'],
    })
    const python = await runCli(PUBLIC_CLI_BOUNDARIES.python, {
      args: ['--check', '--binary', liveBinary, '--json'],
      unsetEnv: ['UNBUN_CC_STORE'],
    })

    expect(javascript.exitCode, javascript.stderr).toBe(0)
    expect(python.exitCode, python.stderr).toBe(0)
    expect(javascript.stderr).toBe('')
    expect(python.stderr).toBe('')
    const javascriptStatus = singleStatus(javascript.output)
    const pythonStatus = singleStatus(python.output)
    expect(publicStatus(javascriptStatus)).toEqual(publicStatus(pythonStatus))
    expect(javascriptStatus.version).toBe('2.1.217')
    expect(javascriptStatus.has_baseline).toBe(false)
    expect(Object.fromEntries(Object.entries(javascriptStatus.features).map(([slug, feature]) => [slug, feature.state]))).toEqual({
      'source-exec': 'patched',
      'agent-model': 'patched',
      channels: 'patched',
    })

    const binaryAfter = { hash: await sha256(liveBinary), stat: await stat(liveBinary, { bigint: true }) }
    expect(binaryAfter.hash).toBe(binaryBefore.hash)
    expect(binaryAfter.stat.mtimeNs).toBe(binaryBefore.stat.mtimeNs)
    expect(binaryAfter.stat.size).toBe(binaryBefore.stat.size)
    expect(await treeSnapshot(defaultStore)).toEqual(storeBefore)
  }, 60_000)
})