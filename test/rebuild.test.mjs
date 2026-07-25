// test/rebuild.test.mjs — rebuild 子命令 = **round-trip 完整性 oracle**。
//
// 真链路（不 mock）：buildRoundTripFixture 造一个纯 app 的小 bun --compile SFX `A`（无资产 / 无外部
//   原生依赖 → 可无损重打包）→ runExtract(A) 权威切出 app.js → runRebuild(app.js) 用 `bun build
//   --compile` 反向重打包成自包含二进制 rebuilt → **跑 rebuilt，断言其 stdout === 源 A 的 stdout**。
//   这条 build→extract→rebuild→run 链证明「extract 切对了 app bundle」（切错 / 有损则 rebuilt 跑不出
//   同样输出）。断言的是**运行行为**（stdout 等价），绝不 byte-pin 二进制或 app.js 文本。
//
// fixture `rt-src`（~94MB，打包整个 bun 运行时）与 rebuilt 都是构建产物、不入库：测试在临时目录即时
//   build，afterAll 清理。build-fixture.mjs 的 buildRoundTripFixture 是 entry 源的唯一真相源。
//   注：每个 --compile 快（小 entry ~0.3s），但保守设宽松 timeout（多次 compile + 读 94MB 二进制）。
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runExtract, runRebuild, dispatch } from '../cli.mjs'
import { cachedRoundTripFixture } from './fixtures/build-fixture.mjs'

const created = []
function tmp(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix))
  created.push(d)
  return d
}
afterAll(() => {
  for (const d of created) rmSync(d, { recursive: true, force: true })
})

test('ROUND-TRIP: build→extract→rebuild→run 输出无损（extract 切对了 app bundle）', async () => {
  const d = tmp('unbun-rt-')
  // 1) 造源 SFX A（纯 app entry，无资产 / 无外部原生依赖 → 可无损 round-trip）——共享缓存复用（建一次）。
  const { binPath: A, expected } = cachedRoundTripFixture()
  const aOut = execFileSync(A, { encoding: 'utf8' }).trim()
  expect(aOut).toBe(expected) // sanity：源二进制输出符合预期

  // 2) extract A → app.js（权威切 app bundle）。runExtract 现为 async（P3 并行）：必须 await。
  const { outdir } = await runExtract({ bin: A, outdir: join(d, 'out') })
  const appJs = join(outdir, 'app.js')
  expect(existsSync(appJs)).toBe(true)
  expect(statSync(appJs).size).toBeGreaterThan(0)

  // 3) rebuild app.js → rebuilt 自包含二进制
  const rebuilt = join(d, 'rebuilt')
  const r = runRebuild({ input: appJs, out: rebuilt })
  expect(r.out).toBe(rebuilt)
  expect(r.appJs).toBe(appJs)
  expect(existsSync(rebuilt)).toBe(true)
  expect(statSync(rebuilt).size).toBeGreaterThan(0)

  // 4) 关键断言：跑 rebuilt，输出 === 源 A 输出（round-trip 语义等价 ⇒ 抽取无损）。
  const rebuiltOut = execFileSync(rebuilt, { encoding: 'utf8' }).trim()
  expect(rebuiltOut).toBe(expected)
  expect(rebuiltOut).toBe(aOut)
}, 120_000)

test('rebuild 输入解析：吃 appdir（自动补 app.js）与缺省 out=<appdir>/rebuilt', async () => {
  const d = tmp('unbun-rt2-')
  const { binPath: A, expected } = cachedRoundTripFixture()
  const { outdir } = await runExtract({ bin: A, outdir: join(d, 'out') })

  // 吃目录 → 自动补 <dir>/app.js；缺省 out → <appdir>/rebuilt。
  const r = runRebuild({ input: outdir })
  expect(r.appJs).toBe(join(outdir, 'app.js'))
  expect(r.out).toBe(join(outdir, 'rebuilt'))
  expect(existsSync(r.out)).toBe(true)
  // 跑缺省产物，round-trip 输出仍无损。
  expect(execFileSync(r.out, { encoding: 'utf8' }).trim()).toBe(expected)
}, 120_000)

test('rebuild 守卫：缺输入 throw；app.js 不存在 throw', () => {
  expect(() => runRebuild({})).toThrow(/missing input/)
  const d = tmp('unbun-rt3-')
  // 目录里没有 app.js → 明确报错（不静默产出坏二进制）。
  expect(() => runRebuild({ input: d })).toThrow(/app\.js not found/)
})

test('dispatch rebuild：缺输入 → usage + 非零退出码（不崩溃）', async () => {
  // dispatch 现为 async：真 await 其 Promise。旧版 `expect(() => dispatch(...)).not.toThrow()` 空转
  // （async 函数永不同步抛）。真兜断言：dispatch 对缺输入的 rebuild **设 process.exitCode=1 并 resolves**
  // （不 reject）——删掉 rebuild 分支的 `process.exitCode = 1` 行则下面 `toBe(1)` 变红（非空自证）。
  try {
    await expect(dispatch(['bun', 'cli.mjs', 'rebuild'])).resolves.toBeUndefined()
    expect(process.exitCode).toBe(1)
  } finally {
    process.exitCode = 0 // 别污染 runner 退出码
  }
})
