# L0 — 结构与仓库卫生

> 层目标：不涉代码逻辑，只看**目录布置、git 状态、记忆/文档卫生、命名一致性**。这是 review 的地基层，已在第一阶段完成。
> 上级索引：[README.md](README.md)。

## 一、目录布置全景

独立工具仓库，2026-07-23 从父仓库 `tools/unbun/` 抽出。核心：Bun `--compile` 单文件产物（SFX）静态提取/分析 + 运行时内省，外加**双语言并行**的 Claude Code 二进制补丁管理器（JS `unbun cc` / Python `ccpatch`）。

按职责分为 8 个并列区块：

| 区块 | 路径 | 角色 | 规模 |
|---|---|---|---|
| JS 入口 + 解析层 | `cli.mjs` + `lib/*.mjs` | 通用 SFX 命令的共享解析原语 | 9 顶层模块 |
| JS 补丁器 | `lib/patch/**` | production 补丁管理器（cli/core/io/store/targets/transaction/tui） | 8 子域 |
| JS 探针 | `lib/probes/*.cjs` | 跑在真 Bun 运行时的只读探针 | 3 个 |
| Python 实现 | `python/cc-patch/src/cc_patch/**` | 与 JS 平行的完整第二实现 | 23 文件 |
| 跨实现契约 | `contract/**` | schemas(10) + vectors(4 顶层 + 4 组×[14 fixtures + 4 manifests]=22 JSON) + golden(2 synthetic .bin + SHA256SUMS + README) | — |
| JS 测试 | `test/**` | 顶层 19 + 子目录（contract/interop/patch/pty） | ~64 文件 |
| Python 测试 | `python/cc-patch/tests/**` | 镜像 JS 的独立测试套 | 28 文件 |
| 文档/实验/归档 | `docs/` `exp/` `archive/` `.claude/` | 16 篇 docs + 4 个 PoC + provenance | — |

### 结构亮点（初判，待 L1 深核）

1. **JS 解析层是无环 DAG**：`bun-binary`（纯 ELF 层、对 Bun 格式零知识）← `module-graph`（Bun 格式知识**唯一定居点**）← `extract` ← `split`；`layout` 吃前两者；`diff`/`hook` 独立。seam 切分有明确论证（[ARCHITECTURE.md](../ARCHITECTURE.md)）。
2. **双实现对称**：JS `lib/patch/{core,store,transaction,cli,tui}` 与 Python `cc_patch/{features,store,transaction,cli,tui}` 一一对应，互操作靠磁盘协议（shared store v1 + `contract/` + `shared-store-format.md`），不共享代码。
3. **文档职责分离**：spec（做什么/为什么）、ARCHITECTURE（怎么做/在哪）、FINDINGS（字节级事实）、shared-store-format（磁盘协议）、dual-implementation-*（目标/计划/验收/进度）分层清晰。

## 二、发现清单

| ID | 级别 | 位置 | 问题 | 建议 | 状态 |
|---|---|---|---|---|---|
| L0-01 | 🔴 Blocker → ✅ 已解决 | git 索引 / 工作树 | 首次建档中途状态残缺：`git` 尚无 commit；staged 与 worktree 自相矛盾（旧 `patch-*.mjs` staged-new 却已删）；docs/contract/近半测试未跟踪。 | ✅ 已做 git 检查点：2 个语义提交（`77a0f8a` 独立仓库首次导入含 L1 修复；`bd0f233` review 报告层）；幽灵项已消失；working tree 完全干净。不伪造历史（一代退役已完成、无前史可拆）。 | 已解决 |
| L0-02 | 🟠 Major | `.claude/memory/` | 记忆双失效：`MEMORY.md` 为 **0 字节空文件**（索引丢失），而目录存在一条记录 `unbun-bun-sfx-toolkit.md`，内容**严重滞后**——仍写 `tools/unbun/` 旧路径、把补丁描述成「`cc patch` 就地改写 live claude + backup-revert」，与当前「shared clean baseline + 绝不写 live + 双实现」架构直接矛盾（README 明确：当前 live 三 feature 均 patched 且无 clean baseline、只允许只读 status）。 | 重写该 memory 以反映独立仓库路径与当前架构；重建 `MEMORY.md` 索引行。此为记忆卫生问题，可在 review 收尾时统一处理。 | 待处理 |
| L0-03 | 🟡 Minor | `exp/js-tui-poc/` | 磁盘 23M / 4635 文件，观感吓人。 | 已核实 node_modules 被根 `.gitignore` 正确覆盖，`git add` 实际仅纳入 5 个源文件，符合 `keep-poc-in-project`。**非缺陷，仅记录澄清**，无需处理。 | 已澄清 |

## 三、遗留给后续层的线索

- L0-01 的「generation-one 退役」进行到一半——L1 需核对 [generation-one-retirement.md](../generation-one-retirement.md) 声称的「旧测试意图→新 suite」映射是否与实际删除/新增文件吻合。
- L0-02 暴露出「文档/记忆与当前架构漂移」的风险模式——L1 doc↔code 对账要重点验证 README/ARCHITECTURE 里的命令表、feature 依赖、平台 gate 声明是否与代码一致。
