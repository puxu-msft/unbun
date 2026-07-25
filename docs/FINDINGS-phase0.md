# FINDINGS — Phase 0 格式探针闸门（Bun StandaloneModuleGraph 真实布局）

> 状态：**已逆通并跨版本核验**。日期 2026-07-10。
> 探针：[`../exp/probe-module-graph.mjs`](../exp/probe-module-graph.mjs)（可复现，纯读取，不执行目标 binary）。
> 实测样本：`2.1.195`（vscode 内置）、`2.1.201`、`2.1.205`（活二进制）。三版格式一致。
> 本文是下游所有静态解码器（`module-graph.mjs` / `extract` / `assets` / `split` / `layout`）的**字节级地基**。凡标「未确证」处，实现按注明的回落走，**绝不臆断写死**。

---

## 摘要（一句话结论）

Bun `bun build --compile` 产物的模块/资产表位于 **`.bun` section 内、`\n---- Bun! ----\n` trailer 之前**（不是 EOF、不是「最后 48 字节自指针」——那是 ELF section header table，旧 `tools/unbun/archive/README.md` 的模型已证伪）。表由一个 **32 字节 `Offsets` 头** + 一串 **52 字节定长记录**组成，每条记录带 **`name`（模块名，`/$bunfs/root/...`）** 与 **`contents`（blob 字节）** 两个 `StringPointer`。**按记录切片能无损切出全部 6 个（205）/ 5 个（201/195）blob，且模块名内嵌 → 资产可具名输出。**

---

## P0-a — StandaloneModuleGraph / trailer 格式 【已确证】

### 定位真 trailer

- trailer 字面量 = `"\n---- Bun! ----\n"`（前后各一个 `\n`，共 15 字节）。
- 用无换行的 14 字节 magic `---- Bun! ----` 在 **`.bun` 窗口内 `lastIndexOf`** 定位：`magicPos`。`trailerStart = magicPos - 1`（前导 `\n`）。
- 全二进制 magic 出现 **2 处**：一处在引擎区（`.rodata`，~1412001，HMR runtime 常量，排除）、一处在 `.bun` 窗口尾（真 trailer）。出现次数随版本，**勿写死**；一律取 `.bun` 窗口内的那个。
- 真 trailer 结束处 == `.bun` section 末尾（205 实测 `trailerStart+15 == .bun.off + .bun.size`）。

### `Offsets` 头（trailer 前 32 字节，8 字节对齐）

`sizeof(Offsets) = 32`，位于 `[trailerStart-32, trailerStart)`。字段（小端）：

| 相对 trailerStart | 字段 | 类型 | 205 实测值 | 含义 |
|---|---|---|---|---|
| `-32` | `byte_count` | u64 | 170744968 | graph 序列化区总字节数（`graph_base .. offsets_start`） |
| `-24` | `modules_ptr.offset` | u32 | 170744655 | 记录数组相对 `graph_base` 的偏移 |
| `-20` | `modules_ptr.length` | u32 | 312 | 记录数组字节数（= N × 52） |
| `-16` | `entry_point_id` | u32 | 0 | 入口模块在数组中的下标（**从此读取，勿硬编码 0**） |
| `-12` | （尾部冗余/对齐） | u32 | 170744967 | = `mp_off + mp_len`（modules 数组结束相对偏移）；语义未完全确证，解码不需要 |
| `-8` | 同上 | u32 | 0 | |
| `-4` | 同上 | u32 | 15 | 值恰等于 trailer.len，疑似对齐；解码不需要 |

**`graph_base`（所有 `StringPointer` 的绝对基址）**：
```
graph_base = (trailerStart - 32) - byte_count
```
三版实测 `graph_base == .bun.off + 8`（205: 86212616 = 86212608+8；201: 86212616；195: 86114312 = .bun.off+8）。`+8` 稳定但**不要靠它**——权威推导是 `offsets_start - byte_count`，并用下面的记录切片自证。

### 模块记录（定长 52 字节 = 13×u32）

数组起点 `modPos = graph_base + modules_ptr.offset`（**非 4 对齐**，用 `readUInt32LE` 逐字段读，无碍）。**记录数 `N = modules_ptr.length / 52`**（随版本变：205 为 6、201/195 为 5，**必须从 `mp_len/52` 算，绝不写死**）。字段（相对每条记录起点，均相对 `graph_base`）：

| 相对记录 | 字段 | 类型 | 说明 |
|---|---|---|---|
| `0` | `name.offset` | u32 | 模块名字节偏移 |
| `4` | `name.length` | u32 | 模块名长度 |
| `8` | `contents.offset` | u32 | **blob 字节偏移** |
| `12` | `contents.length` | u32 | **blob 字节长度**（权威，绝不对启发式 run 做 `toString`） |
| `16` | `sourcemap.offset` | u32 | 实测恒 0（空） |
| `20` | `sourcemap.length` | u32 | 实测恒 0（空） |
| `24..44` | aux（bytecode + 入口专属额外指针） | 6×u32 | **除入口外全 0**；入口 cli.js 填了 `{...,120,<ptr>,0,0,<ptr>,35}`——两个指针分别指向一段 **120 字节全零填充** 和 **重复的模块名**，不指向任何新 blob，**与抽取无关**（语义未完全确证，不需要） |
| `48` | loader/flags | u32 | `byte[49]` = Bun `Loader` enum：**js=1、file=5、napi/node=10**（205 实测 js=`0x00020101`、file=`0x01000500`、napi=`0x01000a00`；byte0/byte3 疑似 module-format 标志位，未逐位确证，分类只需 byte[49]） |

**blob 名字来源 = 内联记录里的 `name` StringPointer（`/$bunfs/root/<path>`）→ 资产能具名输出。** 这是 P0-a 最关键的确证项，直接决定 `assets` 命令**无需回落到 `blob-<offset>.bin`**。

### 验证判据（已通过）

按逆出的 `(name, contents)` 切片，三版全部 blob **逐个 slice + 头字节校验 PASS**：

| # | name | loader | 205 contents 头 |
|---|---|---|---|
| 0 [ENTRY] | `/$bunfs/root/src/entrypoints/cli.js` | js | `// @bun @source__ @bun-cjs\n(function(exports,…` |
| 1 | `/$bunfs/root/image-processor.js` | js | `// @bun @source__ @bun-cjs…` |
| 2 | `/$bunfs/root/audio-capture.js` | js | `// @bun @source__ @bun-cjs…` |
| 3 | `/$bunfs/root/image-processor.node` | napi | `\x7fELF…` |
| 4 | `/$bunfs/root/mermaid.min.js` | file | `"use strict";var __esbuild_esm_mermaid_nm;…`（205 新增，201/195 无此模块） |
| 5 | `/$bunfs/root/audio-capture.node` | napi | `\x7fELF…` |

> 注：原始文件扫描里 `@bun-cjs` 出现 3 次 = 3 个 js-loader 模块（cli/image-processor/audio-capture）的 contents 头；`.node` 的 4 处 `\x7fELF` = 2 个内嵌 `.node`（graph 里）+ 各自尾部 section-header 的 ELF 引用。graph 权威给出精确边界，无需靠扫描消歧。

---

## P0-b — 入口 cli.js 定位与消歧 【已确证】

**权威判据：`Offsets.entry_point_id` 索引记录数组 → `records[entry_point_id]` 即入口。** 三版恒为 0，但**从结构读取**、不硬编码。

- 入口 blob 就是 3 个 js-loader 模块（3 处 `@bun-cjs`）里 `records[entry].contents` 指认的那个——恒为最大者（cli.js ~19MB vs image/audio-capture ~2KB），名恒为 `/$bunfs/root/src/entrypoints/cli.js`。
- 回落顺序（当某个 SFX 无 `entry_point_id` 或非 claude 布局时）：① 名字匹配 `**/src/entrypoints/cli.js` 或 `entry` 语义 → ② 最大的 js-loader blob。三级判据一致，无歧义。

---

## P0-c — helper 动态识别（`__esm` / `__commonJS`）【已确证，名字漂移·签名稳定】

对入口 blob（`records[entry].contents`）做正则识别。**helper 局部名由 minifier 分配、跨版本必变；定义签名跨版本逐字节稳定** → **按签名认名，绝不硬编码字母**。

| helper | 定义签名（正则锚，稳定） | 局部名 205 / 201 | 调用形态 | 用量（205 / 201） |
|---|---|---|---|---|
| `__esm`（ESM 懒初始化，零参 thunk memoizer） | `X=(e,t)=>()=>(e&&(t=e(e=0)),t)` | `b` / `E` | `var Y=X(()=>…)`（零参箭头） | 4563 / 4527 |
| `__commonJS`（双参回调 memoizer） | `X=(e,t)=>()=>(t\|\|e((t={exports:{}}).exports,t),t.exports)` | `K` / `J` | `var Y=X((exports[,module])=>…)`（1 或 2 参回调） | 1620 / 1620 |

识别流程（下游 `split.mjs` 照此）：
1. 在入口 blob 里用上面两条**定义签名正则**各匹配一次，捕获局部名 `X`。
2. 下钻外层 IIFE（`(function(exports,require,module,__filename,__dirname){…})`），遍历其函数体内顶层 `var Y=X(...)`：
   - `X` = `__esm` 名且实参是零参箭头 → `kind: esm`；
   - `X` = `__commonJS` 名且实参是 1/2 参回调 → `kind: cjs`。
3. 干扰项（如 spec 提到的 `ve(()=>…)` 体内 memoize helper）自动被「顶层 + 签名」双条件排除——它们既非顶层 `var X=helper(...)`、其 helper 定义签名也不匹配上面两条。
- **模块总数按此实证家族计数，不写死具体数。** 计数与 spec 声称（~4277 / ~1583）同量级，差异来自「是否含嵌套/非 var-init 位点」，不影响识别正确性。

---

## P0-d — 版本锚点 【已确证（Claude 专属）】

**裸串 `2.1.x` 无唯一锚**（205 实测 224 处、201 实测 227 处，值分散含依赖版本号）。

**唯一稳定锚 = Claude 元数据对象**（内联在入口 blob）：
```
PACKAGE_URL:"@anthropic-ai/claude-code",README_URL:"…",VERSION:"2.1.205"
```
正则 `PACKAGE_URL:"@anthropic-ai\/claude-code",README_URL:"[^"]*",VERSION:"([^"]+)"` 命中的 `VERSION` 即真版本。该对象被 minifier 内联多份（205 有 205 份、201 有 208 份），**所有副本值一致**，取任一即可。

- 归属：**Claude 专属**（依赖 `@anthropic-ai/claude-code` 串），属 `unbun cc` 语义面。
- **通用 bun SFX 回落**：无此锚 → version 解析降级 best-effort（扫 package 元数据里的 semver）+ 最终回落文件名/`unknown`。**不阻塞**。

---

## P0-e — 内嵌 sourcemap 【已确证：无可用内嵌 sourcemap】

- module graph 里**没有 `sourcemap.json` 模块**（205 的 6 条、201/195 的 5 条记录里均无）。
- 入口 cli.js 的 `sourcemap` StringPointer = `{off:0, len:0}`（**空**），其余模块同为空。
- 全二进制里的 `"sourcemap.json"`（@17156703）与 `"SourceMapTooLarge"`（@17156738）都落在 **`.rodata`（引擎区，~23MB 处）**，是 Bun runtime 的内部常量/错误串，**不是内嵌资产**。
- **结论**：无可用于真名还原的内嵌 sourcemap → `split` 的模块命名以**合成 ID（序号 + 动态识别的 minified 句柄）**为主，真名还原为 best-effort（多半 `unknown`）。spec 「先真解 sourcemap 再定论」的门控**已通过并否定内嵌 sourcemap 存在**——非凭陈旧证据，而是实测三版皆无。

---

## 对下游 Task 0.3（`decodeRecords`）的直接输入

```
locateTrailer(buf, bunWindow):
  magicPos    = buf.lastIndexOf("---- Bun! ----", bunWindow.end)   # 排除 .rodata 副本
  trailerStart= magicPos - 1                                        # 前导 \n

decodeGraph(buf, trailerStart):
  os          = trailerStart - 32                                   # sizeof(Offsets)=32
  byte_count  = u64(os);  mp_off = u32(os+8);  mp_len = u32(os+12);  entry = u32(os+16)
  graph_base  = os - byte_count
  N           = mp_len / 52                                          # 记录数，勿写死
  for i in 0..N:
    r = graph_base + mp_off + i*52
    name     = str(graph_base + u32(r+0),  u32(r+4))
    contents = slice(graph_base + u32(r+8), u32(r+12))               # 权威长度
    loader   = LOADER[buf[r+49]]                                     # js=1/file=5/napi=10
  # 自证（**按 loader 分类** head sniff——head sniff 是冗余末端，真守卫是结构不变式）：
  #   每条 name 可打印且含 "$bunfs"（对所有 blob）；然后按 loader 分头字节检查：
  #     · js 族（jsx/js/ts/tsx）+ 入口 blob：头 ∈ {// @bun, @bun-cjs, "use strict", #!}
  #       （`// @bun` 是 bun --compile 对 ESM 入口发的通用 bundle banner；claude 预打包 CJS 用 `@bun-cjs`。
  #        收录 `// @bun` 使解析对任意 bun SFX 通用，不只认 claude 那种预打包形态。）
  #     · napi（9/10）：头 == \x7fELF
  #     · file/json/css/toml/wasm/未知 loader：**跳过** head sniff——这类资产内容任意（mermaid 头
  #       `"use strict"`、chart.umd.min.js 头 `/*!` 法律 banner、下个新 file 资产又可能是别的），
  #       用 JS/ELF 头 sniff 天然脆弱、每加一个新内嵌 file 资产就误报一次。其正确性仍由**结构不变式**
  #       （offset 落在文件内、边界无重叠、末 blob 贴记录数组、name 是 `$bunfs` 路径）照旧强制兜。
  # 结构不变式（对**所有** blob 照旧）：graph_base/offset 越界守卫 + 边界无重叠 + 末 blob 贴记录数组。
  # 若自证失败（未来版本改布局）→ 报错停下，别静默产出错误切片
```

**未确证/降级项清单**（实现须照此，勿臆断）：
1. `Offsets` 尾部 12 字节（`-12/-8/-4`）语义未完全确证 → 解码不读取，仅用 `byte_count`+`modules_ptr`+`entry_point_id`。
2. 记录 aux 字段 `[24..44]` 语义未完全确证（入口专属、指向零填充/重复名）→ 抽取不依赖，仅切 `name`+`contents`。
3. loader `byte[48]`/`byte[51]` 标志位未逐位确证 → 分类只用 `byte[49]`（Loader enum）。
4. `sizeof(Offsets)=32`、记录 `=52 字节` 在 195/201/205/206 稳定，但**未来 Bun 版本可能改** → 解码器**必须带自证断言**。自证的 head 字节检查**按 loader 分类**：js 族 + 入口要求 JS 类 marker、napi 要求 ELF、**file/json/其它任意-内容 loader 跳过 head sniff**（内容任意，靠结构不变式兜）。结构不变式（graph_base/offset 越界 + 边界无重叠 + 末 blob 贴记录数组）对**所有** blob 照旧强制，是真正钉死切片的守卫；head sniff 只是冗余末端。失败即显式报错、不静默产坏切片。
   > **2.1.206 起新增内嵌资产 `chart.umd.min.js`（Chart.js v4.5.1，file loader，头 `/*!` 法律注释 banner）** → 记录数 N=7（205 为 6、201/195 为 5）。`/*!` 不是 JS/ELF marker——正是它触发了旧「所有 blob 都查 head 白名单」的误报，实证了 **file-loader 资产头任意、head sniff 必须按 loader 分类**（file 类跳过、靠结构不变式）。
5. version 锚为 Claude 专属；通用 SFX best-effort + 文件名回落。
6. 无内嵌 sourcemap → 真名还原 best-effort。
