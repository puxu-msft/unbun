---
name: unbun-bun-sfx-toolkit
description: ~/src/unbun 是解剖 Bun 单文件产物（含 claude 二进制）的独立 CLI 工具仓库；JS+Python 双实现补丁器靠 shared store v1 互操作，clean baseline 是唯一恢复真相源
metadata: 
  node_type: memory
  type: reference
  originSessionId: 993a5779-dc52-4c42-9870-eecef5d04d85
  modified: 2026-07-25T22:00:32.051Z
---

`~/src/unbun` 是**独立仓库**（2026-07-23 从原父仓库 `tools/unbun/` 抽出，无伪造历史；探索脚本归档在 `archive/`）。用途：**静态提取/分析 + 只读运行时内省任意 `bun build --compile` 单文件产物**，外加针对 Claude Code 二进制的补丁管理。做 bun/claude 二进制逆向、提取、分析、补丁工作前先看它，别重造。

**权威格式事实在 `docs/FINDINGS-phase0.md`**：逆出 Bun `StandaloneModuleGraph` 布局（`.bun` section 内 `---- Bun! ----` trailer 前是 32B Offsets 头 + N×52B 定长记录，每条 name/contents StringPointer + loader 字节）。Bun 格式知识**只定居 `lib/module-graph.mjs`**；`lib/bun-binary.mjs` 是纯 ELF 层。模块 wrapper 靠 helper **签名**动态识别（名字跨版本必漂：205=esm `b`/cjs `K`，201=E/J，**绝不硬编码**）。

**补丁器是 JS + Python 两套完整并行实现**（`unbun cc` 与 `python/cc-patch` 的 `ccpatch`），互不调用核心代码，只经 **shared store v1 + `contract/`**（schemas/frozen vectors/golden）互操作。三 feature：`source-exec`、`agent-model`（均可逆无依赖）、`channels`（依赖 source-exec、不可逆）。

**关键不变量（别记成旧模型）**：clean baseline 是**唯一**恢复真相源；**绝不就地改写 live**，所有 patch/revert 都从 matching baseline 重放；baseline 不放 launcher 扫描的 `versions/`；channels 已 patched 且无 baseline 时两实现都**拒绝猜造** clean bytes。⚠️ 旧记忆里「`cc patch` 就地改写 live claude + backup-revert」的描述已作废。

**平台写 gate 是 fail-closed 的**：仅 `production_write_gate.status === 'enabled'` 的平台（当前只有 Linux）允许 production 写；Windows/macOS 未证明 runtime/codesign 等价，写请求被拒（`platform_write_disabled`，exit 1）且目标字节不变。数据驱动于 `contract/vectors/platform-writes-v1.json`，测试注入 enabled matrix 才能演练平台写内部。

**目标寻址用 canonical（realpath）路径**：写入对象与 store `path_key` 同源。曾因二者不同源，在 `bin/claude -> versions/<ver>` 这类 symlink 布局下 patch 打在 symlink 上（真实二进制未动却报 success）、且 pathKey 漂移使 baseline 不可达——不可逆的 channels 打上后会**永久无法回退**。这是 review 抓到的最严重缺陷，勿再引入。

**写权限只由显式 mutating 子命令授予**（`patch`/`revert`/snapshot restore），不带子命令一律只读，与是否带 `--binary`/`--json`/`--feature` 无关。

**首轮系统性 review 的结论与修复记录在 `docs/review/`**（分层 L0-L4，README 是索引与状态表）。相关：[[knowledge-routing-docs-vs-memory]]；大 bundle 逆向属 fan-out，应外包并发 agent、主线只做紧耦合实现。
