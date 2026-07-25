import { describe, expect, test } from 'bun:test'
import { appendFile, chmod, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { closeFeatures } from '../../lib/patch/core/dependencies.mjs'
import { createAtomicWriteAdapter } from '../../lib/patch/transaction/atomic-write.mjs'
import { StoreError, sha256 } from '../../lib/patch/store/manifests.mjs'
import { claudeFeatureRegistry } from '../../lib/patch/targets/claude/index.mjs'
import { runPatchTransaction } from '../../lib/patch/transaction/transaction.mjs'
import { enabledMatrix } from './platform-matrix-fixture.mjs'

// 演练 macOS 写内部（codesign/签名漂移）需注入 enabled macos matrix；生产 gate 仍 fail-closed。
const MACOS_ENABLED = enabledMatrix('macos')

const clean = await readFile(new URL('../../contract/golden/claude-v1/synthetic-2.1.175-clean.bin', import.meta.url))

function applyFeatures(requested) {
  let bytes = Buffer.from(clean)
  for (const name of closeFeatures(claudeFeatureRegistry, requested)) bytes = claudeFeatureRegistry.get(name).apply(bytes).bytes
  return bytes
}

function inspect(bytes) {
  return {
    embeddedVersion: '2.1.175',
    states: Object.fromEntries(claudeFeatureRegistry.features().map((feature) => [feature.name, feature.detect(bytes).state])),
  }
}

async function transactionFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unbun-transaction-fault-'))
  const binaryPath = path.join(root, '2.1.175')
  await writeFile(binaryPath, clean, { mode: 0o751 })
  return { root, binaryPath, targetDirectory: path.join(root, 'store', 'target') }
}

function transactionInput(input, atomicWrite, overrides = {}) {
  return {
    binaryPath: input.binaryPath,
    targetDirectory: input.targetDirectory,
    requestedFeatures: ['agent-model'],
    entryDigest: sha256(clean),
    baseline: { bytes: clean, manifest: { embedded_version: '2.1.175', size: clean.length, sha256: sha256(clean) } },
    registry: claudeFeatureRegistry,
    inspect,
    platform: 'linux',
    lock: { acquire: async () => ({ token: 'fault-lock' }), release: async () => {} },
    atomicWrite,
    verifyBaseline: async () => ({ accepted: true }),
    ...overrides,
  }
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unbun-atomic-'))
  const binaryPath = path.join(root, '2.1.175')
  const targetDirectory = path.join(root, 'store', 'target')
  await writeFile(binaryPath, 'entry', { mode: 0o751 })
  return { root, binaryPath, targetDirectory, entryBytes: Buffer.from('entry'), resultBytes: Buffer.from('result') }
}

describe('verified atomic binary write', () => {
  test('fsyncs and reads back a same-directory hidden temp with the entry mode', async () => {
    const input = await fixture()
    const events = []
    const writer = createAtomicWriteAdapter({
      syncFile: async (handle) => { events.push('fsync'); await handle.sync() },
      afterTempReadback: async ({ temporaryPath }) => events.push(`readback:${path.basename(temporaryPath)}`),
      beforeReplace: async () => events.push('proof'),
    })
    const result = await writer.publish({ ...input, mode: 0o751, proof: async () => events.push('lineage') })

    expect(await readFile(input.binaryPath)).toEqual(input.resultBytes)
    expect((await stat(input.binaryPath)).mode & 0o777).toBe(0o751)
    expect(events).toEqual([
      'fsync',
      expect.stringMatching(/^readback:\.2\.1\.175\.tmp\./),
      'proof',
      'lineage',
    ])
    expect(result).toMatchObject({ replaced: true, temporaryPath: null })
    expect((await readdir(input.root)).some((name) => name.includes('.bak'))).toBe(false)
  })

  test('rejects temp readback corruption before replace', async () => {
    const input = await fixture()
    const writer = createAtomicWriteAdapter({
      afterTempWrite: async ({ temporaryPath }) => writeFile(temporaryPath, 'corrupt'),
    })
    await expect(writer.publish({ ...input, mode: 0o751 })).rejects.toMatchObject({ code: 'content_mismatch' })
    expect(await readFile(input.binaryPath)).toEqual(input.entryBytes)
  })

  test('re-reads entry and runs proof immediately before replace', async () => {
    const input = await fixture()
    const writer = createAtomicWriteAdapter({
      beforeReplace: async () => writeFile(input.binaryPath, 'updater'),
    })
    await expect(writer.publish({ ...input, mode: 0o751 })).rejects.toMatchObject({ code: 'concurrent_binary_change' })
    expect(await readFile(input.binaryPath, 'utf8')).toBe('updater')
    expect((await readdir(input.root)).some((name) => name.startsWith('.2.1.175.tmp.'))).toBe(false)
  })

  test('moves a ready temp into target quarantine when replace reports binary in use', async () => {
    const input = await fixture()
    const writer = createAtomicWriteAdapter({
      replace: async () => { const error = new Error('busy'); error.code = 'EBUSY'; throw error },
      now: () => new Date('2026-07-23T12:34:56.000Z'),
      uuid: () => '00000000-0000-4000-8000-000000000001',
    })
    await expect(writer.publish({ ...input, mode: 0o751 })).rejects.toMatchObject({
      code: 'binary_in_use',
      exitCode: 3,
      details: { quarantinePath: expect.stringContaining('/quarantine/') },
    })
    expect(await readFile(input.binaryPath)).toEqual(input.entryBytes)
    const quarantineRoot = path.join(input.targetDirectory, 'quarantine')
    const [directory] = await readdir(quarantineRoot)
    expect(await readFile(path.join(quarantineRoot, directory, 'artifact'))).toEqual(input.resultBytes)
    const manifest = JSON.parse(await readFile(path.join(quarantineRoot, directory, 'quarantine.json'), 'utf8'))
    expect(manifest).toMatchObject({ reason: 'binary_in_use', observed_sha256: sha256(input.resultBytes), discovered_by: 'js' })
    expect((await readdir(input.root)).some((name) => name.startsWith('.2.1.175.tmp.'))).toBe(false)
  })

  test('restore atomically reinstates exact entry bytes and mode', async () => {
    const input = await fixture()
    await writeFile(input.binaryPath, input.resultBytes)
    await chmod(input.binaryPath, 0o600)
    const writer = createAtomicWriteAdapter()
    await writer.restore({ binaryPath: input.binaryPath, entryBytes: input.entryBytes, mode: 0o751 })
    expect(await readFile(input.binaryPath)).toEqual(input.entryBytes)
    expect((await stat(input.binaryPath)).mode & 0o777).toBe(0o751)
  })
})

test('StoreError remains the stable fault carrier', () => {
  const error = new StoreError('rollback_failed', 'restore failed', 2)
  expect(error).toMatchObject({ code: 'rollback_failed', exitCode: 2 })
})

describe('transaction rollback boundary', () => {
  test('restores exact entry bytes after post-write verification fails', async () => {
    const input = await transactionFixture()
    const target = applyFeatures(['agent-model'])
    let restored = 0
    const atomicWrite = {
      publish: async ({ binaryPath }) => {
        await writeFile(binaryPath, Buffer.from(target).fill(0, 0, 1))
        return { replaced: true }
      },
      restore: async ({ binaryPath, entryBytes, mode }) => {
        restored += 1
        await writeFile(binaryPath, entryBytes, { mode })
      },
    }
    await expect(runPatchTransaction(transactionInput(input, atomicWrite))).rejects.toMatchObject({ code: 'content_mismatch' })
    expect(restored).toBe(1)
    expect(await readFile(input.binaryPath)).toEqual(clean)
  })

  test('restores entry bytes when injected macOS codesign fails', async () => {
    const input = await transactionFixture()
    const atomicWrite = createAtomicWriteAdapter()
    await expect(runPatchTransaction(transactionInput(input, atomicWrite, {
      platform: 'darwin',
      matrix: MACOS_ENABLED,
      codesign: async () => { throw new Error('sign failed') },
    }))).rejects.toMatchObject({ code: 'codesign_failed', exitCode: 3 })
    expect(await readFile(input.binaryPath)).toEqual(clean)
  })

  test('accepts macOS signature byte drift after feature and normalized lineage postverification', async () => {
    const input = await transactionFixture()
    const verifications = []
    const result = await runPatchTransaction(transactionInput(input, createAtomicWriteAdapter(), {
      platform: 'darwin',
      matrix: MACOS_ENABLED,
      codesign: async (binaryPath) => appendFile(binaryPath, 'ADHOC-SIGNATURE'),
      verifyBaseline: async ({ current }) => verifications.push(current.length),
    }))
    expect(result).toMatchObject({ applied: ['agent-model'], resigned: true })
    expect((await readFile(input.binaryPath)).subarray(-15).toString()).toBe('ADHOC-SIGNATURE')
    expect(verifications).toHaveLength(3)
  })

  test('upgrades a failed restore to rollback_failed and preserves diagnostics', async () => {
    const input = await transactionFixture()
    const atomicWrite = {
      publish: async ({ binaryPath, resultBytes }) => {
        await writeFile(binaryPath, Buffer.from(resultBytes).fill(0, 0, 1))
        return { replaced: true }
      },
      restore: async () => {
        const error = new Error('restore replace failed')
        error.temporaryPath = path.join(input.root, '.2.1.175.tmp.rollback')
        throw error
      },
    }
    await expect(runPatchTransaction(transactionInput(input, atomicWrite))).rejects.toMatchObject({
      code: 'rollback_failed',
      exitCode: 2,
      details: {
        originalCode: 'content_mismatch',
        diagnosticTemporaryPath: expect.stringContaining('.tmp.rollback'),
      },
    })
    expect(await readFile(input.binaryPath)).not.toEqual(clean)
  })

  test('does not restore when replace never happened because the binary is in use', async () => {
    const input = await transactionFixture()
    let restored = 0
    const atomicWrite = {
      publish: async () => { throw new StoreError('binary_in_use', 'busy', 3, { quarantinePath: '/test/quarantine' }) },
      restore: async () => { restored += 1 },
    }
    await expect(runPatchTransaction(transactionInput(input, atomicWrite))).rejects.toMatchObject({ code: 'binary_in_use' })
    expect(restored).toBe(0)
    expect(await readFile(input.binaryPath)).toEqual(clean)
  })

  test('preserves the primary transaction error when lock release also fails', async () => {
    const input = await transactionFixture()
    const primary = new StoreError('content_mismatch', 'primary failure', 2)
    const release = new StoreError('target_locked', 'release failure', 1)
    const lock = {
      acquire: async () => ({ token: 'fault-lock' }),
      release: async () => { throw release },
    }
    const atomicWrite = {
      publish: async () => { throw primary },
      restore: async () => {},
    }
    await expect(runPatchTransaction(transactionInput(input, atomicWrite, { lock }))).rejects.toBe(primary)
    expect(primary.releaseError).toEqual({ code: 'target_locked', message: 'target_locked: release failure' })
  })

  // L3B-02/L3B-10：此前这里断言「成功事务因 release 失败而整体 reject」，把一个缺陷固化成了契约——
  // 事务其实已经把字节写进目标了，却报失败，调用方会误以为没写、进而做出错误的补救动作。
  // 正确语义：写入成功就返回成功结果，release 失败降级为挂在结果上的 releaseError 告警。
  test('surfaces lock release failure as a warning without failing a transaction that already wrote', async () => {
    const input = await transactionFixture()
    const release = new StoreError('target_locked', 'release failure', 1)
    const lock = {
      acquire: async () => ({ token: 'fault-lock' }),
      release: async () => { throw release },
    }
    const result = await runPatchTransaction(transactionInput(input, createAtomicWriteAdapter(), { lock }))

    expect(result).toMatchObject({ applied: ['agent-model'] })
    expect(result.releaseError).toEqual({ code: 'target_locked', message: 'target_locked: release failure' })
    // 字节确实落盘了——这正是不能把它报成失败的原因。
    expect(await readFile(input.binaryPath)).not.toEqual(clean)
  })

  // 反向：主体失败时，release 失败绝不能顶替主体错误（最严重的故障必须可见）。
  test('keeps the primary failure visible when lock release also fails', async () => {
    const input = await transactionFixture()
    const primary = new StoreError('rollback_failed', 'binary left corrupted', 2)
    const release = new StoreError('target_locked', 'release failure', 1)
    const lock = {
      acquire: async () => ({ token: 'fault-lock' }),
      release: async () => { throw release },
    }
    const atomicWrite = { publish: async () => { throw primary }, restore: async () => {} }

    await expect(runPatchTransaction(transactionInput(input, atomicWrite, { lock }))).rejects.toBe(primary)
    expect(primary.releaseError).toEqual({ code: 'target_locked', message: 'target_locked: release failure' })
  })
})