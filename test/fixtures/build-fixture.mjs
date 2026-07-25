// test/fixtures/build-fixture.mjs — 构建一个**可打桩**的小 Bun --compile SFX（`mini`），
// 供 cc run/introspect + 子集 oracle 测试在真 Bun 运行时里演练「注释锚 → 打桩 → 执行 → require CC_EXT」。
//
// 为什么要自建 fixture、且它与真 claude **不对称**（评审 M2，已实测，见下）：
//   - 真 claude 是把**预打包好的 CJS app.js 原样嵌入** SFX，其明文 `//` 注释锚点得以存活，
//     且 app.js 作为一个 `@bun-cjs` 模块加载 → 模块作用域里 `require` 天然可用。
//   - 自建 fixture 走 `bun build --compile` 的 bundler：
//       * 明文 `//` 注释会被**剥除**（实测 grep=0）→ 改用 **`//!` 法律注释锚**：它既存活 bundler，
//         又是**真注释**，打桩等长覆盖成代码后**真作为代码执行**（复刻真 claude「注释锚→替换后执行」
//         的核心语义；string 字面量锚只在字符串内、改了不执行，会漏掉这一语义）。
//       * ESM 入口被 bundle 到顶层作用域，**没有** `require` 绑定（实测 bare `require` → ReferenceError；
//         bun 还会把局部 `const require` 改名成 `require2` 避免撞名）。而 hook 注入的 payload 用的是
//         **裸 `require`**（`CC_PAYLOAD`）。故 fixture 入口显式 `globalThis.require = createRequire(...)`：
//         裸 `require` 在顶层无词法绑定时走全局属性查找 → 命中 `globalThis.require` → payload 生效。
//   因此 fixture 的锚是**自己的等长 `//!` 锚**（`FIXTURE_ANCHOR`），cc run/introspect 对 fixture 传
//   `{anchor: FIXTURE_ANCHOR}`（Task 4.1 已把 anchor 参数化）；真 claude 路径用默认 `CC_ANCHOR`。
//
// 产物（均落 test/fixtures/，小、非专有、可入库）：
//   - `mini`      可打桩 bun SFX（ESM 入口 + 嵌入的 tiny.txt 文件资产 → 填充 Bun.embeddedFiles）
//   - `tiny.txt`  被嵌入的文件资产（头是 `/*!` 法律注释 banner，**故意非 JS/ELF marker**——
//                 file-loader 资产内容任意，module-graph 的 loader-aware 自证对 file 类**跳过** head sniff，
//                 只靠结构不变式兜；此 fixture 遂成 loader-aware 的活见证：若自证误对 file 类做 head
//                 sniff，凡用 `mini` 的测试都会 fail-loud 报「no marker」。复刻真 claude 2.1.206 起
//                 新增的 chart.umd.min.js（Chart.js，file loader，头同为 `/*!`）场景。
// entry.js 由本脚本即时生成到临时目录（本脚本是其唯一真相源），不入库。

import { mkdtempSync, writeFileSync, copyFileSync, rmSync, readFileSync, existsSync, mkdirSync, renameSync, readdirSync, statSync, utimesSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CC_PAYLOAD } from '../../lib/hook.mjs'

// fixture 专属等长 `//!` 锚：必须 ≥ CC_PAYLOAD 长度（打桩需等长覆盖，payload 超锚长会抛）。
export const FIXTURE_ANCHOR = '//! unbun fixture equal-length loader-hook anchor legal comment pad here x.'
if (FIXTURE_ANCHOR.length < CC_PAYLOAD.length) {
  throw new Error(`FIXTURE_ANCHOR (${FIXTURE_ANCHOR.length}) shorter than CC_PAYLOAD (${CC_PAYLOAD.length}); cannot keep equal length`)
}

// tiny.txt 内容：头是 `/*!` 法律注释 banner——**故意非** module-graph 自证的 JS/ELF marker。
// tiny.txt 是 file-loader 资产（Bun Loader enum 5），loader-aware 自证对 file 类**跳过** head sniff
// （内容任意，正确性靠结构不变式），故此 fixture 是「file 资产头非白名单也不该 throw」的活见证——
// 复刻真 claude 2.1.206 的 chart.umd.min.js（Chart.js，file loader，头同为 `/*!`）。是真·文件资产，
// 会进 Bun.embeddedFiles。
export const TINY_TXT = '/*! unbun-fixture legal-comment banner — file-loader asset, arbitrary head */\nhello embedded asset payload\n'

// double-magic 消歧 fixture（Task 4.3）用的注入哨兵：正文里嵌一个**字面量** `---- Bun! ----`，
// 前后包 DECOY 边界词以便测试反向定位「这是我们注入的假 magic、非真 trailer」。
// 赋给 globalThis 是**有副作用的顶层语句** → bun bundler 不会 DCE/tree-shake 掉，字符串字面量
// （含 magic 14 字节）原样落进 app bundle blob → 位于 `.bun` 窗口内、**真 trailer 之前**。
// 这正是 `module-graph.mjs` 用 `lastIndexOf` 而非 `indexOf` 定位真 trailer 的鲁棒性所要防的场景。
export const DECOY_MAGIC_SENTINEL = 'UNBUN_DECOY_START ---- Bun! ---- UNBUN_DECOY_END'

// entry.js 源：见文件头「不对称」说明。三要点：① `//!` 等长锚（存活 bundler、打桩后执行）
// ② `import ... with {type:'file'}` 嵌 tiny.txt（填充 embeddedFiles）③ `globalThis.require = createRequire`
// 让裸 `require` payload 生效。锚放在 require 建立**之后**、main 之前（打桩后 require(CC_EXT) 在此触发）。
// opts.doubleMagic：额外注入 DECOY_MAGIC_SENTINEL（含字面量 magic）到正文（Task 4.3 消歧测试用）。
function entrySource({ doubleMagic = false } = {}) {
  const lines = [
    "import asset from './tiny.txt' with { type: 'file' }",
    "import { createRequire } from 'node:module'",
    '// 顶层无 require 绑定 → 建全局 require，供打桩后 payload 的裸 require(CC_EXT) 走全局查找命中。',
    'globalThis.require = createRequire(import.meta.url)',
    '// 引用一次防 bun tree-shake 掉 require 建立（赋值本身有副作用、通常已足够，这里再加保险）。',
    'if (globalThis.__unbun_never_true) globalThis.require(\'node:fs\')',
  ]
  if (doubleMagic) {
    // 有副作用的顶层赋值 → bundler 保留；字面量含 magic 14 字节，落进 .bun 内的 app bundle。
    lines.push(`globalThis.__unbun_decoy_magic = ${JSON.stringify(DECOY_MAGIC_SENTINEL)}`)
    lines.push('console.log(globalThis.__unbun_decoy_magic.length)')
  }
  lines.push(FIXTURE_ANCHOR)
  lines.push("console.log('unbun fixture mini: asset=' + asset)")
  lines.push('')
  return lines.join('\n')
}

// 构建：临时目录写 entry.js + tiny.txt → bun build --compile → 产物落 outDir（默认 test/fixtures/）。
// 返回 { miniPath, tinyPath }。stderr 打印进度，不污染 stdout。
// opts.doubleMagic：注入正文 magic 字面量（Task 4.3）；opts.name：产物文件名（默认 'mini'，
// double-magic 变体用 'mini-doublemagic' 以免与常规 fixture 撞名/串用）。
export function buildFixture({ outDir, doubleMagic = false, name } = {}) {
  const here = dirname(fileURLToPath(import.meta.url))
  outDir = outDir || here
  const miniPath = join(outDir, name || (doubleMagic ? 'mini-doublemagic' : 'mini'))
  const tinyPath = join(outDir, 'tiny.txt')

  const work = mkdtempSync(join(tmpdir(), 'unbun-fixture-'))
  try {
    writeFileSync(join(work, 'entry.js'), entrySource({ doubleMagic }))
    writeFileSync(join(work, 'tiny.txt'), TINY_TXT)
    console.error(`[fixture] bun build --compile → ${miniPath}`)
    execFileSync('bun', ['build', '--compile', '--outfile', miniPath, join(work, 'entry.js')], {
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    // 写一份 tiny.txt 到 fixtures/ 供 build 引用 / 本地对照（gitignored，不入库）。
    copyFileSync(join(work, 'tiny.txt'), tinyPath)
    console.error(`[fixture] wrote ${tinyPath}`)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
  return { miniPath, tinyPath }
}

// buildRoundTripFixture — 造一个**纯 app**（无文件资产、无外部原生依赖、无打桩锚）的小 bun --compile
// SFX，专供 rebuild 的 round-trip oracle 测试：它能被 extract→rebuild 无损重打包并跑出同样输出。
// 为什么不复用上面 asset-laden 的 `mini`：`mini` 的 `import ... with {type:'file'}` 资产在第一次
// --compile 时被内联成 `/$bunfs/root/tiny.txt` 路径引用，rebuild 时该嵌入路径不复现 → 纯 round-trip
// 会失败（这正是「app.js 直接引用外部资产/原生路径」局限的缩影）。故 round-trip fixture 走**零外部
// 依赖**的 entry：只做一次真计算并 console.log 一个确定性 marker。返回 { binPath, expected }
// （expected = 期望 stdout，已 trim）。产物默认 gitignored（见 fixtures/.gitignore 的 rt-src）。
// round-trip fixture 的期望 stdout（已 trim）——被 buildRoundTripFixture 与 cachedRoundTripFixture 共用
// 的单一真相源；须与 entry 的 `console.log('unbun-roundtrip value=' + 6*7)` 结果保持一致。
export const ROUNDTRIP_EXPECTED = 'unbun-roundtrip value=42'

export function buildRoundTripFixture({ outDir, name = 'rt-src' } = {}) {
  const here = dirname(fileURLToPath(import.meta.url))
  outDir = outDir || here
  const binPath = join(outDir, name)
  const expected = ROUNDTRIP_EXPECTED
  // 真计算（6*7=42）落进 marker：证明的是「源码语义」经 extract→rebuild 存活，而非常量透传。
  const src = [
    '// plain round-trip fixture entry（无资产 / 无原生依赖 → 可无损 extract→rebuild→run）',
    'const value = 6 * 7',
    "console.log('unbun-roundtrip value=' + value)",
    '',
  ].join('\n')

  const work = mkdtempSync(join(tmpdir(), 'unbun-rt-fixture-'))
  try {
    writeFileSync(join(work, 'entry.js'), src)
    console.error(`[fixture] bun build --compile → ${binPath}`)
    execFileSync('bun', ['build', '--compile', '--outfile', binPath, join(work, 'entry.js')], {
      stdio: ['ignore', 'inherit', 'inherit'],
    })
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
  return { binPath, expected }
}

if (import.meta.main) buildFixture()

// ──────────────────────────────────────────────────────────────────────────────────────────
// 共享 fixture 缓存（E8 提速）：把 ~94MB 的 `bun build --compile` SFX **建一次、跨 test-run / 跨独立
// invocation / 跨 worktree/peer 复用**（内容寻址键）。注：bun test 实测**单进程**（模块级缓存本可跨
// 同进程内测试文件），故文件系统缓存的真收益不在进程隔离，而在**跨多次 test-run、跨 CI/本地独立
// invocation、跨并发 worktree/peer** 复用同一份昂贵 SFX——避免每次冷跑都重付 ~94MB compile。
//
// 新鲜性/正确性（绝不缓存出陈旧假绿）：缓存键 = sha256(本文件源 + Bun 版本 + 变体参数) 前 16 hex。
// SFX 字节完全由「本文件的 entry 源 / 锚 / bun 运行时版本 / 变体参数」决定——三者任一变，键即变 →
// 自动重建，绝不复用旧 SFX。关键：**fixture 字节与被测 lib 代码（extract/module-graph/split/diff/
// naming/layout/hook）完全正交**（建 fixture 只用外部 `bun build --compile`，不经这些 lib）——故本缓存
// **不可能掩盖 lib 回归**：revert 任一被测源不改 fixture 键、测试照样对真 fixture 真跑 → 该红照红。
//
// 并发安全：每个缓存项落自己的 keyed 目录（binary 保留自然名，故 basename 语义不变）。构建先落临时
// 目录、再**原子 rename** 整目录进缓存位；若竞态中被别的进程抢先建好（rename 撞 ENOTEMPTY）→ 用赢家的。
//
// 淘汰（A9，防 `/tmp` 无界增长）：内容寻址键只增不删——改本文件 / 升 Bun / 换变体参数即换键，旧键
// （每变体 ~94MB SFX）滞留 `/tmp` 无界堆积。故每次命中/构建后 evictStale「用完顺手清」超龄（mtime > 7 天
// 未访问）的键目录；命中时 touchCacheDir 刷新当前键 mtime（LRU）使活跃键永不超龄。淘汰**绝不删在用键**
// （keepKey 豁免 + 只删 mtime 超阈值的明显陈旧键 + `.build-` 在建目录豁免），且是尽力而为、删失败吞错
// 继续（缓存命中/构建路径的错仍 fail-loud，只此清理旁路吞错）——详见 evictStale。
const CACHE_ROOT = join(tmpdir(), 'unbun-test-fixtures')
const SELF_SRC = readFileSync(fileURLToPath(import.meta.url))
const BUN_VERSION = typeof Bun !== 'undefined' ? Bun.version : process.version

// 淘汰阈值（A9）：键目录 mtime 超过此年龄（默认 7 天）未被命中/构建即视为陈旧、可回收。内容寻址缓存
// 只增不删——改 build-fixture.mjs / 升 Bun / 换变体参数即换键，旧键（每变体 ~94MB SFX）滞留 `/tmp`
// 无界堆积。7 天足够跨「同一开发批次的多次 test-run / 多 worktree 并发」复用，又能回收真正废弃的旧键。
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

function fixtureKey(variant, params) {
  const h = createHash('sha256')
  h.update(SELF_SRC)
  h.update(`\0${BUN_VERSION}\0${variant}\0${JSON.stringify(params)}`)
  return `${variant}-${h.digest('hex').slice(0, 16)}`
}

// touchCacheDir — 命中时刷新键目录 mtime（= LRU「最近访问时间」），使活跃使用的键始终「新鲜」、不被
// 超龄淘汰逐出。touch 是**非关键**旁路：失败（并发中被别的进程 rename 走 / 权限）吞错，绝不影响命中返回。
function touchCacheDir(dir) {
  try {
    const now = new Date()
    utimesSync(dir, now, now)
  } catch {
    // 尽力而为：touch 失败不影响缓存命中的正确性（大不了该键 mtime 不刷新、下次可能被超龄逐出后重建）。
  }
}

// evictStale — 「用完顺手清陈旧键」（A9）：扫 CACHE_ROOT 下的键目录，删掉 mtime 超龄（默认 7 天未访问）的。
// 并发安全（关键红线，多 peer/进程可能同时命中/构建）：绝不删别的进程正在用的键——三重保障：
//   ① keepKey（本次命中/构建的键）显式排除，纵使时钟异常/mtime 超龄也兜底不删；
//   ② 只淘汰 mtime「明显陈旧」（超阈值）的键——活跃使用的键每次命中被 touchCacheDir 刷新 mtime → 永远
//      新鲜、不被逐出；别的进程刚 rename 上架 / 刚 touch 的键其 mtime 也新 → 同样豁免（绝不误删在用键）；
//   ③ 淘汰是**尽力而为的非关键清理**：单个键 stat/删除失败（被占用 / 权限 / 竞态中被别的进程 rename 走）→
//      吞掉该错继续，绝不因淘汰失败让测试红（缓存构建/命中路径的错仍 fail-loud，只有这条清理旁路吞错）。
// 只跳过 `.` 前缀项（含别的进程在建的 `.build-XXXX` 临时目录）——绝不碰在建目录。root/maxAgeMs/now
// 参数化仅供测试注入（默认打到真 CACHE_ROOT）。
// 诚实的残余窗口（已知、可接受）：②的「命中即 touch」保鲜发生在 withCachedDir 的 existsSync 命中之后，
// 故存在一个 TOCTOU 微窗——若某键已冷却超 7 天，进程 B 正好首次命中它、而进程 A 在 B 的 existsSync 与
// B 真正 exec 该二进制之间跑 evictStale，A 会视其仍陈旧而删之 → B 随后 exec 撞 ENOENT。触发条件极窄
// （7 天冷键被两进程同一微秒窗口撞上），且：a) rebuild 自愈；b) Linux 上已 open/exec 的 fd（inode 保留至
// 关闭）不受 unlink 影响，只有「尚未启动的 exec」会 ENOENT。故属**尽力而为清理**可接受的假 RED，而非
// 数据损坏；「绝不删在用键」在此一微窗外成立、在窗内退化为「可能触发一次可自愈的重建」。
export function evictStale(keepKey, { maxAgeMs = CACHE_MAX_AGE_MS, now = Date.now(), root = CACHE_ROOT } = {}) {
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return // 缓存根不存在 / 读不了 → 无可淘汰，尽力而为直接返回。
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    if (ent.name.startsWith('.')) continue // `.build-XXXX` 等在建临时目录 → 绝不碰。
    if (ent.name === keepKey) continue // 本次在用键 → 绝不淘汰。
    const dir = join(root, ent.name)
    try {
      if (now - statSync(dir).mtimeMs <= maxAgeMs) continue // 新鲜（含别的进程刚建/刚 touch 的）→ 保留。
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // 淘汰尽力而为、非关键：stat/删除失败（被占用、权限、竞态中被 rename 走）→ 吞错继续下一个。
    }
  }
}

// 通用缓存包装：binName = 缓存目录内二进制的自然名（保 basename 语义）；builder(work) 把 fixture 建到
// work 目录（产出 work/<binName>）。命中即复用；未命中则建到临时目录再原子 rename 进 keyed 缓存目录。
function withCachedDir(variant, params, binName, builder) {
  mkdirSync(CACHE_ROOT, { recursive: true })
  const key = fixtureKey(variant, params)
  const finalDir = join(CACHE_ROOT, key)
  const finalBin = join(finalDir, binName)
  if (existsSync(finalBin)) {
    touchCacheDir(finalDir) // 命中：刷新 mtime（LRU），使活跃键保持新鲜、不被超龄淘汰。
    evictStale(key) // 用完顺手清陈旧键（当前键刚 touch、且被 keepKey 豁免 → 必然存活）。
    return finalBin // 新鲜命中：直接复用
  }
  const work = mkdtempSync(join(CACHE_ROOT, '.build-'))
  try {
    builder(work)
    if (!existsSync(join(work, binName))) {
      throw new Error(`cachedFixture: builder did not produce ${binName} in ${work}`)
    }
    try {
      renameSync(work, finalDir) // 原子上架（同一文件系统）
    } catch (e) {
      // 竞态：别的进程先建好了（finalDir 非空 → ENOTEMPTY）→ 用赢家的；否则是真错、抛。
      if (!existsSync(finalBin)) throw e
      rmSync(work, { recursive: true, force: true })
    }
    evictStale(key) // 构建后顺手清陈旧键（当前键刚上架、mtime 新鲜、且被 keepKey 豁免 → 必然存活）。
    return finalBin
  } catch (e) {
    rmSync(work, { recursive: true, force: true })
    throw e
  }
}

// cachedMiniFixture — 缓存版 buildFixture（plain 或 doubleMagic 变体）。返回 { miniPath }。
export function cachedMiniFixture({ doubleMagic = false } = {}) {
  const binName = doubleMagic ? 'mini-doublemagic' : 'mini'
  const miniPath = withCachedDir(binName, { doubleMagic }, binName, (work) =>
    buildFixture({ outDir: work, doubleMagic }))
  return { miniPath }
}

// cachedRoundTripFixture — 缓存版 buildRoundTripFixture。返回 { binPath, expected }。
export function cachedRoundTripFixture() {
  const binPath = withCachedDir('rt-src', {}, 'rt-src', (work) =>
    buildRoundTripFixture({ outDir: work }))
  return { binPath, expected: ROUNDTRIP_EXPECTED }
}

// cachedVersionAnchorFixture — 缓存版 buildVersionAnchorFixture。返回 { binPath, version }。
// binary 保留自然名（默认 `renamed-copy`）→ basename≠version 语义在缓存路径下仍成立。
export function cachedVersionAnchorFixture({ name = 'renamed-copy', version = '9.9.9' } = {}) {
  const binPath = withCachedDir('version-anchor', { name, version }, name, (work) =>
    buildVersionAnchorFixture({ outDir: work, name, version }))
  return { binPath, version }
}

// buildVersionAnchorFixture — 造一个**含 claude version 锚**的小 bun --compile SFX，产物文件名可任意
// （默认 basename≠version），专供 E3 = A4 的 outdir 命名一致性测试：证明 extract/assets/layout 都从
// **入口 blob 解析 version**（parseVersion 的 P0-d 锚）命名，而非文件 basename，故对同一二进制产出同一
// `claude-code-<version>` 目录，即便 basename≠version（换名副本 / SFX）。
//
// 关键：入口正文内联 parseVersion 的**真锚**（`{PACKAGE_URL:"@anthropic-ai/claude-code",README_URL:…,
// VERSION:"<v>"}` 对象字面量、有副作用赋值防 tree-shake）；且必须 `--minify-whitespace` —— 否则 bun
// bundler 会在 `:` 后加空格（`PACKAGE_URL: "…"`），破坏 parseVersion 的 minified 形态锚（实测已证）。
// 返回 { binPath, version }。产物落临时 outDir（测试自建、afterAll 清），不入库。
export function buildVersionAnchorFixture({ outDir, name = 'renamed-copy', version = '9.9.9' } = {}) {
  const here = dirname(fileURLToPath(import.meta.url))
  outDir = outDir || here
  const binPath = join(outDir, name)
  // 对象字面量形态锚（非字符串字面量 —— 字符串里内层 `"` 会被转义成 `\"`、打不中 parseVersion 正则）。
  const anchorObj = `{PACKAGE_URL:"@anthropic-ai/claude-code",README_URL:"https://x",VERSION:"${version}"}`
  const src = [
    '// version-anchor fixture entry（内联 claude version 真锚 P0-d，供 E3 命名一致性测试）',
    `globalThis.__unbun_meta = ${anchorObj}`,
    'console.log(globalThis.__unbun_meta.VERSION.length)',
    '',
  ].join('\n')

  const work = mkdtempSync(join(tmpdir(), 'unbun-va-fixture-'))
  try {
    writeFileSync(join(work, 'entry.js'), src)
    console.error(`[fixture] bun build --compile --minify-whitespace → ${binPath}`)
    execFileSync('bun', ['build', '--compile', '--minify-whitespace', '--outfile', binPath, join(work, 'entry.js')], {
      stdio: ['ignore', 'inherit', 'inherit'],
    })
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
  return { binPath, version }
}
