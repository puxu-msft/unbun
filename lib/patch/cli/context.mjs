import path from 'node:path'

import { publishTargetMetadata } from '../store/assets.mjs'
import { targetIdentity } from '../store/identity.mjs'
import { resolveStoreRoot, storeV1Root } from '../store/root.mjs'

// L3B-01（Blocker）：写入目标必须与身份键**同源**，都用 canonical（realpath）路径。
// 曾用 `path.resolve(binaryPath)`（不解 symlink）作为写入目标，却用 realpath 算 pathKey，二者在
// symlink 安装布局（`~/.local/bin/claude -> ~/.local/share/claude/versions/<ver>`，正是 `which claude`
// 返回的形态）下不一致，后果是双重的：① 原子写的 rename 把 symlink 本身替换成普通文件，真实二进制
// 原封未动——patch 打在了错误的对象上却报 success；② 同一用户路径前后算出两个不同 pathKey，baseline
// 从此不可达，若打上的是不可逆的 channels，用户将**永久无法回退**。实测两者均可复现。
export async function targetContext(binaryPath, { publish = false } = {}) {
  const identity = await targetIdentity(path.resolve(binaryPath))
  const binary = identity.canonicalPath
  const targetDirectory = path.join(storeV1Root(resolveStoreRoot()), 'targets', identity.pathKey)
  if (publish) {
    await publishTargetMetadata(targetDirectory, {
      schema: 'unbun.cc.target',
      schema_version: 1,
      path_key: identity.pathKey,
      canonical_path: identity.canonicalPath,
      display_name: path.basename(binary),
      created_at: new Date().toISOString(),
    })
  }
  return { binary, identity, targetDirectory }
}