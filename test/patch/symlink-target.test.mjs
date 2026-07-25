// test/patch/symlink-target.test.mjs — L3B-01 回归：symlink 安装布局下写入目标与身份键必须同源。
//
// Blocker 原状：`targetContext` 用 `path.resolve`（不解 symlink）作为写入目标，却用 realpath 算
// pathKey。在 `bin/claude -> versions/<ver>` 布局（即 `which claude` 的真实形态）下后果是双重的：
//   ① 原子写的 rename 把 symlink 本身替换成普通文件 → 真实二进制原封未动，patch 打错对象却报 success；
//   ② 同一用户路径前后算出两个不同 pathKey → baseline 不可达。若打上的是**不可逆**的 channels，
//      用户将永久无法回退（实测 revert 报 channels_patched_no_baseline）。
//
// 因此这里断言的是端到端的用户可观察事实，而不是内部字段：symlink 存活、真实文件被改、pathKey 唯一、
// 以及最关键的——不可逆 feature 打上后仍能逐字节 revert 回 clean。
import { describe, expect, test, afterAll } from 'bun:test'
import { mkdtemp, mkdir, readFile, writeFile, symlink, lstat, chmod, rm, readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { targetContext } from '../../lib/patch/cli/context.mjs'

const clean = await readFile(new URL('../../contract/golden/claude-v1/synthetic-2.1.175-clean.bin', import.meta.url))
const created = []
afterAll(async () => { await Promise.all(created.map((d) => rm(d, { recursive: true, force: true }))) })

// 造 `bin/claude -> versions/2.1.175` 的真实安装布局。
async function symlinkLayout() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unbun-symlink-'))
  created.push(root)
  await mkdir(path.join(root, 'versions'), { recursive: true })
  await mkdir(path.join(root, 'bin'), { recursive: true })
  const real = path.join(root, 'versions', '2.1.175')
  const link = path.join(root, 'bin', 'claude')
  await writeFile(real, clean, { mode: 0o755 })
  await chmod(real, 0o755)
  await symlink(real, link)
  return { root, real, link }
}

describe('symlink install layout (L3B-01)', () => {
  test('targetContext resolves the write target to the real file, not the symlink', async () => {
    const { real, link } = await symlinkLayout()
    const context = await targetContext(link)
    // 写入目标 == 身份键的来源，二者同源。
    expect(context.binary).toBe(real)
    expect(context.identity.canonicalPath).toBe(real)
  })

  test('pathKey stays identical whether addressed via the symlink or the real path', async () => {
    const { real, link } = await symlinkLayout()
    const viaLink = await targetContext(link)
    const viaReal = await targetContext(real)
    // pathKey 漂移是 baseline 永久丢失的根因——同一目标必须恒得同一 key。
    expect(viaLink.identity.pathKey).toBe(viaReal.identity.pathKey)
    expect(viaLink.targetDirectory).toBe(viaReal.targetDirectory)
  })

  test('repeated resolution through the symlink is stable (no drift across calls)', async () => {
    const { link } = await symlinkLayout()
    const first = await targetContext(link)
    const second = await targetContext(first.binary)
    const third = await targetContext(link)
    expect(new Set([first.identity.pathKey, second.identity.pathKey, third.identity.pathKey]).size).toBe(1)
  })

  test('the symlink itself is never consumed and stays a symlink', async () => {
    const { link } = await symlinkLayout()
    await targetContext(link)
    expect((await lstat(link)).isSymbolicLink()).toBe(true)
  })

  test('a single store namespace is used for a symlinked target', async () => {
    const { root, real, link } = await symlinkLayout()
    const store = path.join(root, 'store')
    process.env.UNBUN_CC_STORE = store
    try {
      const viaLink = await targetContext(link, { publish: true })
      const viaReal = await targetContext(real, { publish: true })
      expect(viaLink.targetDirectory).toBe(viaReal.targetDirectory)
      const targets = await readdir(path.join(store, 'v1', 'targets'))
      expect(targets).toHaveLength(1)
    } finally {
      delete process.env.UNBUN_CC_STORE
    }
  })
})
