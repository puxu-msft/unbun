// test/patch/platform-gate.test.mjs — L1B-01 回归：production 写 fail-closed 平台 gate。
//
// 不变式：只有 production_write_gate.status === 'enabled' 的平台（当前仅 linux）允许 mutating 写；
//   Windows(disabled-pending-runtime)/macOS(disabled-not-proven) 的写请求必须被拒，且目标二进制字节不变。
//   拒绝走同层平台策略码 platform_write_disabled(exit 1)；未知平台走 platform_write_unsupported(exit 1)。
//   gate 数据驱动于可注入 matrix：生产用 DEFAULT（darwin/win32 disabled），测试可注入 enabled matrix 演练写内部。
import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { assertPlatformWriteEnabled } from '../../lib/patch/store/lineage.mjs'
import { StoreError, sha256 } from '../../lib/patch/store/manifests.mjs'
import { claudeFeatureRegistry } from '../../lib/patch/targets/claude/index.mjs'
import { runPatchTransaction } from '../../lib/patch/transaction/transaction.mjs'

const clean = await readFile(new URL('../../contract/golden/claude-v1/synthetic-2.1.175-clean.bin', import.meta.url))
const DEFAULT_MATRIX = JSON.parse(await readFile(new URL('../../contract/vectors/platform-writes-v1.json', import.meta.url), 'utf8'))

// 深拷贝 DEFAULT，把指定平台 gate 提升为 enabled —— test-only seam，用于演练平台写内部。
function matrixWithEnabled(...platforms) {
  const copy = structuredClone(DEFAULT_MATRIX)
  for (const p of platforms) copy.platforms[p].capabilities.production_write_gate.status = 'enabled'
  return copy
}

function inspect(bytes) {
  return {
    embeddedVersion: '2.1.175',
    states: Object.fromEntries(claudeFeatureRegistry.features().map((f) => [f.name, f.detect(bytes).state])),
  }
}

async function transactionFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unbun-platform-gate-'))
  const binaryPath = path.join(root, '2.1.175')
  await writeFile(binaryPath, clean, { mode: 0o751 })
  return { root, binaryPath, targetDirectory: path.join(root, 'store', 'target') }
}

function transactionInput(input, overrides = {}) {
  return {
    binaryPath: input.binaryPath,
    targetDirectory: input.targetDirectory,
    requestedFeatures: ['agent-model'],
    entryDigest: sha256(clean),
    baseline: { bytes: clean, manifest: { embedded_version: '2.1.175', size: clean.length, sha256: sha256(clean) } },
    registry: claudeFeatureRegistry,
    inspect,
    lock: { acquire: async () => ({ token: 'gate-lock' }), release: async () => {} },
    verifyBaseline: async () => ({ accepted: true }),
    ...overrides,
  }
}

describe('assertPlatformWriteEnabled (pure policy)', () => {
  test('linux (production_write_gate=enabled) 通过并返回 capability', () => {
    const capability = assertPlatformWriteEnabled('linux', DEFAULT_MATRIX)
    expect(capability).toMatchObject({ platform: 'linux', productionWriteGate: 'enabled' })
  })

  test('win32 (disabled-pending-runtime) 抛 platform_write_disabled exit 1', () => {
    expect(() => assertPlatformWriteEnabled('win32', DEFAULT_MATRIX)).toThrow(StoreError)
    try { assertPlatformWriteEnabled('win32', DEFAULT_MATRIX) } catch (e) {
      expect(e).toMatchObject({ code: 'platform_write_disabled', exitCode: 1 })
    }
  })

  test('darwin (disabled-not-proven) 抛 platform_write_disabled exit 1', () => {
    try { assertPlatformWriteEnabled('darwin', DEFAULT_MATRIX); throw new Error('should have thrown') } catch (e) {
      expect(e).toMatchObject({ code: 'platform_write_disabled', exitCode: 1 })
    }
  })

  test('未知平台 fail-closed → platform_write_unsupported exit 1', () => {
    try { assertPlatformWriteEnabled('plan9', DEFAULT_MATRIX); throw new Error('should have thrown') } catch (e) {
      expect(e).toMatchObject({ code: 'platform_write_unsupported', exitCode: 1 })
    }
  })

  test('注入 enabled matrix 后 darwin 通过（test-only seam）', () => {
    expect(assertPlatformWriteEnabled('darwin', matrixWithEnabled('macos'))).toMatchObject({ productionWriteGate: 'enabled' })
  })
})

describe('runPatchTransaction fail-closed 平台 gate', () => {
  for (const platform of ['win32', 'darwin']) {
    test(`${platform}: 用 DEFAULT matrix 的写请求被拒且二进制字节不变`, async () => {
      const input = await transactionFixture()
      await expect(runPatchTransaction(transactionInput(input, { platform }))).rejects.toMatchObject({
        code: 'platform_write_disabled',
        exitCode: 1,
      })
      // 关键：目标二进制未被触碰。
      expect(await readFile(input.binaryPath)).toEqual(clean)
    })
  }

  test('linux: DEFAULT matrix 下正常写入（enabled 平台不受影响）', async () => {
    const input = await transactionFixture()
    const result = await runPatchTransaction(transactionInput(input, { platform: 'linux' }))
    expect(result).toMatchObject({ applied: ['agent-model'] })
    expect(await readFile(input.binaryPath)).not.toEqual(clean)
  })

  test('darwin + 注入 enabled matrix：gate 放行，进入平台写内部（不再被 gate 拦）', async () => {
    const input = await transactionFixture()
    // 注入 enabled macos matrix + darwin 所需 macho normalizer/codesign，验证 gate 不再是拦截点。
    const result = await runPatchTransaction(transactionInput(input, {
      platform: 'darwin',
      matrix: matrixWithEnabled('macos'),
      normalizers: { macho: (b) => b },
      codesign: async () => {},
    }))
    expect(result).toMatchObject({ applied: ['agent-model'] })
  })
})
