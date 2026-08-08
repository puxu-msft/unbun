#!/usr/bin/env bun
// cli.mjs — unbun 子命令分发骨架 + extract 子命令。
//
// 只解剖 Claude Code 的 Bun --compile SFX，全程纯读 + esbuild + strings，**绝不执行目标二进制**。
// 本任务实现 extract；其余子命令（assets/split/layout/diff/rebuild/cc）留占位提示，后续 task 填。
import {
  writeFileSync, readFileSync, mkdirSync, existsSync, openSync, closeSync, readdirSync,
  statSync, chmodSync, rmSync, mkdtempSync, renameSync,
} from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { execFileSync, spawnSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultBinary, readBinary, bufferReader } from './lib/bun-binary.mjs'
import { parseModuleGraph } from './lib/module-graph.mjs'
import { extractApp, versionFromBlobs } from './lib/extract.mjs'
import { outdirName, refsOutdir, uniqueAssetName } from './lib/naming.mjs'
import { splitModules } from './lib/split.mjs'
import { beautify } from './lib/beautify.mjs'
import { computeLayout, formatLayout } from './lib/layout.mjs'
import { diffModuleSets } from './lib/diff.mjs'
import { patchLoaderHook } from './lib/hook.mjs'
import { runCcManager } from './lib/patch/cli/dispatch.mjs'

// 从本脚本向上找含 `.git` 的目录 → 默认产物落共享 gitignored `<repo-root>/refs/`，与 cwd 无关。
// 回落 process.cwd()（脱离仓库运行时的 best-effort）。照旧 extract-bundle.mjs。
export function repoRoot() {
  let d = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(d, '.git'))) return d
    const up = dirname(d)
    if (up === d) break
    d = up
  }
  return process.cwd()
}

// 后续 task 认领的子命令名：命中 → 「尚未实现」提示而非崩溃。dispatch 与 cli-extract 烟测的
// **单一真相源**——实现一个命令就从这里删名，烟测（`import { PLACEHOLDER }` 迭代）自动同步，
// 不再硬编码命令字面量、不再每 task 手动改测试。
export const PLACEHOLDER = new Set()

// cc probe 名 → lib/probes/ 下的脚本文件（跑在真 Bun 运行时里，经 CC_EXT 注入）。
export const CC_PROBES = { assets: 'dump-assets.cjs', graph: 'module-graph.cjs', facts: 'runtime-facts.cjs' }

function probeScript(name) {
  return join(dirname(fileURLToPath(import.meta.url)), 'lib', 'probes', name)
}

// extract 核心：纯读 bin → 权威切 app bundle → esbuild 美化 → 写盘四产物。
// 返回 { outdir, manifest } 便于测试断言与后续子命令消费。stderr 打印进度，不污染 stdout。
//
// P3 并行提速：`strings` 是外部子进程（OS 进程），与异步 esbuild beautify 无数据依赖。
// 用 `spawn`（异步、无 shell 数组参数，保持现有无注入特性）在 beautify 之前启动 strings，让两项工作并行；beautify 返回后再 await strings 完成。
// runExtract 因此为 async，所有调用点（dispatch case 'extract' / 顶层入口链 / 测试）须 await（漏 await →
// strings 可能未写完就断言 strings-n6.txt = 假绿/竞态）。strings 非零退出 / spawn error → reject 传播（fail-loud，不吞）。
export async function runExtract({ bin, outdir } = {}) {
  bin = bin || defaultBinary()
  console.error(`[extract] reading ${bin}`)
  const { app, version, blob } = extractApp(bin)
  outdir = (outdir || refsOutdir(join(repoRoot(), 'refs'), outdirName(bin, version))).replace(/\/$/, '')
  mkdirSync(outdir, { recursive: true })

  // strings 走无 shell 的 spawn（数组参数）+ fd 直写：不起 shell → bin 路径不经 shell quoting，
  // 含 `$(...)` / 反引号 / `$VAR` 的路径不会被求值（注入面消失，根治契约 JSON.stringify(bin) 缺陷）；
  // stdout 直接重定向到打开的 fd，绕过 maxBuffer（strings 输出 ~34MB 本会溢出）。
  // **在 beautify 之前** spawn：strings 对 257MB 第 3 趟扫（~1.9s）与下方 beautify（~3s CPU）真并行跑。
  const stringsPath = join(outdir, 'strings-n6.txt')
  const fd = openSync(stringsPath, 'w')
  const child = spawn('strings', ['-a', '-n', '6', bin], { stdio: ['ignore', fd, 'inherit'] })
  const stringsClosed = new Promise((resolve) => child.once('close', resolve))
  const stringsDone = new Promise((res, rej) => {
    child.on('close', (code) => (code === 0 ? res() : rej(new Error(`strings exit ${code}`))))
    child.on('error', rej) // spawn 失败（strings 不存在等）→ 传播，不吞
  })
  // strings 可在异步 beautify 期间先失败；立即挂处理者防止 Bun 提前判成 unhandled rejection。
  // 原 Promise 保持 rejected，后续 await stringsDone 仍按原错误 fail-loud。
  stringsDone.catch(() => {})
  console.error(`[extract] spawned strings → ${stringsPath} (runs in parallel with beautify)`)

  // 异步 beautify + 写盘 + await strings 全包进 try：任一步骤抛错时，catch 保证不遗留 strings 子进程 / fd；
  // finally 无论成败都关 fd（关早了会截断 strings 写，故必在 await/kill 之后）。fail-loud：主错误照原样 rethrow。
  let prettyLines
  try {
    const pretty = await beautify(app)

    const appPath = join(outdir, 'app.js')
    writeFileSync(appPath, app)
    console.error(`[extract] wrote ${appPath} (${app.length} bytes)`)

    const prettyPath = join(outdir, 'app.pretty.js')
    writeFileSync(prettyPath, pretty)
    prettyLines = pretty.split('\n').length
    console.error(`[extract] wrote ${prettyPath} (${prettyLines} lines)`)

    // beautify 完后 await strings 结束。非零退出 / error → 上面的 Promise reject 在此传播（fail-loud）。
    await stringsDone
    console.error(`[extract] wrote ${stringsPath}`)
  } catch (err) {
    try { child.kill() } catch { /* 已退出：kill 无操作 */ }
    await stringsClosed
    throw err // strings 已关闭后传播主错误，不遗留后台扫描进程
  } finally {
    closeSync(fd) // 成败都在 child close 后关父侧 fd
  }

  const manifest = {
    version,
    binary: bin,
    blob: { offset: blob.offset, length: blob.length },
    appBytes: app.length,
    prettyLines,
    extractedAt: new Date().toISOString(),
  }
  const manifestPath = join(outdir, 'manifest.json')
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  console.error(`[extract] wrote ${manifestPath}`)

  return { outdir, manifest }
}

// split 核心：拿 app bundle（二进制走 extractApp，或直接读已提取的 app.js）→ 按模块 wrapper 切分
// → 逐模块写 `NNNNN-<handle>.js`（seq 左补零 5 位，文件名带 seq 前缀天然唯一）+ 汇总 `index.json`。
// 输入判别：argv[3] 缺省 → defaultBinary()（二进制）；以 `.js` 结尾 → readFileSync 当 app.js 直接读。
// 6000+ 文件写盘走**分批并发异步写**（P5）：逐个同步 writeFileSync 串行 ~256ms，改 fs.promises.writeFile
// + Promise.all 后 IO 重叠、显著更快。分批（每批 512）避免 6000+ 并发 open 撞系统 fd 上限（ulimit -n 常
// 1024）。任一批任一写失败 → Promise.all reject → 传播出去（fail-loud，不吞）。runSplit 因此为 async，
// 调用点（dispatch case 'split' / 测试）须 await（否则漏 await 竞态、假绿）。
// 测试可传 { app, version } 复用缓存、免重复读 257MB 二进制。stderr 打印进度，不污染 stdout。
// 返回 { outdir, index } 便于测试断言与后续子命令消费。
export async function runSplit({ input, outdir, app, version, tempOutdir } = {}) {
  if (app == null) {
    input = input || defaultBinary()
    if (input.endsWith('.js')) {
      // 已提取的 app.js：直接读文件当 app。version 从 basename 推得（无权威锚 → best-effort）。
      console.error(`[split] reading app.js ${input}`)
      app = readFileSync(input, 'utf8')
      version = version ?? basename(input).replace(/\.js$/, '')
    } else {
      // 二进制：走 extractApp 权威切 app bundle + 版本锚。
      console.error(`[split] reading ${input}`)
      const ex = extractApp(input)
      app = ex.app
      version = version ?? ex.version
    }
  }
  // E3 = A4：默认 outdir 统一走 outdirName（version || basename），不再自造字面 'app' 回落。version
  // 已在上面从权威锚（二进制）或 basename(app.js) 推出；仍为空时 outdirName 回落 basename(input)（app.js /
  // 二进制路径均合理），纯内存 app（无 input、无 version）才落到字面 'app'（无路径可 basename）。
  const { modules, helpers } = splitModules(app)
  outdir = (outdir || refsOutdir(join(repoRoot(), 'refs'), outdirName(input || 'app', version), 'modules')).replace(/\/$/, '')
  mkdirSync(dirname(outdir), { recursive: true })
  const staging = tempOutdir || mkdtempSync(join(dirname(outdir), `.${basename(outdir)}.tmp-`))
  if (tempOutdir) mkdirSync(staging, { recursive: true })

  // seq 前缀补零宽度：≥5 位（Claude ~6000 模块恒 5 位），任意大 SFX 按 count 加宽，保 lexical 排序不塌。
  const pad = Math.max(5, String(Math.max(0, modules.length - 1)).length)
  const indexModules = []
  const writes = [] // [path, data] 对：先全量算出，再分批并发写盘（IO 与元数据构建解耦）
  for (const m of modules) {
    // 文件名 = NNNNN-<handle>.js。seq 前缀已天然唯一（不同 seq 同 minified 名不撞）；
    // handle 罕见含文件系统非法字符 → sanitize 成 `_`（仅影响文件名，index.handle 仍存原名）。
    const safeHandle = m.handle.replace(/[^A-Za-z0-9._$-]/g, '_')
    const file = `${String(m.seq).padStart(pad, '0')}-${safeHandle}.js`
    writes.push([join(staging, file), app.slice(m.start, m.end)]) // 该模块源 `X=<helper>(…)`
    indexModules.push({
      seq: m.seq,
      handle: m.handle,
      kind: m.kind,
      start: m.start,
      end: m.end,
      bytes: m.end - m.start,
      hash: m.hash, // E5=A6：内容哈希（sha256 前 16 hex），diff 用作精确身份消除 (kind,bytes) 误配
      file,
    })
  }

  const index = { version: version || 'app', helpers, count: modules.length, modules: indexModules }
  try {
    // 分批并发写：每批 ≤512 个并发 writeFile，批间串行 await，控住并发 fd 数、防 EMFILE。
    const BATCH = 512
    for (let i = 0; i < writes.length; i += BATCH) {
      const batch = writes.slice(i, i + BATCH)
      await Promise.all(batch.map(([p, data]) => writeFile(p, data)))
    }
    await writeFile(join(staging, 'index.json'), JSON.stringify(index, null, 2) + '\n')
    const stagedFiles = readdirSync(staging)
    if (stagedFiles.length !== modules.length + 1) throw new Error(`split: staged file count ${stagedFiles.length} != expected ${modules.length + 1}`)
    for (const m of indexModules) {
      const data = readFileSync(join(staging, m.file))
      const hash = createHash('sha256').update(data.subarray(data.indexOf(0x3d) + 1)).digest('hex').slice(0, 16)
      if (hash !== m.hash) throw new Error(`split: staged hash mismatch for ${m.file}`)
    }

    const backup = `${outdir}.old-${process.pid}-${Date.now()}`
    let backedUp = false
    try {
      if (existsSync(outdir)) {
        renameSync(outdir, backup)
        backedUp = true
      }
      renameSync(staging, outdir)
      if (backedUp) rmSync(backup, { recursive: true, force: true })
    } catch (error) {
      if (!existsSync(outdir) && backedUp && existsSync(backup)) renameSync(backup, outdir)
      throw error
    }
  } catch (error) {
    if (existsSync(staging) && staging !== outdir) rmSync(staging, { recursive: true, force: true })
    throw error
  }

  const esm = modules.filter((m) => m.kind === 'esm').length
  const cjs = modules.filter((m) => m.kind === 'cjs').length
  console.error(`[split] ${modules.length} modules (${esm} esm / ${cjs} cjs) → ${outdir}`)

  return { outdir, index }
}

// assets 核心：纯读 bin → 静态解 module-graph → 切「非入口」资产 blob（除 app cli.js 本体外的
// 所有 blob：2 个 .node napi 原生模块、辅助 js、mermaid 等 file-loader 资产）逐个写盘。绝不执行目标
// 二进制、不启发式扫描 —— offset/length 全取 module-graph 权威值。文件名用 blob.name 的 basename
// （内联 `/$bunfs/root/image-processor.node` → `image-processor.node`）；name 为 null/空时回落
// `blob-<offset>.bin`（评审 m1：name 来源由 P0-a 确证，可能无内联名）。同名 basename 碰撞（不同 $bunfs
// 路径、同尾名）经 uniqueAssetName 用 offset 消歧，**绝不静默覆盖**（E4 = A5）。注：活二进制无内嵌
// sourcemap（FINDINGS P0-e），资产集即 graph 里的非入口 blob，不硬造 sourcemap.json。默认落共享 gitignored
// `refs/claude-code-<name>/assets/`（不写进被 git 追踪处）。stderr 打印进度，不污染 stdout。
// 返回 { outdir, assets:[{name,file,offset,length,loader}] } 便于测试断言与后续子命令消费。
//
// DI seam：测试可注入 { blobs, buf }（合成资产清单 + 字节源）跳过读真二进制 + 解 graph，直跑写盘逻辑
// 验同名碰撞消歧 / null 回落（见 test/cli-assets-collision.test.mjs）；此时须显式给 outdir。注入的 buf
// 经 bufferReader 包成与真 reader 同接口，写盘循环对「真 pread reader / 注入 buf」走同一码路。
export function runAssets({ bin, outdir, blobs: injBlobs, buf: injBuf } = {}) {
  let reader, blobs, version, ownReader = false
  if (injBlobs) {
    if (!outdir) throw new Error('runAssets: outdir required when injecting blobs (DI seam)')
    reader = bufferReader(injBuf) // 内存后端：reader.slice(off,len) → buf.subarray
    blobs = injBlobs
    version = 'test'
  } else {
    bin = bin || defaultBinary()
    console.error(`[assets] reading ${bin}`)
    reader = readBinary(bin) // 开 fd + pread 建 sections，复用给 parseModuleGraph（E1），用完 close
    ownReader = true
    ;({ blobs } = parseModuleGraph(bin, reader))
    // E3 = A4：从入口 blob 解 version（复用同一 reader，只 pread 入口 blob）→ outdirName 统一命名
    // `claude-code-<version>`（旧版只用 basename(bin)，与 extract 的 version 命名在换名副本下分裂）。
    version = versionFromBlobs(reader, blobs)
  }
  try {
    outdir = (outdir || refsOutdir(join(repoRoot(), 'refs'), outdirName(bin, version), 'assets')).replace(/\/$/, '')
    mkdirSync(outdir, { recursive: true })

    const used = new Set() // 已用文件名集：uniqueAssetName 用它消歧同名 basename，保每 blob 都写出、不覆盖
    const assets = []
    for (const b of blobs) {
      if (b.isEntry) continue // app cli.js 本体归 extract/split，不作资产
      // 文件名 = blob.name 的 basename，同名碰撞用 offset 消歧、null/空回落 blob-<offset>.bin（E4 = A5）。
      const file = uniqueAssetName(b.name, b.offset, used)
      writeFileSync(join(outdir, file), reader.slice(b.offset, b.length)) // 只 pread 该资产字节（非整块）
      assets.push({ name: b.name || null, file, offset: b.offset, length: b.length, loader: b.loader })
    }

    console.error(`[assets] wrote ${assets.length} assets → ${outdir}`)
    return { outdir, assets }
  } finally {
    if (ownReader) reader.close() // 只关自己开的真 fd（注入 buf 的 bufferReader.close 是 no-op）
  }
}

// layout 核心：纯读 bin → 静态解 module-graph + ELF section → 分账体积构成（引擎 / app cli.js /
// 资产 / JSC 字节码+元数据 / 其余段），打人类可读表到 stderr + 写结构化 layout.json 到 outdir。绝不执行
// 目标二进制、边界全来自 module-graph + ELF，**绝不启发式 latin1 扫可打印 run**（Global Constraints）。
// 默认落共享 gitignored `refs/claude-code-<name>/layout.json`。返回 { outdir, layout } 便于测试与下游消费。
export function runLayout({ bin, outdir } = {}) {
  bin = bin || defaultBinary()
  console.error(`[layout] reading ${bin}`)
  const layout = computeLayout(bin)
  console.error(formatLayout(layout))

  // E3 = A4：用 computeLayout 已从入口 blob 解出的 layout.version（不重读二进制）→ outdirName 统一命名
  // `claude-code-<version>`（旧版只用 basename(bin)，与 extract/assets 的 version 命名在换名副本下分裂）。
  outdir = (outdir || refsOutdir(join(repoRoot(), 'refs'), outdirName(bin, layout.version))).replace(/\/$/, '')
  mkdirSync(outdir, { recursive: true })
  const layoutPath = join(outdir, 'layout.json')
  writeFileSync(layoutPath, JSON.stringify(layout, null, 2) + '\n')
  console.error(`[layout] wrote ${layoutPath}`)

  return { outdir, layout }
}

// diff 核心：读两个 split 产物的 index.json（吃目录 → 自动补 modules/index.json，或直接吃 index.json
// 路径），调 diffModuleSets 归一 minifier 改名后比对模块集合，打摘要到 stderr + 写结构化 diff.json 到
// outdir。纯读 index.json（纯数据），不碰二进制。返回 { outdir, outPath, diff } 便于测试与下游消费。
// 输入解析：以 `.json` 结尾 → 直接当 index.json；否则视作 split 目录、补 `modules/index.json`。
function resolveIndexPath(p) {
  return p.endsWith('.json') ? p : join(p, 'modules', 'index.json')
}

export function runDiff({ a, b, outdir } = {}) {
  const pathA = resolveIndexPath(a)
  const pathB = resolveIndexPath(b)
  console.error(`[diff] A ${pathA}`)
  console.error(`[diff] B ${pathB}`)
  const indexA = JSON.parse(readFileSync(pathA, 'utf8'))
  const indexB = JSON.parse(readFileSync(pathB, 'utf8'))

  const { added, removed, changed, renamed, unchanged } = diffModuleSets(indexA, indexB)
  const summary = {
    added: added.length,
    removed: removed.length,
    changed: changed.length,
    renamed: renamed.length,
    unchanged,
  }
  // richest-context：结构化产物带全 provenance（两侧路径 / 版本）+ 完整分类明细，不预裁剪。
  const diff = {
    a: pathA,
    b: pathB,
    versionA: indexA.version,
    versionB: indexB.version,
    summary,
    added,
    removed,
    changed,
    renamed,
  }

  console.error(
    `[diff] +${summary.added} added / -${summary.removed} removed / ` +
      `~${summary.changed} changed / →${summary.renamed} renamed / =${summary.unchanged} unchanged`,
  )

  outdir = (outdir || process.cwd()).replace(/\/$/, '')
  mkdirSync(outdir, { recursive: true })
  const outPath = join(outdir, 'diff.json')
  writeFileSync(outPath, JSON.stringify(diff, null, 2) + '\n')
  console.error(`[diff] wrote ${outPath}`)

  return { outdir, outPath, diff }
}

// rebuild 核心：吃 extract 产物目录（含 app.js）或直接 app.js 路径 → `bun build --compile` 反向重打包
// 成自包含二进制。**核心价值是 round-trip 完整性 oracle**：extract→rebuild→run 若跑得起来 ⇒ 抽取无损
// （app bundle 切对了）。out 缺省 `<appdir>/rebuilt`（input 是 app.js 时 appdir=其所在目录）。stderr 打
// 印进度，不污染 stdout。返回 { out, appJs } 便于测试断言与后续消费。
//
// 用 execFileSync 数组参数（**无 shell**）跑 bun：appJs/out 路径含 `$(...)` / 反引号 / `$VAR` 等 shell
// 元字符也不被求值（注入面消失；同 extract 的 strings 教训，绝不拼 shell 字符串）。
//
// 已知局限（原生依赖）：纯 app.js（无外部原生依赖）可无损 round-trip；`bun --compile` 会内联
// `with {type:'file'}` 资产，但**不处理 app.js 直接 require 的外部 `.node` 路径**。真 claude 的 app.js
// 引用 2 个 napi 原生模块（image-processor.node 等），其 round-trip 需连带原生资产、属 gitignored smoke，
// 不在本命令的纯 app.js round-trip 契约内（见 unbun docs / task 5.1 report 局限）。
export function runRebuild({ input, out } = {}) {
  if (!input) throw new Error('rebuild: missing input (appdir or app.js path)')
  // 输入判别：以 `.js` 结尾 → 直接当 app.js；否则视作 extract 产物目录、补 `<dir>/app.js`。
  let appJs, appdir
  if (input.endsWith('.js')) {
    appJs = input
    appdir = dirname(input)
  } else {
    appdir = input
    appJs = join(input, 'app.js')
  }
  if (!existsSync(appJs)) throw new Error(`rebuild: app.js not found: ${appJs}`)
  out = (out || join(appdir, 'rebuilt')).replace(/\/$/, '')
  mkdirSync(dirname(out), { recursive: true }) // out 父目录可能不存在（写到新位置）
  console.error(`[rebuild] bun build --compile ${appJs} → ${out}`)
  // execFileSync 数组参数、无 shell：路径不经 shell quoting（注入面消失，见函数头说明）。
  execFileSync('bun', ['build', '--compile', appJs, '--outfile', out], { stdio: ['ignore', 'inherit', 'inherit'] })
  chmodSync(out, 0o755) // 保执行位（round-trip 要能被 spawn 跑）
  console.error(`[rebuild] rebuilt ${out}（提示：启动较慢；round-trip oracle：跑得起来 ⇒ 抽取无损）`)
  return { out, appJs }
}

// ── cc: 运行时内省（唯一会**跑目标**的命令族；只对副本打桩+跑，对 live 二进制只读）──────────
//
// cc patch-loader-hook <bin> [--out <path>] [--force]
//   读 bin → patchLoaderHook 等长打桩 → 写**副本**（默认 `<bin>.hooked`）。三守卫（4.1 评审）：
//     ① 锚点零命中 → 报错退出 1（对齐 exp）；② out 落在 `versions/` 下（live 安装区）→ 拒绝除非
//     --force（--force 时真写副本、非 no-op）；③ 有 `<bin>.bak` 时校验尺寸一致（防打到已变形文件）。
//   等长断言：打桩后 patched.length === 原 size（TOC 偏移不动前提），否则拒写。
export function runCcPatch({ bin, out, force = false, anchor, payload } = {}) {
  if (!bin) throw new Error('cc patch-loader-hook: missing binary path')
  // 全量 readFileSync（非 pread）：本命令**产出一个逐字节等长的打桩副本**——patchLoaderHook 在整块
  // buffer 上等长改写、再 writeFileSync 整块写出。这是真·全文件操作（不是「只取几十 MB」的读），故不 pread 化。
  const buf = readFileSync(bin)
  const origSize = buf.length
  out = out || `${bin}.hooked`
  // 守卫②：拒绝把打桩产物写进 versions/ 下的 live 安装区（含默认 `<live>.hooked`），除非 --force。
  if (/[\\/]versions[\\/]/.test(out) && !force) {
    console.error(`[cc] refusing to write a hooked artifact under versions/ (live install): ${out}`)
    console.error('[cc] patch a COPY elsewhere (--out <path outside versions/>), or pass --force to override.')
    process.exitCode = 1
    return { patched: false, reason: 'versions-guard', out }
  }
  // 守卫③：同目录 <bin>.bak 尺寸 sanity（不一致 → 目标可能已被改动，警告但不阻断）。
  const bak = `${bin}.bak`
  if (existsSync(bak) && statSync(bak).size !== origSize) {
    console.error(`[cc] WARNING: ${bin} size != ${bak} size; target may already be modified.`)
  }
  const { patched, sites } = patchLoaderHook(buf, { force, anchor, payload })
  // 守卫①：锚点零命中 → 错误退出（错的二进制、或前导注释已变的构建）。
  if (sites.length === 0) {
    console.error('[cc] anchor not found — wrong binary or a build whose leading comment changed.')
    process.exitCode = 1
    return { patched: false, sites, reason: 'no-sites', out }
  }
  if (patched.length !== origSize) {
    throw new Error(`cc patch-loader-hook: patched size ${patched.length} != original ${origSize}; refusing to write inconsistent binary`)
  }
  mkdirSync(dirname(out), { recursive: true }) // out 父目录可能不存在（写副本到新位置）
  writeFileSync(out, patched)
  chmodSync(out, 0o755) // 保执行位（写出的副本要能被 spawn）
  console.error(`[cc] patched ${sites.length} site(s): ${sites.join(', ')}`)
  console.error(`[cc] wrote ${out} (size ${origSize}, unchanged) — run: CC_EXT=/abs/probe.cjs ${out} --version`)
  return { patched: true, out, sites, size: origSize }
}

// cc run <bin> --ext <script> [args...]
//   拷贝 bin 到临时副本 → patchLoaderHook 打桩 → spawn 起进程（CC_EXT=<script>）→ 收集 stdout/stderr
//   → 删临时副本。对 live 二进制**只读**（只读它、只写临时副本）。返回 { status, stdout, stderr, sites }。
export function runCcRun({ bin, ext, anchor, payload, env = {}, args = ['--version'] } = {}) {
  if (!bin) throw new Error('cc run: missing binary path')
  if (!ext) throw new Error('cc run: missing --ext script')
  const work = mkdtempSync(join(tmpdir(), 'unbun-cc-run-'))
  const tmpBin = join(work, 'target')
  try {
    const buf = readFileSync(bin) // live 二进制只读；全文件（打桩产出等长整块副本，非 pread 场景，见 runCcPatch 注）
    const { patched, sites } = patchLoaderHook(buf, { anchor, payload })
    if (sites.length === 0) {
      throw new Error(`cc run: loader-hook anchor not found in ${bin}; cannot inject CC_EXT (wrong anchor/binary?)`)
    }
    if (patched.length !== buf.length) {
      throw new Error(`cc run: patched size ${patched.length} != original ${buf.length}`)
    }
    writeFileSync(tmpBin, patched)
    chmodSync(tmpBin, 0o755)
    const res = spawnSync(tmpBin, args, {
      encoding: 'utf8',
      env: { ...process.env, CC_EXT: ext, ...env },
      maxBuffer: 128 * 1024 * 1024, // probe 可能吐大清单/资产日志
    })
    return { status: res.status, signal: res.signal, stdout: res.stdout || '', stderr: res.stderr || '', sites }
  } finally {
    rmSync(work, { recursive: true, force: true }) // 只删自建临时副本目录
  }
}

// probe 向 stdout 打的机器可读单行 `UNBUN_PROBE_JSON {...}`。从末尾往前找最后一条可解析的（app main
// 可能在其后又打了别的东西）。找不到 → null（交调用方判断）。
export function parseProbeJson(stdout) {
  if (!stdout) return null
  const lines = stdout.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^UNBUN_PROBE_JSON (.+)$/)
    if (m) {
      try { return JSON.parse(m[1]) } catch { /* 继续往前找 */ }
    }
  }
  return null
}

// cc introspect <bin> --probe assets|graph|facts [--out <dir>]
//   = cc run + 内置 probe（lib/probes/<probe>.cjs）。probe 落盘到 outdir（DUMP_DIR/FACTS_OUT/GRAPH_OUT）
//   并向 stdout 吐 UNBUN_PROBE_JSON。返回 { outdir, probe, result, status, stdout, stderr }。
export function runCcIntrospect({ bin, probe, outdir, anchor, payload, args, script: injectedScript } = {}) {
  const rel = CC_PROBES[probe]
  if (!rel) throw new Error(`cc introspect: unknown probe '${probe}' (use: ${Object.keys(CC_PROBES).join('|')})`)
  const script = injectedScript || probeScript(rel)
  if (!existsSync(script)) throw new Error(`cc introspect: probe script missing: ${script}`)
  outdir = (outdir || mkdtempSync(join(tmpdir(), `unbun-probe-${probe}-`))).replace(/\/$/, '')
  mkdirSync(outdir, { recursive: true })
  const env = {}
  let expectedPath = null
  if (probe === 'assets') env.DUMP_DIR = outdir
  if (probe === 'facts') env.FACTS_OUT = expectedPath = join(outdir, 'facts.json')
  if (probe === 'graph') env.GRAPH_OUT = expectedPath = join(outdir, 'module-graph.json')
  console.error(`[cc] introspect ${probe} on ${bin}`)
  const res = runCcRun({ bin, ext: script, anchor, payload, env, args })
  if (res.signal) throw new Error(`cc introspect ${probe}: child terminated by signal ${res.signal}${res.stderr ? `\n${res.stderr}` : ''}`)
  if (res.status !== 0) throw new Error(`cc introspect ${probe}: child exited with status ${res.status}${res.stderr ? `\n${res.stderr}` : ''}`)
  const result = parseProbeJson(res.stdout)
  if (!result) throw new Error(`cc introspect ${probe}: child succeeded without UNBUN_PROBE_JSON marker`)
  if (result.probe !== probe) throw new Error(`cc introspect ${probe}: marker reported probe ${JSON.stringify(result.probe)}`)
  if (expectedPath && !existsSync(expectedPath)) throw new Error(`cc introspect ${probe}: expected output missing: ${expectedPath}`)
  if (probe === 'assets') {
    for (const file of result.files ?? []) {
      if (!file?.name || basename(file.name) !== file.name || !existsSync(join(outdir, file.name))) {
        throw new Error(`cc introspect assets: expected output missing: ${file?.name ?? '<unnamed>'}`)
      }
    }
  }
  console.error(`[cc] introspect ${probe} → ${outdir} (${(result.files || result.embeddedFiles || []).length} embedded)`)
  return { outdir, probe, result, status: res.status, stdout: res.stdout, stderr: res.stderr }
}

// cc 子分发：cc <patch-loader-hook|run|introspect> <bin> [flags]。小 flag 解析（--out/--ext/--probe/--force）。
// `--` 分隔符：其后的所有参数原样收进 passthrough，不再当本命令 flag 解析（供 cc run 向目标脚本透传 --开头参数）。
export function parseCcFlags(args) {
  const positional = []
  const flags = {}
  const passthrough = []
  const booleanOptions = new Map([
    ['--force', 'force'], ['--check', 'check'], ['--revert', 'revert'], ['--all', 'all'], ['--full', 'full'], ['--yes', 'yes'], ['-y', 'yes'],
  ])
  const valueOptions = new Map([['--out', 'out'], ['--ext', 'ext'], ['--probe', 'probe']])
  const setFlag = (spelling, key, value) => {
    if (Object.hasOwn(flags, key)) throw new Error(`duplicate option ${spelling}`)
    flags[key] = value
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--') { passthrough.push(...args.slice(i + 1)); break }
    if (booleanOptions.has(a)) {
      setFlag(a, booleanOptions.get(a), true)
      continue
    }
    if (valueOptions.has(a)) {
      const value = args[i + 1]
      if (value == null || value.startsWith('-')) throw new Error(`${a} requires a value`)
      setFlag(a, valueOptions.get(a), value)
      i++
      continue
    }
    if (a.startsWith('-')) throw new Error(`unknown option ${a}`)
    positional.push(a)
  }
  return { positional, flags, passthrough }
}

export async function runCc(args) {
  const sub = args[0]
  if (!['patch-loader-hook', 'run', 'introspect'].includes(sub)) return runCcManager(args)
  const { positional, flags, passthrough } = parseCcFlags(args.slice(1))
  const bin = positional[0]
  switch (sub) {
    case 'patch-loader-hook':
      if (!bin) {
        console.error('usage: unbun cc patch-loader-hook <bin> [--out <path>] [--force]')
        process.exitCode = 1
        return
      }
      return runCcPatch({ bin, out: flags.out, force: !!flags.force })
    case 'run': {
      if (!bin || !flags.ext) {
        console.error('usage: unbun cc run <bin> --ext <script> [-- <target-args...>]')
        process.exitCode = 1
        return
      }
      // 目标脚本参数：优先 `--` 后的 passthrough（可含 --开头参数）；否则回落裸位置参数（向后兼容）。
      const targetArgs = passthrough.length ? passthrough : positional.slice(1)
      const res = runCcRun({ bin, ext: flags.ext, args: targetArgs.length ? targetArgs : undefined })
      if (res.stdout) process.stdout.write(res.stdout)
      if (res.stderr) process.stderr.write(res.stderr)
      if (res.status) process.exitCode = res.status
      return res
    }
    case 'introspect': {
      if (!bin || !flags.probe) {
        console.error(`usage: unbun cc introspect <bin> --probe <${Object.keys(CC_PROBES).join('|')}> [--out <dir>]`)
        process.exitCode = 1
        return
      }
      try {
        return runCcIntrospect({ bin, probe: flags.probe, outdir: flags.out })
      } catch (error) {
        process.exitCode = 1
        throw error
      }
    }
  }
}

// 子命令分发：switch(argv[2])。未知命令 → 用法提示 + 非零退出码；占位命令 → 尚未实现提示（退出 0）。
// async：split 走并发异步写盘（P5），必须 await 传播其 Promise（漏 await → 竞态/未处理 rejection 假绿）。
export async function dispatch(argv) {
  const cmd = argv[2]
  switch (cmd) {
    case 'extract':
      // 空串 argv[3]/argv[4] → 回落默认（defaultBinary / refs/<name>）。
      // runExtract 现为 async（P3：strings 子进程与 beautify 并行）：await 传播其 Promise
      // （strings 非零/spawn error 向上抛，fail-loud；漏 await → strings 未写完的竞态/未处理 rejection）。
      await runExtract({ bin: argv[3] || undefined, outdir: argv[4] || undefined })
      return
    case 'split':
      // 空串 argv[3]/argv[4] → 回落默认（defaultBinary 二进制 / refs/<name>/modules）。
      // 并发异步写盘（P5）：await 传播 Promise，任一写失败向上抛（fail-loud）。
      await runSplit({ input: argv[3] || undefined, outdir: argv[4] || undefined })
      return
    case 'assets':
      // 空串 argv[3]/argv[4] → 回落默认（defaultBinary / refs/<name>/assets）。
      runAssets({ bin: argv[3] || undefined, outdir: argv[4] || undefined })
      return
    case 'layout':
      // 空串 argv[3]/argv[4] → 回落默认（defaultBinary / refs/<name>）。
      runLayout({ bin: argv[3] || undefined, outdir: argv[4] || undefined })
      return
    case 'diff':
      // diff <dirA|indexA.json> <dirB|indexB.json> [outdir]。缺 A/B → 用法提示 + 非零退出。
      if (!argv[3] || !argv[4]) {
        console.error('usage: unbun diff <dirA|indexA.json> <dirB|indexB.json> [outdir]')
        process.exitCode = 1
        return
      }
      runDiff({ a: argv[3], b: argv[4], outdir: argv[5] || undefined })
      return
    case 'cc':
      // cc <patch|patch-loader-hook|run|introspect> <bin> [flags]。patch 就地改写 live；其余只对副本/只读。
      await runCc(argv.slice(3))
      return
    case 'rebuild':
      // rebuild <appdir|app.js> [out]。round-trip 完整性 oracle：bun build --compile 反向重打包。
      // 缺输入 → 用法提示 + 非零退出。
      if (!argv[3]) {
        console.error('usage: unbun rebuild <appdir|app.js> [out]')
        process.exitCode = 1
        return
      }
      runRebuild({ input: argv[3], out: argv[4] || undefined })
      return
    default:
      if (PLACEHOLDER.has(cmd)) {
        console.error(`[unbun] '${cmd}' not yet implemented`)
        return
      }
      console.error('usage: unbun <extract|assets|split|layout|diff|rebuild|cc> [bin] [outdir]')
      if (cmd && cmd !== 'help' && cmd !== '--help' && cmd !== '-h') {
        console.error(`[unbun] unknown command '${cmd}'`)
        process.exitCode = 1
      }
  }
}

// dispatch 现为 async（split 并发写盘）。顶层 await 其 Promise：任一子命令抛错 → 打印 + 非零退出（fail-loud）。
if (import.meta.main) {
  dispatch(process.argv).catch((err) => {
    console.error(err?.stack || String(err))
    process.exit(1)
  })
}
