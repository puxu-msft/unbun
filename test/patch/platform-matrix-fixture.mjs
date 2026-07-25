// test/patch/platform-matrix-fixture.mjs — 平台 gate 测试的共享 matrix seam。
//
// 生产写路径的 fail-closed 平台 gate（L1B-01）数据驱动于 contract/vectors/platform-writes-v1.json：
//   仅 linux 的 production_write_gate=enabled。想在测试里演练 Windows/macOS 的**平台写内部**
//   （codesign、签名漂移、PE/Mach-O 归一等）就注入本 helper 提升对应平台 gate 为 enabled，
//   这是唯一正当的 test-only seam——绝不在生产代码里放宽 gate。
import { readFileSync } from 'node:fs'

export const DEFAULT_PLATFORM_MATRIX = JSON.parse(
  readFileSync(new URL('../../contract/vectors/platform-writes-v1.json', import.meta.url), 'utf8'),
)

// 深拷贝 DEFAULT，把指定 contract 平台名（linux|windows|macos）的 gate 提升为 enabled。
export function enabledMatrix(...platforms) {
  const copy = structuredClone(DEFAULT_PLATFORM_MATRIX)
  for (const name of platforms) copy.platforms[name].capabilities.production_write_gate.status = 'enabled'
  return copy
}
