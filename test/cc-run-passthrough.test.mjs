// test/cc-run-passthrough.test.mjs — L1B-04 回归：`cc run <bin> --ext <script> -- <target-args...>`
//   的 `--` 分隔符透参。修复前 parser 把 `--` 开头的后续参数当自己的 flag 吞掉，无法透传给目标脚本。
//
// 两层验证：
//   ① 单元：parseCcFlags 的 `--` 语义（纯函数，无需 fixture）——`--` 后原样进 passthrough，
//      不再解析为本命令 flag；`--` 前照常解析；无 `--` 时 passthrough 为空、裸位置参数走向后兼容。
//   ② 端到端：runCcRun 直连真 fixture 副本，断言目标脚本在 child argv 里逐字节收到透传参数
//      （含 --开头 flag），且无 shell 求值。
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseCcFlags, runCcRun, parseProbeJson } from '../cli.mjs'
import { cachedMiniFixture, FIXTURE_ANCHOR } from './fixtures/build-fixture.mjs'

const created = []
afterAll(() => { for (const d of created) rmSync(d, { recursive: true, force: true }) })
function tmp(prefix) { const d = mkdtempSync(join(tmpdir(), prefix)); created.push(d); return d }

// ── ① 单元：parseCcFlags 的 `--` 分隔符语义 ─────────────────────────────
test('parseCcFlags: `--` 后的参数原样进 passthrough，不当本命令 flag 解析', () => {
  const { positional, flags, passthrough } = parseCcFlags(['bin', '--ext', 's.cjs', '--', '--foo', 'bar', '-x'])
  expect(positional).toEqual(['bin'])
  expect(flags.ext).toBe('s.cjs')
  // 关键：`--foo`/`-x` 不被吞成本命令 flag，而是原样透传
  expect(passthrough).toEqual(['--foo', 'bar', '-x'])
  expect(flags.foo).toBeUndefined()
})

test('parseCcFlags: 无 `--` 时 passthrough 为空，裸位置参数照常收集（向后兼容）', () => {
  const { positional, flags, passthrough } = parseCcFlags(['bin', '--ext', 's.cjs', 'pos1', 'pos2'])
  expect(positional).toEqual(['bin', 'pos1', 'pos2'])
  expect(flags.ext).toBe('s.cjs')
  expect(passthrough).toEqual([])
})

test('parseCcFlags: `--` 空尾（其后无参数）→ passthrough 空数组，不报错', () => {
  const { passthrough } = parseCcFlags(['bin', '--ext', 's.cjs', '--'])
  expect(passthrough).toEqual([])
})

test('parseCcFlags: `--` 后即使再出现 `--` 也原样保留（不二次分割）', () => {
  const { passthrough } = parseCcFlags(['bin', '--ext', 's.cjs', '--', 'a', '--', 'b'])
  expect(passthrough).toEqual(['a', '--', 'b'])
})

test('parseCcFlags: value option missing its value fails loudly without consuming the next flag', () => {
  expect(() => parseCcFlags(['bin', '--ext', '--probe', 'facts'])).toThrow(/--ext.*requires a value/)
})

test('parseCcFlags: unknown and duplicate flags fail loudly', () => {
  expect(() => parseCcFlags(['bin', '--wat', 'x'])).toThrow(/unknown option.*--wat/)
  expect(() => parseCcFlags(['bin', '--ext', 'a.cjs', '--ext', 'b.cjs'])).toThrow(/duplicate option.*--ext/)
})

// ── ② 端到端：透传参数逐字节抵达 child argv（真 fixture 副本，无 shell）────────
test('E2E: runCcRun 把 args（含 --开头 flag 与注入型字面量）原样送进目标脚本 argv', () => {
  const mini = cachedMiniFixture().miniPath
  const work = tmp('unbun-cc-run-pt-')
  // 探针：把自己收到的 argv（去掉 argv[0..1]）以机器可读单行回吐。
  const probe = join(work, 'echo-argv.cjs')
  writeFileSync(probe, 'console.log("UNBUN_PROBE_JSON " + JSON.stringify({ argv: process.argv.slice(2) }))\n')

  // 含 --开头 flag、含值、以及 shell 元字符字面量（验证无 shell 求值：$(...)/反引号/$VAR 不被展开）。
  const targetArgs = ['--foo', 'bar', '--flag', '$(whoami)', '`id`', '$HOME', '-x']
  const res = runCcRun({ bin: mini, ext: probe, anchor: FIXTURE_ANCHOR, args: targetArgs })
  const parsed = parseProbeJson(res.stdout)
  expect(parsed).toBeTruthy()
  // 逐字节相等：透传参数原样抵达，未被解析/丢弃/shell 展开。
  expect(parsed.argv).toEqual(targetArgs)
}, 120_000)
