# unbun — spec（规格说明）

> 状态：**已实现并扩展**。本文保留 2026-07-09 的通用 Bun SFX what/why 与 Phase 0 历史；2026-07-25 完成的 Claude Code JavaScript/Python 双实现补丁器以 [`dual-implementation-spec.md`](dual-implementation-spec.md) 和 [`shared-store-format.md`](shared-store-format.md) 为权威增量规格，当前架构见 [`ARCHITECTURE.md`](ARCHITECTURE.md)。
> 日期：2026-07-09（v2 定稿）／2026-07-10（通用工具收尾）／2026-07-25（双实现扩展）。
>
> ⚠️ **重要前提**：[`../archive/README.md`](../archive/README.md)（原 `exp/patch-the-claude-binary/README.md`）里的若干二进制结构断言经实测被证伪（见 §结构事实核验）。本 spec 以核验后的事实为准；最终格式事实见 [`FINDINGS-phase0.md`](FINDINGS-phase0.md)。

## 一句话目标

把散落在 `exp/patch-the-claude-binary/` 的一批探索脚本，升级成一个**版本无关、可测、可组合**的 Bun CLI 工具 `unbun`，用于**静态提取、分析、运行时内省**任意 `bun build --compile` 单文件可执行产物（single-file executable, SFX），并保留针对 Claude Code 二进制的专用能力。

## 背景与动机

`claude` 是 Bun 单文件编译产物：整个 app 作为一段连续 CommonJS 模块内嵌在 ELF 的 `.bun` section，尾部有 `---- Bun! ----` trailer + Bun `StandaloneModuleGraph`（模块/资产偏移表）。`exp/patch-the-claude-binary/` 已验证：能提取内嵌 JS bundle 并美化、二进制无完整性闸、等长 loader-hook 可注入只读探针、可用标准 `bun` 直接跑提取物、可 `bun build --compile` 重打包。本工具将这些单点脚本收敛为一套共享解析层 + 统一 CLI，并补齐能力矩阵与测试。

### 结构事实核验（本 spec 的技术地基，均已对活二进制 2.1.205 实测）

1. **尾部「footer 自指针」是 ELF 段表，不是 Bun 元数据。** 文件末 48 字节 = `(0, 257003289, 409, 0, 1, 0)`，逐字段等于 `.shstrtab` 的 `Elf64_Shdr`（`sh_offset=257003289`、`sh_size=409`），且 `e_shoff + e_shentsize×e_shnum == filesize`。exp README「最后 48 字节是 Bun footer 自指针、按 `{offset,length,flags}` 记录表解析」的模型**错误**——它把 ELF section header table 尾部误读成了 Bun 结构。真正的 Bun `StandaloneModuleGraph` 偏移表位于 **trailer magic `---- Bun! ----` 之前**（实测 magic 前是一串 `(offset, length)` 变长记录），非 EOF。**其精确布局仍需 Phase 0 探针实证，不在本 spec 写死。**
2. **`@bun-cjs` wrapper 有多处，app 不在 section 边界上。** 活二进制里 `@bun-cjs` 出现 **5 次**：2 处在引擎区（`.rodata`，~15.8MB，Bun HMR runtime）、3 处在 `.bun` 段内（主 `cli.js` @232507098、`image-processor.js` @251683119、`audio-capture.js` @251685216）。`.bun` 段跨 `86212608 .. 256957632`（170MB），app JS 在段内 **~146MB 处**之后（前面是 JSC 字节码 + `mermaid.min.js` + 2 个 `.node`）。**所以「`.bun` section 边界 == app bundle 边界」是假的**；提取必须精确定位 app blob。**权威路径是 module-graph（P0-a）给出的 `cli.js` blob 精确 offset/length**（精确、可被 rebuild/acorn 自证），并在 3 个 `@bun-cjs` 里消歧（取 entry `cli.js`）。「在 `.bun` 段内扫可打印子块」（`analyze-binary-layout.mjs` 那套）仅作 P0-a 落地前的 bootstrap 或解码不可信时的回落——**若最终 ship 扫描路径，必须用精确字节长度界定块，绝不对启发式 run 做 `toString('latin1')`**（那正是 v1 隐患 #1 latin1 静默截断的来源）。
3. **模块 wrapper 靠 helper 定义签名识别、名字随 minifier 漂移、嵌在外层 IIFE 体内。** app.js 顶层只有一条表达式语句：外层 `(function(exports,require,module,…){ …整个 app… })`。模块是其**函数体内**的顶层 `var X=helper(...)`。**实测已确认两个模块声明家族**（均以 `var X=helper(...)` 形式出现）：
   - `__esm`（ESM 懒初始化，零参 thunk）：`var E=(e,t)=>()=>(e&&(t=e(e=0)),t)`，用作 `var X=E(()=>…)`——**4277** 处。
   - `__commonJS`（双参回调）：`var dqo=Q((exports,module)=>{module.exports=…})`，用作 `var X=Q((…)=>…)`——**1583** 处。
   两真族合计约 **5860**。注意：`ve(()=>…)`（676 处、其中赋值形式 639）**不是模块 wrapper**——`ve` 是被重定义 27 次的具名函数（`function ve(){…}`），其 `=ve(()=>…)` 调用全**嵌在 `E(()=>{…})` 模块体内部**当惰性值/schema memoize helper（`var X=ve(()=>` 计数为 **0**），签名与 __esm 不同，须排除。其余零参 thunk 局部名（`kn/Qc/bd` 等）是否为真模块家族，**留 P0-c 按签名逐一验证**再纳入计数。
   helper 名 `E/Q/…` 全是 minifier 分配、**跨版本必变**。**切分必须按 helper 定义体签名动态识别其局部变量名**，绝不硬编码字母（`ve` 那种「像模块调用实为体内 helper」的干扰，正靠签名匹配自动排除）；模块总数按 P0-c 实证家族计数，不写死具体数。

## 范围

### 四支柱能力（呈现透镜，非架构边界）

1. **静态提取**（不跑目标 binary）：在 `.bun` 段内定位并切 app CJS bundle、美化、按模块拆分、静态解析 module-graph 提取内嵌资产。
2. **静态分析**：二进制体积/布局分解；两版之间归一改名后的结构 diff。
3. **运行时内省**（Claude 专用，只读）：用等长 loader-hook 把只读探针注入 binary 的**副本**，在真实 Bun 运行时里观测运行时地面真相（`Bun.embeddedFiles`、require 加载图、求值后真值），观测完即退出。此支柱**只观测、不修改行为**。
4. **就地功能补丁**（Claude 专用，可写）：JavaScript/Bun `unbun cc` 与 Python `ccpatch` 是两套完整第一等实现，独立实现相同 feature/probe/exact-replay/store/transaction/CLI/TUI，并通过 shared store v1 完全互操作。所有 feature revert 从 clean baseline 重放目标集合，不使用相邻 `.bak` 或不可逆就地逆向。

> 真正的架构关注点分离是 **static（不跑目标）vs runtime（跑副本 / 只读探针）vs mutate（显式 transaction 写目标）** 三分；上述四支柱只是叙述分类。裸非 TTY 入口只读，写路径与内省副本路径严格隔离。

### 通用 vs Claude 专用

关键界定：**loader-hook 锚点是 Claude 专属注释串**，凡依赖它的能力归 `unbun cc …` 子命名空间；纯 Bun 机制（CJS wrapper、trailer/module-graph 格式、esbuild `__commonJS`/`__esm` 模式）对任意 bun SFX 通用，留顶层。

### 不做（Out of Scope）

- **源码保护/加密**——`exp` 已证 `--bytecode` 不能剥离源码（结论存档，不做命令）。
- **保证还原原始源码树**：拆分树命名以**合成 ID（序号 + 动态识别的 minified 句柄）**为主。真名还原是 best-effort——**但不在此刻武断否定**：Phase 0 要先真解 `$bunfs/root/sourcemap.json`（确认它是否 `SourceMapTooLarge` 空桩）再定论，不凭陈旧证据提前砍能力。

## Phase 0 — 格式探针闸门（进 plan 前必须完成）

> ✅ **已由 Stage 0 探针实证**：P0-a..e 全部确证并跨 195/201/205 三版核验，结论落 [`FINDINGS-phase0.md`](FINDINGS-phase0.md)，下游 `module-graph.mjs` 等解码器建立其上。以下小节保留原始意图描述。

以下列表保留 Phase 0 当时的未决问题与探针意图；这些问题现已由 [`FINDINGS-phase0.md`](FINDINGS-phase0.md) 裁决，当前实现不得重新依赖当时的臆测：

- **P0-a Bun `StandaloneModuleGraph` / trailer 格式**：定位 `.bun` 内真 trailer（用 `lastIndexOf('---- Bun! ----')`，排除 `.rodata` 那 2 处），逆出 magic 之前的偏移表记录布局（字段宽度、条目数来源、各 blob 名字从哪来），验证按其 offset/length 能切出 `cli.js` / ~~`sourcemap.json`~~ / 2 个 `.node` / `mermaid.min.js`。**订正：**三版 module graph 均无 `sourcemap.json` 模块；该串位于 `.rodata` 引擎区，详见 [`FINDINGS-phase0.md` P0-e](FINDINGS-phase0.md#p0-e--内嵌-sourcemap-已确证无可用内嵌-sourcemap)。
- **P0-b app-bundle 定位与消歧**：确立在 3 个 `@bun-cjs` 里取 `cli.js` 的稳定判据（entry 名 / 最大块 / module-graph 指认）。
- **P0-c helper 动态识别**：从 app.js 里按定义签名认出 `__esm`/`__commonJS` 的实际局部名，跨 195/201/205 三版实测识别稳定（见 FINDINGS-phase0.md）。
- **P0-d 版本锚点**：找一个**唯一稳定**的版本串锚（裸串 `2.1.x` 实测出现 200+ 次、205 为 224 处、201 为 227 处，值分散无唯一锚），如 entry `cli.js` 附近的 package 元数据字段；找不到则明确 version 解析降级为 best-effort + 回落。
- **P0-e sourcemap 内容**：~~真解 `sourcemap.json`，判定是否可用于真名还原。~~ **订正：**module graph 无此模块，`"sourcemap.json"` 字串位于 `.rodata` 引擎区；以 [`FINDINGS-phase0.md` P0-e](FINDINGS-phase0.md#p0-e--内嵌-sourcemap-已确证无可用内嵌-sourcemap) 为准。

Phase 0 结论回填本 spec 的对应「待实证」处，并作为 plan 的输入。

## 命令契约

工具名 `unbun`。命令名经诚实性审计——只叫它真做的事。**下表凡涉及二进制格式处均以 Phase 0 实证为准，此处只定语义契约。**

### 通用命令（任意 bun SFX）

| 命令 | 输入 | 输出 | 说明 |
|---|---|---|---|
| `unbun extract <bin> [outdir]` | bun SFX | `app.js` `app.pretty.js` `strings-n6.txt` `manifest.json` | 用 module-graph（P0-a）给的 `cli.js` blob 精确 offset/length **权威**切 app bundle（段内扫可打印子块仅作 bootstrap/回落，见核验节 #2），在多个 `@bun-cjs` 里按 P0-b 判据消歧，校验 wrapper，esbuild 美化，version 解析按 P0-d（best-effort + 回落） |
| `unbun assets <bin> [outdir]` | bun SFX | `assets/*`（`.node`、~~sourcemap、~~mermaid 等） | **静态**按 Bun module-graph（P0-a）切出全部内嵌 blob（含 JS 资产、非 JS 资产）。**订正：**`sourcemap.json` 不在 module graph 中，详见 [`FINDINGS-phase0.md` P0-e](FINDINGS-phase0.md#p0-e--内嵌-sourcemap-已确证无可用内嵌-sourcemap)。 |
| `unbun split <bin\|app.js> [outdir]` | bun SFX 或已提取 app.js | `modules/NNNNN-<handle>.js` + `modules/index.json` | acorn 解析：先下钻外层 IIFE，再遍历其 body 顶层 `var X=<helper>(...)`；helper 按 P0-c **动态识别**（`__esm` 零参 thunk + `__commonJS` 双参）；index 带 {序号,句柄,kind:esm/cjs,字节区间,行数,真名提示} |
| `unbun layout <bin>` | bun SFX | stdout / `layout.json` | 体积分解：engine(.text/.rodata) vs `.bun` vs 段内大可打印 JS vs 字节码 vs 原生件（原 `analyze` 更名） |
| `unbun diff <dirA> <dirB>` | 两个已提取目录 | stdout / `diff.json` | 归一 minifier 改名噪音后的**结构** diff（模块集合增删 + 逐模块）。非语义级 |
| `unbun rebuild <appdir> [out]` | 提取产物目录 | 自包含二进制 | `bun build --compile` 从 app.js + 资源重打包。**兼作抽取完整性的 round-trip oracle**：extract→rebuild→runs ⇒ 抽取无损（README 已验证可 round-trip；启动较慢，audio-capture 有 vendor 回退、image-processor 无） |

### Claude 专用命令（`unbun cc …`，依赖 claude 锚点/语义）

| 命令 | 说明 |
|---|---|
| `unbun cc patch-loader-hook <bin> [--force]` | 等长「注释锚点→loader-hook」替换，打到**副本**。守卫全保留：拒碰 `versions/` 下 live 除非 `--force`；有 `.bak` 校验尺寸；payload 超锚点即拒；等长后 size 不变。名字精确——它没增强任何别的能力，就这一个等长桩 |
| `unbun cc run <bin> --ext <script>` | 拷贝 binary→临时文件→打桩→`bun` 起进程 `CC_EXT=<script>`→收集输出→删副本。对 live binary 只读。通用逃生口，跑任意外部脚本 |
| `unbun cc introspect <bin> --probe assets\|graph\|facts` | `cc run` + 内置探针：`assets`(`Bun.embeddedFiles`→dump)、`graph`(instrument require→加载序+调用图)、`facts`(version/Bun.version/process.versions/env→JSON) |

### 交叉验证 oracle（子集关系，非全等）

实测 `Bun.embeddedFiles` **只含** `with {type:"file"}` 的嵌入件（2 个 `.node`，可能含 mermaid），而静态 module-graph 还含 ~~`sourcemap.json`、~~`cli.js` 本体、各 JS 模块 blob。**订正：**`sourcemap.json` 不在 module graph 中，该串位于 `.rodata` 引擎区，详见 [`FINDINGS-phase0.md` P0-e](FINDINGS-phase0.md#p0-e--内嵌-sourcemap-已确证无可用内嵌-sourcemap)。故正确断言是：

> **`embeddedFiles` ⊆ `unbun assets` 解出的资产集**（真包含），而非 `===`。

写成 `===` 会**误杀正确的静态解析器**。这个 oracle **只验资产解码这一子集**——它**不**验证 module-graph 的模块表偏移解得对（那部分靠 P0-a 的「按 offset 切出的 blob 能被 acorn 重解析 / rebuild 跑得起来」兜）。

## 架构

Bun 运行时，共享 `lib/` + 单一 CLI 分发。纯静态命令不跑目标 binary；`cc` 命令只在副本上打桩+跑。

```
unbun/
  package.json            bun 包；dep: acorn（切分）、esbuild（美化）
  cli.mjs                 子命令分发：extract|assets|split|layout|diff|rebuild|cc <sub>
  lib/
    bun-binary.mjs        读 ELF section(.bun/.text/.rodata)，只提供「.bun 字节窗口 + ELF 元数据」
    module-graph.mjs      定位 .bun 内真 trailer（lastIndexOf，排除 .rodata）+ 解码 StandaloneModuleGraph
                          → blob 清单 {name?, offset, length}。「定位+解码」同属一层（见下 seam 说明）
    extract.mjs           在 .bun 段内定位 app CJS bundle（子块/图指认）+ 消歧 + 校验 + version 解析
    naming.mjs            默认 outdir 与 asset 名冲突消歧的共享命名原语
    beautify.mjs          esbuild AST 重印 → app.pretty.js（稳定行号）
    split.mjs             acorn：下钻外层 IIFE → 遍历 body 顶层 wrapper；helper 动态识别 → per-module + index
    layout.mjs            体积构成分解
    diff.mjs              归一改名后结构 diff
    hook.mjs              等长 loader-hook 打到副本（并入 patch-loader-hook 逻辑 + 守卫）
    probes/
      dump-assets.cjs     Bun.embeddedFiles → 写盘（并入 dump-embedded-resources）
      module-graph.cjs    instrument require → 加载序 + 图 → JSON
      runtime-facts.cjs   version / Bun.version / process.versions / env → JSON
  test/
    fixtures/             小型自建 bun --compile 产物（可入库，非专有；配方见测试策略）
    *.test.mjs            bun test
  exp/ 或 archive/        Phase 0 PoC + exp 原始 POC/实验脚本 + FINDINGS（provenance）
  README.md               用法 + 命令表 + 指向 docs/
  docs/  spec.md（本文）  plan.md  ARCHITECTURE.md（建成后）
```

### seam 说明（bun-binary vs module-graph）

评审 C5/B1 指出「定位 trailer」与「解码记录」不可干净切成两层——因为要在多处 magic 里判定哪个是真 trailer，往往得试着按结构解一下。故本 spec 把 **trailer 定位 + module-graph 解码合并为 `module-graph.mjs` 一层**；`bun-binary.mjs` 只做纯 ELF 层（给出 `.bun` 字节窗口与各 section 元数据），不反向依赖解码逻辑，保住单一事实源不渗漏。

### 数据流

```
binary
  → bun-binary（.bun 窗口 + ELF 元数据）
    → module-graph（.bun 内定位 trailer + 解码偏移表）→ blob 清单
       → extract（切 app cli.js blob）→ app.js → beautify → app.pretty.js
       → assets（切非入口 blob）→ assets/*
    → extract → split → modules/* + index.json
    → layout → layout.json
diff：吃两个已提取目录
cc introspect：binary → 副本 → hook 打桩 → bun 跑 probe → 收集 → 删副本
```

## exp 并入方式（不丢历史）

原父仓库曾用 `git mv` 保存 `exp/patch-the-claude-binary/` 历史；2026-07-23 用户主动把 `unbun` 抽成独立仓库。当前独立仓库保留 `archive/` provenance，但不伪造或重放父仓库 Git history。

**归档纪律（同本仓库既有归档要求，评审 G3）**：每个归档脚本加头部 banner（`ARCHIVED — 已由 lib/<x> 取代，勿运行`）+ 指向后继；`archive/**` 排除出 test/lint/typecheck 的 glob 作用域，避免死代码被 grep/误跑。**exp README 中被证伪的 TOC footer 模型（见 §结构事实核验）在归档时加删除线注解**，指向本 spec 的核验结论。gitignored 的 `refs/`、`dumped/` 产物不随 git mv，按需重生成。

## 依赖

- **acorn**（本地 dependency）：稳健顶层语句切分。手搓 JS-aware 扫描器要处理正则/除号歧义、模板串、注释，极易错；acorn 是 rollup/webpack 事实标准、体积极小、零依赖。
- **esbuild**（本地 dependency）：AST 重印美化。Bun 下实测 0.28.1 可用。
- **Ink + React**：JavaScript 全功能 TUI；Python 实现使用 Textual。

## 测试策略（避开专有内容）

**可打桩 fixture 配方（评审 G1/G2/G4）**：自建一个小 `bun build --compile` SFX，源码里**故意植入**同款 loader-hook 锚点注释行（77 字节）+ 嵌入一个小 `.node`/文件资产（`with {type:"file"}`），使 `hook`/`run`/`introspect`/交叉验证都能在**入库 fixture**（非专有）上跑，而不必依赖 gitignored 活 claude。

- **纯字节层**：`hook.mjs` 的等长/守卫/`\n` 校验用合成 buffer 单测（无需真 bun）。
- **解析层**：`bun-binary`/`module-graph`/`extract`/`split` 用 fixture 测；断言结构/行为，**绝不 byte-pin 专有文案**（模块可被 acorn 重解析、`extract` 结果可 `node --check`、split 再拼接可重解析）。
- **交叉验证**：fixture 上 `embeddedFiles ⊆ static assets`（子集断言）。
- **round-trip**：fixture 上 extract→rebuild→run 成功（抽取无损 oracle）。
- **double-magic 消歧**（评审 G2）：造一个正文里含 `---- Bun! ----` 字面量的 fixture（触发多 magic），验 `lastIndexOf`/段内定位取到真 trailer；若 fixture 造不出，明确标注该路径仅由 gitignored 活二进制 smoke 兜、属已知常绿覆盖缺口。
- **回归非空**：修复类测试回退即红，证不空测。
- 活二进制集成 smoke 走 gitignored 路径，不入库。

## 验收标准

1. `unbun extract` 在活二进制（2.1.205）产出可 `node --check`/acorn 重解析的 `app.js` + `app.pretty.js`，**版本无关**（不依赖文件名带版本；helper 动态识别、非硬编码 minified 名）。
2. `unbun assets` 解出的资产集 **⊇** `unbun cc introspect --probe assets` 的 `embeddedFiles`（子集交叉验证通过）。
3. `unbun split` 产出已确认的两真族模块（`__esm` ~4277 + `__commonJS` ~1583 ≈ 5860，外加 P0-c 按签名实证的其他家族）均非空 + index.json，每模块可重解析。（不把版本特定的精确计数当硬门槛——升版必漂；断言用「量级 + 两真族均非空 + 无 `ve` 那类体内 helper 误纳」）
4. `unbun layout` 复现 `exp` 的体积分解结论。
5. `unbun cc patch-loader-hook` 保留全部安全守卫，等长打桩后 size 不变。
6. `unbun rebuild` 从 extract 产物重打包出可运行二进制（round-trip 无损）。
7. Phase 0 PoC 结论（P0-a..e）落档，plan 建立其上。
8. `exp/patch-the-claude-binary/` 历史经 `git mv` 保留；POC/FINDINGS 存 `archive/` 且加 banner；被证伪的 README 断言加注解。
9. 测试全绿，含子集交叉验证、round-trip、double-magic 消歧（或标注缺口）、回归非空。

## 未决 / 风险

- **Bun module-graph 精确格式未定**（P0-a）——最大风险，Phase 0 先解。已知：trailer 在 `.bun` 内、magic 之前是变长偏移记录，footer-自指针模型作废。
- **helper 名跨版本漂移**（P0-c）——靠定义签名动态识别兜；须跨 195/201/205 三版实测验证。
- **version 唯一锚未定**（P0-d）——找不到就降级 best-effort。
- **module-graph 探针深度**（顶层 require 还是递归全图）——plan 阶段定。
- **rebuild 边界**：略偏 build 而非 analysis，但兼作 round-trip oracle，价值明确，保留。

## 记录：未采纳 / 已更正的选项

- 工具本体运行时曾推荐 node，用户选 **Bun 优先**；因资产提取走静态 module-graph、不跑目标 binary，Bun-first 与「不越界 patch」自洽，采纳。
- 命令名 `patch`→`cc patch-loader-hook`、`analyze`→`layout`、diff「语义」→「结构」——诚实性审计更正。
- `all` 一把梭子命令——用户否，去掉。
- `bytecode-check` 独立命令——存档为结论，不做命令。
- 名称候选 10 个中用户选 **unbun**，用 `cc` 子命名空间保住 claude 专用能力的可描述性。
- **spec v1 的三处结构模型被实测推翻**（评审 B1/B2/B3 + 作者核验）：① 尾部 footer 自指针（实为 ELF 段表）② 模块切分模式（E 标反为 CJS、漏 1583 CJS、硬编码 minified 名）③ `.bun` section 边界 == bundle 边界（app 在段内 146MB 处）。v2 已改为「Phase 0 探针实证 + 动态识别 + 段内定位」，并作废 exp README 对应断言。
- **oracle `===`→⊆**（评审 M1）：`embeddedFiles` 是静态资产真子集，全等会误杀正确实现。
- **真名/sourcemap 不预先砍**（评审 m2）：Phase 0 真解 `sourcemap.json` 再定论。
