# unbun

**Bun 单文件产物（`bun build --compile` SFX）的静态提取 / 分析 + 运行时内省工具。** 适用于经验证的 `bun --compile` 格式族：Bun trailer、Offsets、record 长度与 Loader enum 等格式知识集中在 `lib/module-graph.mjs`，命令消费者不分散硬编码；遇未知布局时以 fail-loud 自证拒绝继续解析。另保留一组针对 Claude Code 二进制的专用能力（`cc` 子命名空间）。

> **Provenance：** 该工具于 2026-07-23 从原父仓库的 `tools/unbun/` 主动抽出到 `~/src/unbun`，作为独立工具继续维护。当前独立仓库没有伪造或重放原父仓库的 Git history；历史探索证据保存在 [`archive/`](archive/)，当前架构与迁移决策保存在 [`docs/`](docs/)。

安装与仓库内运行方式见 [`INSTALL.md`](INSTALL.md)。

`claude` 本身是 Bun 单文件编译产物：整个 app 作为一段连续的 CommonJS bundle 内嵌在 ELF 的 `.bun` section，尾部有 `---- Bun! ----` trailer + Bun `StandaloneModuleGraph`（模块 / 资产偏移表）。unbun 把这套结构逆向解成一层共享解析 `lib/`，在其上提供统一 CLI。**纯静态命令绝不执行目标二进制**（纯读 + acorn + esbuild + strings）；`cc` 命令族只对二进制的**副本**打等长桩后跑只读探针，对 live 二进制只读。

## 命令一览

工具通过 `bun cli.mjs <command>`（或装为 `unbun` bin）调用。缺省 `<bin>` 回落到 `readlink -f "$(command -v claude)"` 定位的 live claude；纯静态命令的产物缺省落**仓库根** `refs/claude-code-<version>/`（由 `repoRoot()` 定位、与 cwd 无关，并由根 `.gitignore` 排除）。

### 通用命令（任意 bun SFX）

| 命令 | 用法 | 简述 |
|---|---|---|
| `extract` | `unbun extract [bin] [outdir]` | 权威切出 app 入口 bundle → `app.js` / `app.pretty.js`（esbuild 美化）/ `strings-n6.txt` / `manifest.json` |
| `assets` | `unbun assets [bin] [outdir]` | 静态按 module-graph 切出全部非入口内嵌 blob（2 个 `.node` napi 原生模块、mermaid 等 file-loader 资产）→ `assets/*` |
| `split` | `unbun split [bin\|app.js] [outdir]` | acorn 下钻外层 IIFE，按 helper 签名动态识别 `__esm`/`__commonJS` 模块，逐模块写 `modules/NNNNN-<handle>.js` + `index.json` |
| `layout` | `unbun layout [bin] [outdir]` | 用 module-graph 精确边界 + ELF section 元数据做体积分账（engine / app js / 资产 / 字节码+元数据 / 其余段）→ 打表 + `layout.json` |
| `diff` | `unbun diff <dirA\|indexA.json> <dirB\|indexB.json> [outdir]` | 吃两个 split 产物，归一 minifier 改名噪音后比对模块集合（增 / 删 / 改 / 改名 / 不变）→ `diff.json` |
| `rebuild` | `unbun rebuild <appdir\|app.js> [out]` | `bun build --compile` 反向重打包；**兼作 round-trip 完整性 oracle**：extract→rebuild→run 跑得起来 ⇒ 抽取无损 |

### Claude 专用命令（`cc` 子命名空间，依赖 claude 注释锚点）

| 命令 | 用法 | 简述 |
|---|---|---|
| `cc status` | `unbun cc status [--binary PATH] [--json\|--profile]` | 只读探测 feature、版本与 matching baseline；不创建 store |
| `cc patch` | `unbun cc patch [--binary PATH] [--feature NAME\|--all] [--json]` | 从 shared clean baseline 重放最终 feature 集合并原子写入；`--all` 选择全部 supported feature 的依赖闭包 |
| `cc revert` | `unbun cc revert [--binary PATH] [--feature NAME] [--json]`；`unbun cc revert --snapshot NAME [--snapshot-version VERSION] [--binary PATH]` | 从 baseline 移除 feature；不指定 feature 时恢复 clean baseline；携带 `--snapshot` 时走 snapshot restore |
| `cc snapshot` | `unbun cc snapshot <save\|list\|rm> ...` | 管理 shared store v1 中的 content-addressed 命名快照 |
| `cc store` / `cc lock` | `unbun cc store root` / `unbun cc lock <inspect\|cleanup>` | 查看 store root、诊断 cooperative lock；stale lock 仅显式 `--force` 清理 |
| `cc patch-loader-hook` | `unbun cc patch-loader-hook <bin> [--out <path>] [--force]` | 把 claude bundle 顶部的等长注释锚替换成只读 loader-hook payload，写**副本**（size 分毫不变，TOC-safe）。守卫：锚点零命中即报错；拒写 `versions/` live 安装区除非 `--force`；有 `.bak` 校验尺寸 |
| `cc run` | `unbun cc run <bin> --ext <script> [-- <target-args...>]` | 拷贝→打桩→spawn 起进程（`CC_EXT=<script>`）→收集输出→删临时副本。对 live 二进制只读。`--` 之后的参数原样透传给目标脚本（可含 `--` 开头的 flag）。扩展加载失败 fail-loud，不静默当成功。跑任意外部只读脚本的逃生口 |
| `cc introspect` | `unbun cc introspect <bin> --probe <assets\|graph\|facts> [--out <dir>]` | `cc run` + 内置探针：`assets`（`Bun.embeddedFiles`→dump）、`graph`（instrument require→加载序 + 调用图）、`facts`（version / Bun.version / process.versions / env→JSON） |

### 双实现补丁管理器

JavaScript/Bun 与 Python 是两套长期并行、完整且互不调用核心代码的实现：

- `unbun cc`：JavaScript/Bun CLI；裸 TTY 启动 Ink TUI。
- `ccpatch`：`python/cc-patch` 中的 Python CLI；裸 TTY 启动 Textual TUI。
- 两边共享 [`shared-store-format.md`](docs/shared-store-format.md)、schemas、frozen vectors 与 golden，但各自独立实现 feature、probe、exact replay、store、transaction、CLI 与 TUI。
- 任一实现建立的 baseline、snapshot 与 lock 均可由另一实现直接消费；公开 CLI 双向交替矩阵与共同 PTY 场景是发布 gate。

| feature | 作用 | 依赖 | 可逆性 |
|---|---|---|---|
| `source-exec` | 等长切换 Bun `@bytecode` / `@source__` 标记 | 无 | 可精确逆向 |
| `agent-model` | 把 Agent/Task `model` schema 的 audited enum core 等长替换为 `string()`，receiver 名不进入锚点 | 无 | 可精确逆向 |
| `channels` | 保留 capability check，塌缩 provider/policy/session/marketplace/allowlist 门禁并应用配套开关 | `source-exec` | 决策体塌缩不可逆 |

`agent-model -> source-exec` 已被真实 Claude 2.1.214 临时副本 runtime oracle 证伪：仅应用 agent-model、保留 5 个 `@bytecode` marker 时，真实 Agent schema 已变为 string 并发出 `model=gpt-5.5` 子请求。`channels -> source-exec` 仍按保守 contract 保留。

clean baseline 是唯一恢复真相源。baseline、snapshot 与 lock 位于 shared store v1，不放进 launcher 扫描的 `versions/` 目录；所有 patch 与 feature revert 都从 matching baseline 重放目标集合。`channels` 已 patched 且无 matching baseline 时，两套实现都拒绝猜造 clean bytes。

```bash
unbun cc status --binary /path/to/claude --json
unbun cc patch --binary /path/to/claude --feature channels --json
unbun cc patch --binary /path/to/claude --feature agent-model --json
unbun cc revert --binary /path/to/claude --feature channels --json
unbun cc revert --binary /path/to/claude --json
unbun cc snapshot save before-change --binary /path/to/claude --json
unbun cc snapshot list --binary /path/to/claude --json

uv run --directory python/cc-patch ccpatch --check --binary /path/to/claude --json
uv run --directory python/cc-patch ccpatch patch --binary /path/to/claude --feature agent-model --json
```

裸 TTY 中两套 TUI 都支持按 binary path / feature 过滤、`space`、只切可见项的 `a`、unsupported disabled、mixed replay、提交后重新探测并继续第二次执行。**写权限只由显式 mutating 子命令授予**（`patch` / `revert` / snapshot restore）——不带子命令的调用一律只读，无论是否带 `--binary`、`--json`、`--feature` 等选项；裸非 TTY 只读。

目标由 **canonical（realpath）路径**寻址：写入对象与 store 身份键（`path_key`）同源，因此 `bin/claude -> versions/<ver>` 这类 symlink 安装布局下，patch 作用于真实二进制、symlink 保持不变、同一目标恒得同一 store 命名空间。

平台 gate：Linux 的双实现 shared transaction、runtime oracle 与 production写路径已通过；Windows 仅有 PE结构/exact replay证据，真实 runtime未验证；macOS真实 codesign equivalence未证明，因此 Windows/macOS production gate保持禁用。gate 是 **fail-closed** 的：未启用平台的写请求以 `platform_write_disabled`（exit 1）被拒且目标字节不变，其保护范围是目标二进制的 patch/revert 与 snapshot restore（store-only 操作不在其列，见 `contract/vectors/platform-writes-v1.json` 的 `aggregation_rule.scope`）。当前 live 2.1.217三 feature均patched且无clean baseline，仍只允许只读status。

## 快速上手

```bash
# 纯静态命令的产物由 repoRoot() 定位，恒落**仓库根** refs/claude-code-<version>/
# 与 cwd 无关，从哪个目录调用都一样。
cd ~/src/unbun
bun install

# 静态提取 live claude 的 app bundle（缺省切**仓库根** refs/claude-code-<version>/）
bun cli.mjs extract

# 按模块切分（6000+ per-module 文件 + index.json）
bun cli.mjs split

# 体积分账（打表到 stderr + 写 layout.json）
bun cli.mjs layout

# 静态解出内嵌资产（.node / mermaid …）
bun cli.mjs assets

# 运行时内省：dump Bun.embeddedFiles（只读探针，跑二进制副本）
bun cli.mjs cc introspect "$(readlink -f "$(command -v claude)")" --probe assets

# round-trip 完整性 oracle：extract 产物反向重打包成可运行二进制。
# 产物在**仓库根** refs/（换成上面 extract 出的真实版本号）。
bun cli.mjs rebuild refs/claude-code-2.1.205
```

产物缺省落**仓库根** `refs/`（已由仓库根 committed `.gitignore` 的 `refs/` 规则忽略）；测试用 `test/fixtures/build-fixture.mjs` 即时 `bun build --compile` 出的小型 SFX（非专有、不入库，同样落被忽略处），不依赖 live claude。

## 文档

| 文档 | 回答 |
|---|---|
| [`docs/spec.md`](docs/spec.md) | **做什么 / 为什么**：三支柱能力、通用 vs Claude 专用界定、命令契约、验收标准 |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | **怎么做的 / 在哪里**：lib 分层、数据流、seam 说明、关键机制点睛 |
| [`docs/FINDINGS-phase0.md`](docs/FINDINGS-phase0.md) | **二进制格式事实**：逆向确证并跨版本核验的 Bun `StandaloneModuleGraph` 字节级布局（下游解码器的地基） |
| [`docs/dual-implementation-spec.md`](docs/dual-implementation-spec.md) | **补丁器目标架构**：JavaScript 与 Python 两套完整实现长期并行、共同行为与互操作验收 |
| [`docs/shared-store-format.md`](docs/shared-store-format.md) | **共享磁盘协议**：target identity、baseline、snapshot、lock、exact replay proof 与错误码 |
| [`docs/dual-implementation-acceptance.md`](docs/dual-implementation-acceptance.md) | **发布验收**：规格完成定义、公开CLI互操作、runtime、TUI与平台gate证据 |
| [`docs/generation-one-retirement.md`](docs/generation-one-retirement.md) | **第一代退役映射**：旧测试意图到新contract/feature/transaction/interop suite的逐项对应 |
| [`archive/README.md`](archive/README.md) | **provenance**：`exp/patch-the-claude-binary/` 的原始探索脚本（`git mv` 保历史，加 `ARCHIVED` banner），含被证伪的旧结构模型注解 |

## 依赖

- **acorn**（本地 dependency）— 稳健的顶层语句切分（split）。
- **esbuild**（本地 dependency）— AST 重印美化（beautify）。
- **Ink + React**（本地 dependency）— JavaScript 全功能 TUI。
- **bun**（≥1.3.14）— 工具本体运行时 + `bun test`。
