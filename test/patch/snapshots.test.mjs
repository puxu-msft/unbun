import { describe, expect, test } from 'bun:test'
import { appendFile, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { closeFeatures } from '../../lib/patch/core/dependencies.mjs'
import { sha256 } from '../../lib/patch/store/manifests.mjs'
import { claudeFeatureRegistry } from '../../lib/patch/targets/claude/index.mjs'
import {
  listSnapshots,
  removeSnapshot,
  restoreSnapshot,
  saveSnapshot,
} from '../../lib/patch/transaction/snapshots.mjs'
import { enabledMatrix } from './platform-matrix-fixture.mjs'

// 演练 macOS restore 内部（codesign/签名漂移）需注入 enabled macos matrix；生产 gate 仍 fail-closed。
const MACOS_ENABLED = enabledMatrix('macos')

const clean = await readFile(new URL('../../contract/golden/claude-v1/synthetic-2.1.175-clean.bin', import.meta.url))
const pathKey = 'b'.repeat(64)

function applyFeatures(requested) {
  let bytes = Buffer.from(clean)
  for (const name of closeFeatures(claudeFeatureRegistry, requested)) bytes = claudeFeatureRegistry.get(name).apply(bytes).bytes
  return bytes
}

function inspect(bytes) {
  const match = bytes.toString('latin1').match(/overview",VERSION:"([0-9.]+)"/)
  return {
    embeddedVersion: match?.[1] ?? null,
    states: Object.fromEntries(claudeFeatureRegistry.features().map((feature) => [feature.name, feature.detect(bytes).state])),
  }
}

async function fixture(features = ['agent-model']) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unbun-snapshot-'))
  const binaryPath = path.join(root, '2.1.175')
  await writeFile(binaryPath, applyFeatures(features), { mode: 0o751 })
  const events = []
  const lock = {
    acquire: async () => { events.push('lock'); return { token: 'snapshot-lock' } },
    release: async () => { events.push('unlock') },
  }
  return { root, binaryPath, targetDirectory: path.join(root, pathKey), pathKey, inspect, lock, events }
}

describe('v1 named snapshots', () => {
  test('saves, validates, lists, force-replaces, and removes only the active manifest', async () => {
    const input = await fixture(['agent-model'])
    const saved = await saveSnapshot({ ...input, slug: 'before-change', now: () => new Date('2026-07-23T12:34:56.000Z') })
    expect(saved.manifest).toMatchObject({
      schema: 'unbun.cc.snapshot', slug: 'before-change', embedded_version: '2.1.175', path_key: pathKey,
      observed_states: { 'source-exec': 'clean', 'agent-model': 'patched', channels: 'clean' },
    })
    expect(input.events).toEqual(['lock', 'unlock'])
    expect((await listSnapshots({ ...input })).map((item) => item.manifest.slug)).toEqual(['before-change'])
    await expect(saveSnapshot({ ...input, slug: 'before-change' })).rejects.toMatchObject({ code: 'snapshot_exists' })

    await writeFile(input.binaryPath, applyFeatures(['channels']))
    const replaced = await saveSnapshot({ ...input, slug: 'before-change', force: true })
    expect(replaced).toMatchObject({ created: false, replaced: true })
    const removed = await removeSnapshot({ ...input, slug: 'before-change', currentVersion: '2.1.175' })
    expect(removed.manifestRemoved).toBe(true)
    expect(await listSnapshots({ ...input })).toEqual([])
    expect((await readdir(path.join(input.targetDirectory, 'snapshots', '2.1.175', 'before-change', 'blobs'))).length).toBeGreaterThan(0)
  })

  test('restores through entry re-read, atomic replace, postverify, and exact mode preservation', async () => {
    const input = await fixture(['agent-model'])
    await saveSnapshot({ ...input, slug: 'agent-only' })
    await writeFile(input.binaryPath, applyFeatures(['channels']), { mode: 0o751 })
    const entry = await readFile(input.binaryPath)
    const result = await restoreSnapshot({ ...input, slug: 'agent-only', entryDigest: sha256(entry) })
    expect(result).toMatchObject({ restored: true, embeddedVersion: '2.1.175' })
    expect(await readFile(input.binaryPath)).toEqual(applyFeatures(['agent-model']))
    expect((await stat(input.binaryPath)).mode & 0o777).toBe(0o751)
  })

  test('requires confirmation for a cross-version restore and rejects stale entry digest', async () => {
    const input = await fixture([])
    await saveSnapshot({ ...input, slug: 'current' })
    const staleDigest = '0'.repeat(64)
    await expect(restoreSnapshot({ ...input, slug: 'current', entryDigest: staleDigest })).rejects.toMatchObject({ code: 'concurrent_binary_change' })

    const oldBytes = Buffer.from(clean.toString('latin1').replace('VERSION:"2.1.175"', 'VERSION:"2.1.174"'), 'latin1')
    const selected = {
      manifest: { embedded_version: '2.1.174', observed_states: inspect(clean).states },
      bytes: oldBytes,
    }
    await expect(restoreSnapshot({ ...input, slug: 'old', select: async () => selected })).rejects.toMatchObject({ code: 'snapshot_invalid' })
    await expect(restoreSnapshot({ ...input, slug: 'old', select: async () => selected, confirmVersionChange: true })).resolves.toMatchObject({ restored: true })
  })

  test('codesigns macOS restores, accepts signature drift, and rolls entry bytes back on failure', async () => {
    const input = await fixture(['agent-model'])
    await saveSnapshot({ ...input, slug: 'agent-only' })
    await writeFile(input.binaryPath, applyFeatures(['channels']), { mode: 0o751 })
    const entry = await readFile(input.binaryPath)
    const restored = await restoreSnapshot({
      ...input,
      slug: 'agent-only',
      entryDigest: sha256(entry),
      platform: 'darwin',
      matrix: MACOS_ENABLED,
      codesign: async (binaryPath) => appendFile(binaryPath, 'ADHOC-SIGNATURE'),
    })
    expect(restored).toMatchObject({ restored: true, resigned: true })
    expect((await readFile(input.binaryPath)).subarray(-15).toString()).toBe('ADHOC-SIGNATURE')

    await writeFile(input.binaryPath, entry, { mode: 0o751 })
    await expect(restoreSnapshot({
      ...input,
      slug: 'agent-only',
      entryDigest: sha256(entry),
      platform: 'darwin',
      matrix: MACOS_ENABLED,
      codesign: async () => { throw new Error('sign failed') },
    })).rejects.toMatchObject({ code: 'codesign_failed', exitCode: 3 })
    expect(await readFile(input.binaryPath)).toEqual(entry)

    await expect(restoreSnapshot({
      ...input,
      slug: 'agent-only',
      entryDigest: sha256(entry),
      platform: 'darwin',
      matrix: MACOS_ENABLED,
      codesign: async (binaryPath) => {
        const restoredBytes = await readFile(binaryPath)
        await writeFile(binaryPath, claudeFeatureRegistry.get('agent-model').reverse(restoredBytes).bytes, { mode: 0o751 })
      },
    })).rejects.toMatchObject({ code: 'content_mismatch', exitCode: 2 })
    expect(await readFile(input.binaryPath)).toEqual(entry)
  })
})