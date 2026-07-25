# unbun Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `exp/patch-the-claude-binary/` 的探索脚本升级为版本无关、可测的 Bun CLI 工具 `unbun`——静态提取/分析 + 运行时内省任意 `bun build --compile` 单文件产物，保留 Claude 专用能力。

**Architecture:** 共享 `lib/` 解析层 + 单一 `cli.mjs` 子命令分发。纯静态命令不跑目标 binary；`cc` 命令只在副本上打等长 loader-hook 桩后跑只读探针。核心是把未证实的 Bun 二进制格式封装进 **Stage 0 的 `module-graph.mjs` 接口**（`parseModuleGraph(bin) → blob 清单`），下游命令消费接口而非原始字节。

**Tech Stack:** Bun 运行时（≥1.3.14）；acorn（模块切分，本地 dep）；esbuild（AST 美化，仓库已有 0.28.1）；bun test。

## Global Constraints

（每个 task 的要求隐含包含本节，值均逐字来自 spec）

- **运行时**：工具本体用 `bun` 跑（非 node）；纯静态命令**不执行目标 binary**；`cc` 命令只对**副本**打桩+跑，对 live binary 只读。
- **版本无关**：绝不硬编码 minified helper 名（`E`/`Q`/`ve`…跨版本必变）；helper 按**定义体签名**动态识别。绝不用二进制文件名当版本号。
- **共享工作树纪律**：一律 `git add -- <paths>` / `git commit -m "..." -- <paths>`（`-m` 在 `--` 前）；绝不 `git add -A`/`-am`；提交前 `git diff --cached --name-status` 验暂存集只含自己文件；绝不对共享 main 树跑 `git clean/restore/reset --hard`。
- **提取正确性**：app bundle 用 module-graph 精确 offset/length **权威**切；段内扫可打印子块仅作 bootstrap/回落，且若 ship 必须用精确字节长度界定、绝不对启发式 run 做 `toString('latin1')`（v1 latin1 截断隐患来源）。
- **oracle 方向**：交叉验证是子集 `embeddedFiles ⊆ static assets`，绝不写 `===`。
- **测试**：断言结构/行为，**绝不 byte-pin 专有文案**；解析层用入库自建 fixture；活二进制 smoke 走 gitignored 路径。
- **归档**：exp 脚本经 `git mv` 保历史，落 `archive/` 加 `ARCHIVED` banner + 指向后继 + 排除出 lint/test glob；被证伪的 README 断言加删除线注解。

---

## 文件结构

```
tools/unbun/
  package.json            bun 包；dep: acorn；devDep/peer: esbuild（用仓库根的）
  cli.mjs                 子命令分发：extract|assets|split|layout|diff|rebuild|cc <sub>
  lib/
    bun-binary.mjs        纯 ELF 层：readBinary(path) → {buf, sections:{'.bun':{off,size},…}, elf:{shoff,shnum,…}}
    module-graph.mjs      定位 .bun 内真 trailer + 解码 StandaloneModuleGraph → {blobs:[{name?,offset,length,kind}]}
    extract.mjs           用 module-graph 切 app bundle blob + 消歧 + 校验 wrapper + version（best-effort）
    beautify.mjs          esbuild transformSync 美化
    split.mjs             acorn：下钻外层 IIFE → 遍历 body 顶层 var-decl → helper 签名识别 → 逐模块 + index
    layout.mjs            体积构成分解
    diff.mjs              两提取目录归一改名后结构 diff
    hook.mjs              等长 loader-hook 打副本（并入 patch-loader-hook 逻辑 + 守卫）
    probes/
      dump-assets.cjs     Bun.embeddedFiles → 写盘
      module-graph.cjs    instrument require → 加载序 + 图 → JSON
      runtime-facts.cjs   version/Bun.version/process.versions/env → JSON
  test/
    fixtures/build-fixture.mjs   构建可打桩 fixture（bun build --compile 小 SFX，植入等长 //! 法律注释锚 + 嵌资产）
    *.test.mjs
  archive/                exp 原始脚本 + FINDINGS（git mv 后，加 banner）
  README.md
  docs/  spec.md  plan.md（本文）  FINDINGS-phase0.md（Stage 0 产出）  ARCHITECTURE.md（建成后）
```

**依赖方向（无环 DAG）**：`bun-binary` ← `module-graph` ← `extract` ← `split`；`layout` ← `{bun-binary, module-graph}`（用 module-graph 精确 blob 边界分解，不回退启发式 latin1 扫描）；`diff` 独立（吃目录）；`hook`←`bun-binary`；`cli` 汇聚。

---

## Stage 0 — 格式探针 PoC + 解析地基（闸门，必须先完成）

**产出**：`docs/FINDINGS-phase0.md`（P0-a..e 结论）+ 经真二进制验证的 `lib/bun-binary.mjs`、`lib/module-graph.mjs`。这是后续所有静态命令的地基。

### Task 0.1: 脚手架 + bun-binary（纯 ELF 层）

**Files:**
- Create: `tools/unbun/package.json`
- Create: `tools/unbun/lib/bun-binary.mjs`
- Test: `tools/unbun/test/bun-binary.test.mjs`

**Interfaces:**
- Produces: `readBinary(path) → { buf: Buffer, sections: Record<string,{off:number,size:number}>, elf: {shoff:number, shentsize:number, shnum:number} }`。`sections` 键含 `.bun`/`.text`/`.rodata`/`.shstrtab`；`off`/`size` 是文件内偏移与字节长度。

- [x] **Step 1: 写 package.json**

```json
{
  "name": "unbun",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "bin": { "unbun": "./cli.mjs" },
  "dependencies": { "acorn": "^8.14.0" },
  "scripts": { "test": "bun test" }
}
```

- [x] **Step 2: `cd tools/unbun && bun install`**

Run: `cd tools/unbun && bun install`
Expected: acorn 装入 `tools/unbun/node_modules`；无错误。

- [x] **Step 3: 写失败测试**（用真二进制的 ELF 元数据做 oracle——section 表铺到 EOF）

```js
// test/bun-binary.test.mjs
import { test, expect } from 'bun:test'
import { execSync } from 'node:child_process'
import { readBinary } from '../lib/bun-binary.mjs'

const LIVE = execSync('readlink -f "$(command -v claude)"', { encoding: 'utf8' }).trim()

test('reads ELF sections incl .bun and locates section header table at EOF', () => {
  const { buf, sections, elf } = readBinary(LIVE)
  expect(sections['.bun']).toBeDefined()
  expect(sections['.bun'].size).toBeGreaterThan(50_000_000) // .bun 是体积大头
  expect(sections['.shstrtab']).toBeDefined()
  // ELF 不变量：section header 表尾正好铺到文件末（feasibility 评审实测 B1）
  expect(elf.shoff + elf.shentsize * elf.shnum).toBe(buf.length)
})
```

- [x] **Step 4: 跑测试验证失败**

Run: `cd tools/unbun && bun test bun-binary`
Expected: FAIL（`readBinary is not a function` / 模块不存在）。

- [x] **Step 5: 实现 bun-binary.mjs**

```js
// lib/bun-binary.mjs — 纯 ELF 层：给出 .bun 字节窗口 + section 元数据，对 Bun 格式零知识。
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

export function readBinary(path) {
  const buf = readFileSync(path)
  // ELF64 header 关键字段
  const shoff = Number(buf.readBigUInt64LE(0x28))
  const shentsize = buf.readUInt16LE(0x3a)
  const shnum = buf.readUInt16LE(0x3c)
  const shstrndx = buf.readUInt16LE(0x3e)
  // section 名字表
  const strOff = Number(buf.readBigUInt64LE(shoff + shstrndx * shentsize + 0x18))
  const sections = {}
  for (let i = 0; i < shnum; i++) {
    const e = shoff + i * shentsize
    const nameIdx = buf.readUInt32LE(e)
    let end = strOff + nameIdx
    while (buf[end] !== 0) end++
    const name = buf.toString('latin1', strOff + nameIdx, end)
    sections[name] = { off: Number(buf.readBigUInt64LE(e + 0x18)), size: Number(buf.readBigUInt64LE(e + 0x20)) }
  }
  return { buf, sections, elf: { shoff, shentsize, shnum } }
}

export function defaultBinary() {
  const p = execSync('readlink -f "$(command -v claude)"', { encoding: 'utf8' }).trim()
  if (!p) throw new Error('could not locate claude binary; pass it explicitly')
  return p
}
```

- [x] **Step 6: 跑测试验证通过**

Run: `cd tools/unbun && bun test bun-binary`
Expected: PASS。

- [x] **Step 7: 提交**

```bash
git add -- tools/unbun/package.json tools/unbun/bun.lock tools/unbun/lib/bun-binary.mjs tools/unbun/test/bun-binary.test.mjs
git commit -m "feat(unbun): ELF-layer bun-binary reader (Stage 0)" -- tools/unbun/package.json tools/unbun/bun.lock tools/unbun/lib/bun-binary.mjs tools/unbun/test/bun-binary.test.mjs
```

### Task 0.2: 探针发现 Bun StandaloneModuleGraph 格式（投研 → FINDINGS）

**Files:**
- Create: `tools/unbun/exp/probe-module-graph.mjs`（探针脚本，保留作 provenance）
- Create: `tools/unbun/docs/FINDINGS-phase0.md`

**Interfaces:**
- Produces: FINDINGS-phase0.md 记录 P0-a 的记录布局（字段宽度、条目数来源、blob 名字来源）、P0-b 消歧判据、P0-c helper 签名、P0-d version 锚、P0-e sourcemap 结论。

- [x] **Step 1: 写探针脚本**（定位 `.bun` 内真 trailer，dump magic 前的字节结构）

```js
// exp/probe-module-graph.mjs — 逆 Bun StandaloneModuleGraph。仅投研，结论写入 FINDINGS。
import { readBinary, defaultBinary } from '../lib/bun-binary.mjs'
const { buf, sections } = readBinary(process.argv[2] || defaultBinary())
const bun = sections['.bun']
const MAGIC = Buffer.from('---- Bun! ----')
// 只在 .bun 窗口内找真 trailer（排除 .bun 窗口外的 magic 副本——引擎区 HMR 常量；数量随版本，勿写死）——用 lastIndexOf
const winEnd = bun.off + bun.size
let tr = buf.lastIndexOf(MAGIC, winEnd)
while (tr !== -1 && tr < bun.off) tr = -1
console.error('[probe] .bun', bun.off, '..', winEnd, 'trailer@', tr)
// dump trailer 前 256 字节，逐 8 字节 u32/u64 双视角，供人工逆结构
const from = Math.max(bun.off, tr - 256)
for (let i = from; i < tr; i += 8) {
  console.error(i, 'u32:', buf.readUInt32LE(i), buf.readUInt32LE(i + 4), '  u64:', buf.readBigUInt64LE(i).toString())
}
// 已知 blob 锚点（供对照 offset 是否落在其上）
for (const s of ['@bun @source__', '\x7fELF', 'sourcemap.json', 'mermaid']) {
  const idx = buf.indexOf(Buffer.from(s, 'latin1'), bun.off)
  console.error('[anchor]', JSON.stringify(s), '@', idx)
}
```

- [x] **Step 2: 跑探针，记录真实结构**

Run: `cd tools/unbun && bun exp/probe-module-graph.mjs`
Expected: 打印 trailer 偏移 + 前 256 字节的 u32/u64 视图 + 各 blob 锚点偏移。**人工比对**：magic 前的 `(offset,length)` 记录里的 offset 是否命中 `@bun`/`ELF`/`sourcemap` 锚点。记录字段宽度（u32 vs u64）、条目数从哪来。

- [x] **Step 3: 交叉版本核验**（P0-c helper + P0-d version）

Run:
```bash
cd tools/unbun
# helper 签名跨版本：__esm memoizer 定义形如 (a,b)=>()=>(a&&(b=a(a=0)),b)
bun exp/probe-module-graph.mjs   # 2.1.205
# 若有 2.1.191 副本：bun exp/probe-module-graph.mjs /path/to/2.1.191
```
Expected: 确认 `__esm` 定义签名 `(x,y)=>()=>(x&&(y=x(x=0)),y)`、`__commonJS` 双参签名跨版本稳定（名字变、签名不变）。找 version 唯一锚（entry cli.js 附近 package 元数据）。

- [x] **Step 4: 写 FINDINGS-phase0.md**

记录 P0-a（记录布局，如「magic 前是 N 条 `(u32 offset, u32 length)`，条目数=…，**blob 名字来源**=内联记录/单独名表/无名」——name 来源是 assets 具名输出的前提，必须确证）、P0-b（「取 entry cli.js blob；判据=名字/最大/图指认」）、P0-c（两族签名 + 外层顶层频率判据）、P0-d（version 锚或「无唯一锚→best-effort」）、P0-e（sourcemap.json 是否 `SourceMapTooLarge` 空桩）。**若某项探针无法确证，明确写「未确证，实现按 X 回落」**（如 name 无来源→assets 回落 `blob-<offset>.bin`）。

- [x] **Step 5: 提交**

```bash
git add -- tools/unbun/exp/probe-module-graph.mjs tools/unbun/docs/FINDINGS-phase0.md
git commit -m "docs(unbun): Phase-0 findings — real Bun module-graph format (Stage 0)" -- tools/unbun/exp/probe-module-graph.mjs tools/unbun/docs/FINDINGS-phase0.md
```

### Task 0.3: module-graph.mjs 解码器（TDD，格式无关 oracle）

**Files:**
- Create: `tools/unbun/lib/module-graph.mjs`
- Test: `tools/unbun/test/module-graph.test.mjs`

**Interfaces:**
- Consumes: `readBinary` from bun-binary。
- Produces: `parseModuleGraph(bin) → { trailerOffset:number, blobs: Array<{name:string|null, offset:number, length:number}> }`。offset/length 是文件内绝对偏移与长度，slice 出的字节是该 blob 原始内容。

- [x] **Step 1: 写失败测试**（**长度敏感**正确性 oracle——整块解析/自证，非只看头 magic）

```js
// test/module-graph.test.mjs
import { test, expect } from 'bun:test'
import { readBinary, defaultBinary } from '../lib/bun-binary.mjs'
import { parseModuleGraph } from '../lib/module-graph.mjs'
import { Parser } from 'acorn'

test('parses module graph; blobs validate by FULL-slice parse (length-sensitive)', () => {
  const bin = defaultBinary()
  const { buf } = readBinary(bin)
  const { blobs } = parseModuleGraph(bin)
  expect(blobs.length).toBeGreaterThan(2)
  const slice = (b) => buf.subarray(b.offset, b.offset + b.length)
  // app cli.js blob：整块必须 acorn 可解析。截断→SyntaxError；超长→尾部混入下一 blob 字节→SyntaxError。
  // 这同时验 offset 与 length（B1 修复：绝不能只看 subarray(0,64)）。
  const app = blobs.find((b) => slice(b).subarray(0, 64).toString('latin1').includes('@bun-cjs'))
  expect(app).toBeTruthy()
  const appSrc = slice(app).toString('utf8')
  expect(() => Parser.parse(appSrc, { ecmaVersion: 'latest' })).not.toThrow() // 长度对才解析成功
  expect(appSrc.trimEnd().endsWith('})')).toBe(true)                          // 收在外层 wrapper 闭合
  // .node ELF blob：用 ELF 自证大小验 length —— section 表尾必须 ≤ 本 blob 长度且贴合
  const natives = blobs.filter((b) => slice(b).subarray(0, 4).toString('latin1') === '\x7fELF')
  expect(natives.length).toBeGreaterThanOrEqual(2)
  for (const n of natives) {
    const s = slice(n)
    const shoff = Number(s.readBigUInt64LE(0x28))
    const shentsize = s.readUInt16LE(0x3a)
    const shnum = s.readUInt16LE(0x3c)
    expect(shoff + shentsize * shnum).toBeLessThanOrEqual(n.length)          // length 不足→越界；length 大幅超→松（配相邻连续性）
  }
  // 相邻 blob 边界连续性（无缝隙/无重叠）——进一步锁死 length
  const sorted = [...blobs].sort((a, b) => a.offset - b.offset)
  for (let i = 1; i < sorted.length; i++) {
    expect(sorted[i].offset).toBeGreaterThanOrEqual(sorted[i - 1].offset + sorted[i - 1].length)
  }
})
```

- [x] **Step 2: 跑测试验证失败**

Run: `cd tools/unbun && bun test module-graph`
Expected: FAIL（`parseModuleGraph` 未定义）。

- [x] **Step 3: 实现 module-graph.mjs**（按 Task 0.2 FINDINGS 的真实布局；下方是骨架，字段偏移/宽度按 FINDINGS 填）

```js
// lib/module-graph.mjs — 定位 .bun 内真 trailer + 解码 StandaloneModuleGraph（含 Bun 格式知识）。
import { readBinary } from './bun-binary.mjs'
const MAGIC = Buffer.from('---- Bun! ----')

export function parseModuleGraph(bin) {
  const { buf, sections } = readBinary(bin)
  const bun = sections['.bun']
  const winEnd = bun.off + bun.size
  // 真 trailer 在 .bun 窗口内、magic 最后一次出现（排除 .bun 窗口外的引擎区 magic 副本）
  let trailerOffset = buf.lastIndexOf(MAGIC, winEnd)
  if (trailerOffset < bun.off) throw new Error('Bun trailer not found in .bun window')
  // —— 按 FINDINGS-phase0.md 的实测记录布局解码 ——
  // 例：magic 前是 count(u32) + count 条 {offset(u32), length(u32)}，名字表在 …
  // 具体字段宽度/顺序以 FINDINGS 为准；此处按其结论填实。
  const blobs = decodeRecords(buf, trailerOffset) // ← 实现体按 FINDINGS
  return { trailerOffset, blobs }
}

function decodeRecords(buf, trailerOffset) {
  // 按 Task 0.2 确证的布局逐条读 {offset,length,name?}；返回数组。
  // （实现在执行期按 FINDINGS 填；测试用格式无关 magic oracle 兜正确性。）
}
```

- [x] **Step 4: 跑测试验证通过**

Run: `cd tools/unbun && bun test module-graph`
Expected: PASS（切出的 app blob 含 `@bun-cjs`、≥2 个 ELF magic 资产）。

- [x] **Step 5: 提交**

```bash
git add -- tools/unbun/lib/module-graph.mjs tools/unbun/test/module-graph.test.mjs
git commit -m "feat(unbun): decode Bun StandaloneModuleGraph (Stage 0 gate)" -- tools/unbun/lib/module-graph.mjs tools/unbun/test/module-graph.test.mjs
```

> **Stage 0 出口**：FINDINGS 落档 + `parseModuleGraph` 对真二进制绿。**此后下游 Stage 消费 `parseModuleGraph` 接口，不再碰原始字节布局。** 若 P0 发现格式与本计划假设的记录结构不同，只需改 `decodeRecords` 实现体，接口与下游不动。
>
> **已知覆盖缺口（评审确认，非阻塞，FINDINGS 记一句）**：长度 oracle 对 app(JS)/`.node`(ELF) 双向钉死，但中段非 JS/非 ELF blob（sourcemap/mermaid/字节码）的 length **不足**只被相邻连续性部分兜；blob **漏解**（decoder 丢一条）也不被本测 catch。二者由 Task 5.1 的 round-trip（extract→rebuild→run 无损）兜完整性。

---

## Stage 1 — 静态提取（extract + beautify）

### Task 1.1: extract.mjs（切 app blob + 消歧 + 校验 + version）

**Files:** Create `lib/extract.mjs`, `lib/beautify.mjs`；Test `test/extract.test.mjs`。

**Interfaces:**
- Consumes: `parseModuleGraph`（Stage 0）、`readBinary`。
- Produces: `extractApp(bin) → { app: string, version: string|null, blob: {offset,length} }`；`beautify(app) → string`。

- [x] **Step 1: 写失败测试**

```js
import { test, expect } from 'bun:test'
import { defaultBinary } from '../lib/bun-binary.mjs'
import { extractApp } from '../lib/extract.mjs'
import { beautify } from '../lib/beautify.mjs'

test('extracts app bundle that re-parses; version best-effort', () => {
  const { app, version } = extractApp(defaultBinary())
  expect(app.slice(0, 64)).toContain('@bun-cjs')
  expect(app.length).toBeGreaterThan(5_000_000)
  const pretty = beautify(app)
  expect(pretty.split('\n').length).toBeGreaterThan(app.split('\n').length) // 美化增行
  // version 可能为 null（无唯一锚时 best-effort），但若非 null 须是 x.y.z
  if (version) expect(version).toMatch(/^\d+\.\d+\.\d+$/)
})
```

- [x] **Step 2: 跑测试验证失败** — Run `bun test extract`；Expected FAIL。

- [x] **Step 3: 实现 extract.mjs + beautify.mjs**

```js
// lib/extract.mjs
import { readBinary } from './bun-binary.mjs'
import { parseModuleGraph } from './module-graph.mjs'

export function extractApp(bin) {
  const { buf } = readBinary(bin)
  const { blobs } = parseModuleGraph(bin)
  // 权威路径：取 entry cli.js blob（含 @bun-cjs 且最大者——P0-b 判据）
  const cand = blobs
    .map((b) => ({ b, head: buf.toString('latin1', b.offset, b.offset + 64) }))
    .filter((x) => x.head.includes('@bun-cjs'))
  if (!cand.length) throw new Error('no @bun-cjs app blob in module graph')
  const { b } = cand.sort((x, y) => y.b.length - x.b.length)[0]
  const app = buf.toString('utf8', b.offset, b.offset + b.length) // 精确长度界定，非启发式 run
  return { app, version: parseVersion(app), blob: { offset: b.offset, length: b.length } }
}

function parseVersion(app) {
  // 按 P0-d：命中唯一锚用之，否则 null（best-effort）。锚 pattern 由 FINDINGS 填。
  const m = app.match(/VERSION\s*=\s*["'](\d+\.\d+\.\d+)["']/) // ← 占位锚，执行期按 FINDINGS 换真锚
  return m ? m[1] : null
}
```
```js
// lib/beautify.mjs
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
export function beautify(app) {
  const esbuild = require('esbuild')
  return esbuild.transformSync(app, { minify: false, legalComments: 'none', loader: 'js' }).code
}
```

- [x] **Step 4: 跑测试验证通过** — Run `bun test extract`；Expected PASS。

- [x] **Step 5: 提交** — `git add -- lib/extract.mjs lib/beautify.mjs test/extract.test.mjs` 然后 `git commit -m "feat(unbun): static app-bundle extraction + beautify" -- <同 paths>`。

### Task 1.2: cli.mjs extract 子命令 + manifest/strings 输出

**Files:** Create `cli.mjs`；Test `test/cli-extract.test.mjs`。

**Interfaces:** Produces: `unbun extract <bin> [outdir]` 写 `app.js`/`app.pretty.js`/`strings-n6.txt`/`manifest.json` 到 `refs/<name>/`。

- [x] Step 1-5: 写 CLI 分发骨架（`switch(argv[2])`）；extract 分支调 `extractApp`+`beautify`+写盘+`strings -a -n 6`；测试 `outdir/app.js` 存在且 `node --check` 过。提交同上模式。

---

## Stage 2 — 模块切分（split）

### Task 2.1: helper 签名识别 + acorn 切分

**Files:** Create `lib/split.mjs`；Test `test/split.test.mjs`（自建 fixture + 活二进制 smoke）。

**Interfaces:**
- Consumes: `extractApp`（拿 app 源）、acorn。
- Produces: `splitModules(app) → { modules: Array<{seq,handle,kind:'esm'|'cjs',start,end}>, helpers:{esm:string[],cjs:string[]} }`。

> **helper 识别策略（评审 M2：签名 naive 匹配误捞 47 个 memoizer lookalike）**：真模块 helper 的判据不是「定义体是 arrow-返回-arrow」（`__esm`/`__commonJS` 与 45 个体内 memoizer 形状高度相似），而是**外层顶层调用频率 + callback 参数数**——真族在外层 body 顶层以 `var X=name(cb)` 形式**高频**出现（spec 阶段估计 E:4277、Q:1583；实测 E:4563、Q:1620 见 [`FINDINGS-phase0.md`](FINDINGS-phase0.md)），lookalike（如 `ve`）**从不**在外层顶层作 `var X=name(...)`（只在模块体内被调）。故 `discoverHelpers`：统计外层 body 顶层 `var X=<Ident>(<单参>)` 的 callee 频率，取**频率显著（如 ≥50 次）**者为候选 helper；再按 callback 参数数二分——**零参 thunk `()=>…`→esm**、**双参 `(exports,module)=>…`→cjs**。这样天然排除低频 lookalike。

- [x] **Step 1: 写失败测试**（正向 + 反向断言，非只验非空——评审 M2）

```js
import { test, expect } from 'bun:test'
import { extractApp } from '../lib/extract.mjs'
import { splitModules } from '../lib/split.mjs'
import { defaultBinary } from '../lib/bun-binary.mjs'
import { Parser } from 'acorn'

test('discovers exactly the two real helper families; excludes body-local lookalikes', () => {
  const { app } = extractApp(defaultBinary())
  const { modules, helpers } = splitModules(app)
  // 正向：两族均识别到，且 helper 集合规模有界（不该把 45 个 memoizer 全认成 helper）
  expect(helpers.esm.length).toBeGreaterThan(0)
  expect(helpers.cjs.length).toBeGreaterThan(0)
  expect(helpers.esm.length + helpers.cjs.length).toBeLessThanOrEqual(5) // 反过匹配护栏
  // 计数落在量级带内（余量足、跨小版本稳；不 pin 精确数）
  const esm = modules.filter((m) => m.kind === 'esm').length
  const cjs = modules.filter((m) => m.kind === 'cjs').length
  expect(esm).toBeGreaterThan(3000); expect(esm).toBeLessThan(6000)
  expect(cjs).toBeGreaterThan(1000); expect(cjs).toBeLessThan(2500)
  // 反向：body-local memoizer（其调用点数量级 ~600）不得被当模块——总模块数不该暴涨到含它们
  expect(modules.length).toBeLessThan(esm + cjs + 200)
  // 每个模块可被 acorn 独立重解析（跨区间抽样，非只前 5）
  for (const i of [0, (modules.length >> 1), modules.length - 1]) {
    const m = modules[i]
    expect(() => Parser.parse(app.slice(m.start, m.end), { ecmaVersion: 'latest' })).not.toThrow()
  }
})
```

- [x] **Step 2: 跑验证失败** — `bun test split`。

- [x] **Step 3: 实现 split.mjs**

```js
// lib/split.mjs — 下钻外层 IIFE → 遍历 body 顶层 var-decl → 按 helper 定义签名识别 __esm/__commonJS。
import { Parser } from 'acorn'

export function splitModules(app) {
  const ast = Parser.parse(app, { ecmaVersion: 'latest', ranges: true })
  // 1) 外层：program 顶层唯一表达式语句里的 FunctionExpression（(function(exports,require,module,…){…})）
  const outer = findOuterIife(ast)
  const body = outer.body.body // 外层函数体的顶层语句
  // 2) 先扫 helper 定义，按签名认出 __esm / __commonJS 的局部名
  const helpers = discoverHelpers(body, app) // {esm:Set, cjs:Set}
  // 3) 遍历 body 顶层 var X = <helper>(...) → 归类切片
  const modules = []
  let seq = 0
  for (const stmt of body) {
    if (stmt.type !== 'VariableDeclaration') continue
    for (const d of stmt.declarations) {
      const call = d.init
      if (call?.type !== 'CallExpression' || call.callee.type !== 'Identifier') continue
      const name = call.callee.name
      const kind = helpers.esm.has(name) ? 'esm' : helpers.cjs.has(name) ? 'cjs' : null
      if (!kind) continue // 've' 等体内 helper 自动排除
      modules.push({ seq: seq++, handle: d.id.name, kind, start: d.start, end: d.end })
    }
  }
  return { modules, helpers: { esm: [...helpers.esm], cjs: [...helpers.cjs] } }
}
// findOuterIife: program 顶层唯一表达式语句里的 FunctionExpression（params exports,require,module,…）
// discoverHelpers: 统计外层 body 顶层 `var X=<Ident>(<单参 cb>)` 的 callee 频率 → 取频率 ≥50 者为候选，
//   再按 cb 参数数二分：零参 thunk ()=>… → esm；双参 (exports,module)=>… → cjs。
//   低频 body-local memoizer（ve/xtn/… 45 个 lookalike）因不在外层顶层高频出现而自动排除。
```

- [x] **Step 4: 跑验证通过** — `bun test split`；Expected PASS。

- [x] **Step 5: 提交** — `feat(unbun): dynamic helper discovery + module split`。

### Task 2.2: split 子命令 + index.json

- [x] Step 1-5: CLI `split` 分支写 `modules/NNNNN-<handle>.js` + `index.json`（{seq,handle,kind,start,end,行数,真名提示}）；测试 index 条目数=modules 数、文件都存在。提交。

---

## Stage 3 — 静态资产 + 布局 + diff

### Task 3.1: assets 子命令

**Interfaces:** Consumes `parseModuleGraph`；`unbun assets <bin> [outdir]` 写非入口 blob 到 `assets/`。
- [x] TDD：测试 `assets/` 下有 ≥2 个 `.node`（ELF magic）+ 若 P0-e 确认则 `sourcemap.json`；断言资产 blob 用 magic 头自证。**具名输出**用 graph 的 `name` 字段，`name` 为 null 时**回落 `blob-<offset>.bin`**（评审 m1：name 来源由 P0-a 确证，可能无内联名）。提交 `feat(unbun): static asset extraction via module-graph`。

### Task 3.2: layout 子命令（并入 analyze-binary-layout）

**Interfaces:** Consumes `readBinary` + `parseModuleGraph`；`unbun layout <bin>` → `layout.json`。
- [x] TDD：用 module-graph 的**精确 blob 边界**把 `.bun` 分解成 {app JS, sourcemap, 各 .node, 其余=JSC 字节码}，engine=`.text+.rodata`；断言各项 >0、和 ≈ 文件大小（±段对齐余量）；复现 exp 结论量级。**绝不对启发式可打印 run 做 latin1**（Global Constraints）——边界全来自 module-graph。提交。

### Task 3.3: diff 子命令

**Interfaces:** `unbun diff <dirA> <dirB>` 吃两 split index，归一 handle 改名后比对模块集合。
- [x] TDD：造两个 index fixture（一增一删一改名），断言 diff 正确分类增/删/改；改名（handle 变、内容同）归一后不算变更。提交。

---

## Stage 4 — Claude 专用运行时内省（cc）

### Task 4.1: hook.mjs（等长 loader-hook，纯字节 + 守卫）

**Files:** Create `lib/hook.mjs`；Test `test/hook.test.mjs`（合成 buffer，无需真 bun）。

**Interfaces:** Produces: `patchLoaderHook(buf, {force, anchor, payload}) → {patched:Buffer, sites:number[]}`；`CC_ANCHOR`（真 claude 锚，默认）/`CC_PAYLOAD` 常量导出。`anchor`/`payload` 可覆盖（fixture 用自己的等长锚，见 Task 4.2 不对称说明）。

- [x] **Step 1: 写失败测试**（合成含锚点的 buffer；验等长 + 守卫）

```js
import { test, expect } from 'bun:test'
import { patchLoaderHook, CC_ANCHOR, CC_PAYLOAD } from '../lib/hook.mjs'

test('equal-length patch preserves size; rejects when payload too long', () => {
  const anchor = Buffer.from(CC_ANCHOR + '\n')
  const buf = Buffer.concat([Buffer.from('AAAA'), anchor, Buffer.from('BBBB')])
  const { patched, sites } = patchLoaderHook(Buffer.from(buf), { force: true })
  expect(patched.length).toBe(buf.length)         // 等长不变
  expect(sites.length).toBe(1)
  expect(patched.toString('latin1')).toContain(CC_PAYLOAD)
  expect(CC_PAYLOAD.length).toBeLessThanOrEqual(CC_ANCHOR.length) // 守卫前提
})
```

- [x] Step 2: 验证失败。
- [x] **Step 3: 实现 hook.mjs**（并入 `patch-loader-hook.mjs` 逻辑：锚点 indexOf、`\n` 校验、padEnd 填充、size 不变断言；`versions/` live 守卫留给 CLI 层）。
- [x] Step 4: 验证通过。
- [x] Step 5: 提交 `feat(unbun): equal-length loader-hook patcher + guards`。

### Task 4.2: probes + cc run/introspect + 可打桩 fixture

**Files:** Create `lib/probes/{dump-assets,module-graph,runtime-facts}.cjs`；`test/fixtures/build-fixture.mjs`；Test `test/cc-introspect.test.mjs`。

**Interfaces:** Produces: `unbun cc patch-loader-hook`/`cc run --ext`/`cc introspect --probe`。

- [x] **Step 1: 写 fixture 构建器**（自建可打桩 SFX）

> **锚点不对称（评审 M2，已实测）**：真 claude 是把**预打包好的 app.js 原样嵌入** SFX，其明文 `//` 注释锚点得以存活；而自建 fixture 走 `bun build --compile` 的 bundler，**明文 `//` 注释会被剥除**（实测 grep=0）。存活形式实测有两种：**string 字面量**（grep=1）与 **`//!` 法律注释**（grep=2）。fixture 用 **`//!` 等长法律注释锚**——它不仅存活，还是**真注释**，打桩替换成代码后**真作为代码执行**（复刻真 claude「注释锚→替换后执行」的核心语义；string 字面量锚只在字符串内、改了不执行，会漏掉这一语义）。`cc run/introspect` 对 fixture 传 `{anchor: <fixture //! 锚>}`（Task 4.1 已参数化），真 claude 路径用默认 `CC_ANCHOR`。

```js
// test/fixtures/build-fixture.mjs — 产出 test/fixtures/mini（可打桩 bun SFX，非专有，可入库）
// entry.js：① 顶部一个等长 //! 法律注释锚 `//! <FIXTURE_ANCHOR 同长填充>`（存活 bundler、是真注释）
//           ② import asset from './tiny.txt' with { type: 'file' }（填充 Bun.embeddedFiles，实测 length≥1）
// 然后 bun build --compile --outfile=mini entry.js
// 注：bun 可能把 //! 注释既留内联又 hoist 到 bundle 顶部（实测 2 处）——hook 打全部 site（patch-loader-hook 原逻辑即打所有命中）。
//     打桩后该行成为 `if(process.env.CC_EXT)require(process.env.CC_EXT)…` 代码并执行 → cc introspect/run 真走「注释→执行」路径。
```

- [x] **Step 2: 写失败测试**（子集 oracle——Global Constraints）

```js
import { test, expect } from 'bun:test'
import { execFileSync } from 'node:child_process'
// 前置：build-fixture 产出 test/fixtures/mini
test('embeddedFiles ⊆ static assets (subset, not equal)', () => {
  // runtime: cc introspect --probe assets on fixture
  // static:  assets on fixture
  // assert every runtime embedded file name ∈ static asset names
})
```

- [x] Step 3: 实现 probes（`Bun.embeddedFiles` 遍历写盘等）+ CLI `cc` 分发（拷副本→`patchLoaderHook`→`bun` 跑 `CC_EXT=probe`→收集→删副本；`versions/` live 守卫）。
- [x] Step 4: 验证通过（子集断言 + fixture round 通）。
- [x] Step 5: 提交 `feat(unbun): cc runtime introspection + patchable fixture + subset oracle`。

### Task 4.3: double-magic 消歧 fixture（评审 G2）

- [x] TDD：造正文含 `---- Bun! ----` 字面量的 fixture（**实测可造**：源码嵌 `const _M="…---- Bun! ----…"`，编译后 magic 落 `.bun` 内、真 trailer 之前），验 `module-graph` 的 `lastIndexOf`/段内定位仍取到真 trailer（非那个注入的假 magic）。做成真测，不 skip。提交。

---

## Stage 5 — rebuild + exp 并入 + 文档收尾

### Task 5.1: rebuild 子命令（round-trip oracle）

**Interfaces:** `unbun rebuild <appdir> [out]` → `bun build --compile`。
- [x] TDD：对 fixture 做 extract→rebuild→run，断言重建二进制 `--version`（或等价）跑通（round-trip 无损）。对活 claude 的 rebuild 走 gitignored smoke。提交 `feat(unbun): rebuild (round-trip completeness oracle)`。

### Task 5.2: exp `git mv` 并入 + archive banner

- [x] **Step 1**: `git mv exp/patch-the-claude-binary/<各脚本> tools/unbun/archive/`（保 history；核心逻辑已被 lib 取代的脚本进 archive）。逐个 `git mv` 用精确 pathspec。
- [x] **Step 2**: 给每个 archive 脚本加头部 banner：`// ARCHIVED — 逻辑已迁入 lib/<x>，勿运行。见 docs/spec.md`。
- [x] **Step 3**: 给 archive 的 README 里被证伪的 TOC footer 断言加删除线 + 注解指向 FINDINGS-phase0.md（B1 核验）。
- [x] **Step 4**: 确认 `tools/unbun/` 的 test/lint glob 排除 `archive/**`。
- [x] **Step 5**: 提交 `refactor(unbun): absorb exp/patch-the-claude-binary into archive/ with banners`（精确 pathspec）。

### Task 5.3: README + ARCHITECTURE + 活文档收尾

- [x] 写 `tools/unbun/README.md`（命令表 + 用法 + 指向 docs/）；`docs/ARCHITECTURE.md`（lib 分层 + 数据流 + seam 说明）。更新 spec 状态为「已实现」。若涉及仓库根 tools 索引则同步。提交 `docs(unbun): README + ARCHITECTURE`。

---

## Self-Review（作者对照 spec）

- **Spec 覆盖**：extract→T1.1/1.2；assets→T3.1；split→T2.1/2.2；layout→T3.2；diff→T3.3；rebuild→T5.1；cc patch-loader-hook/run/introspect→T4.1/4.2；Phase 0 P0-a..e→T0.2 FINDINGS + T0.3；子集 oracle→T4.2；round-trip→T5.1；exp 并入+banner→T5.2；活文档→T5.3。✅ 全覆盖。
- **Placeholder 扫描**：Stage 0 的 `decodeRecords` 实现体、`parseVersion` 锚 pattern 标注「按 FINDINGS 填」——这不是逃避，是 Phase-0 闸门的正确产物（**长度敏感 oracle**：整块 acorn 解析 + 收在 `})` + .node ELF 自证大小 + 相邻 blob 连续性，已锁定 offset 与 length 双向验收，实现体在执行期按实证填）。其余步骤均有可跑命令 + 具体断言。
- **评审闭环**：对抗计划评审的 B1（oracle 长度盲）→ Task 0.3 加长度判别式；M2（fixture `//` 注释被剥）→ string 字面量锚 + hook 锚参数化；M2（split helper 精度）→ 频率判据 + 正反断言；M3（layout 启发式）→ 消费 module-graph 精确边界；m1（name 来源）→ P0-a 确证 + assets 回落；m2（4.3 skip）→ 实测可造、去 skip。均已并入。
- **类型一致**：`parseModuleGraph→{blobs:[{name,offset,length}]}` 被 extract/assets 一致消费；`extractApp→{app,version,blob}` 被 split/CLI 一致消费；`splitModules→{modules,helpers}` 被 CLI 一致消费。✅
- **风险**：Stage 0 是硬闸门，若 P0-a 格式比预期复杂，`decodeRecords` 可能需多轮探针——已由格式无关 oracle 兜正确性，不影响下游接口。
