// test/cli-extract.test.mjs — extract 子命令端到端 + dispatch 骨架烟测。
// 真 claude 二进制纯读（defaultBinary，不执行）→ 写盘 app.js/app.pretty.js/strings-n6.txt/manifest.json
// 到一个自建临时 outdir。断言结构 / 行为（产物存在非空、manifest 字段合理、app.js 能被独立 oracle
// `node --check` 重解析），**绝不 byte-pin 专有文案**。写临时目录用 mkdtempSync，afterAll 只清自己建的。
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runExtract, dispatch, PLACEHOLDER } from '../cli.mjs'

const created = []
function tmp() {
  const d = mkdtempSync(join(tmpdir(), 'unbun-cli-'))
  created.push(d)
  return d
}
afterAll(() => {
  for (const d of created) rmSync(d, { recursive: true, force: true })
})

test('extract 写四产物；app.js 可重解析；manifest 字段合理', async () => {
  const out = tmp()
  // runExtract 现为 async（P3：strings 子进程与 beautify 并行提速）：必须 await，否则拿到 Promise、
  // strings 可能未写完就断言 strings-n6.txt = 假绿/竞态。
  const { outdir, manifest } = await runExtract({ outdir: out })
  expect(outdir).toBe(out)

  const appPath = join(out, 'app.js')
  expect(existsSync(appPath)).toBe(true)
  expect(statSync(appPath).size).toBeGreaterThan(0)

  expect(existsSync(join(out, 'app.pretty.js'))).toBe(true)
  expect(statSync(join(out, 'app.pretty.js')).size).toBeGreaterThan(0)
  expect(existsSync(join(out, 'strings-n6.txt'))).toBe(true)
  expect(statSync(join(out, 'strings-n6.txt')).size).toBeGreaterThan(0)

  // manifest 落盘内容 === 返回值（自洽），且字段结构 / 类型合理（不锁具体值）。
  const m = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'))
  expect(m).toEqual(manifest)
  // version 为 x.y.z（真锚命中）或回落 binary basename；本机二进制两者皆形如 x.y.z。
  expect(String(m.version)).toMatch(/^\d+\.\d+\.\d+$/)
  expect(typeof m.binary).toBe('string')
  expect(m.blob.offset).toBeGreaterThanOrEqual(0)
  expect(m.blob.length).toBeGreaterThan(0)
  expect(m.appBytes).toBeGreaterThan(0)
  expect(m.prettyLines).toBeGreaterThan(0)
  expect(m.extractedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)

  // 独立 oracle：node --check 重解析原始 bundle（抛非零则本测试失败）。不 byte-pin 内容。
  execFileSync('node', ['--check', appPath])
}, 30_000) // 真二进制读 257MB + esbuild 美化 19MB + strings + node --check ≈ 5-6s，放宽默认 5s 超时。

test('dispatch：占位子命令 resolves；裸参 / help usage；未知命令 → 非零退出码', async () => {
  // dispatch 现为 async（split/extract 走并发/子进程）：所有断言真 await 其 Promise。旧版 `expect(() =>
  // dispatch(...)).not.toThrow()` 空转——async 函数永不同步抛，`.not.toThrow()` 恒真、拦不住任何 rejection。
  //
  // 占位守卫：迭代 cli.mjs 导出的真实占位集 PLACEHOLDER（单一真相源）。当前 9 命令全实现、PLACEHOLDER
  // 为空集 → 此循环体暂不执行；保留它作「未来新增占位命令」的预留守卫——某命令加进 PLACEHOLDER 就自动
  // 纳入本烟测，某命令实现就从中删名、自动移出，不再硬编码命令字面量、不再每 task 手改本文件。
  for (const c of PLACEHOLDER) {
    // 占位命令 → dispatch 打「not yet implemented」并 resolves（不抛、不设 exitCode）。
    await expect(dispatch(['bun', 'cli.mjs', c])).resolves.toBeUndefined()
  }

  // 裸参（无子命令，cmd===undefined）→ 打 usage、resolves、不设 exitCode（default 分支 `cmd &&…` 短路）。
  await expect(dispatch(['bun', 'cli.mjs'])).resolves.toBeUndefined()
  // help → 同走 usage 分支但 `cmd!=='help'` 短路 → 不设 exitCode、resolves（正常返回、不当作错误）。
  await expect(dispatch(['bun', 'cli.mjs', 'help'])).resolves.toBeUndefined()

  // 未知命令 → dispatch 打 usage + `unknown command` 且**设 process.exitCode=1 并 resolves**（不 reject，
  // 实测行为：default 分支 `process.exitCode = 1`）。真兜断言（非空自证）：删掉该 `process.exitCode = 1`
  // 行，下面的 `toBe(1)` 即变红。finally 复位、别污染 runner 退出码。
  try {
    await expect(dispatch(['bun', 'cli.mjs', 'bogus-cmd'])).resolves.toBeUndefined()
    expect(process.exitCode).toBe(1)
  } finally {
    process.exitCode = 0
  }
})
