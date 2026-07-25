---
name: unbun-bun-sfx-toolkit
description: tools/unbun/ 是解剖 Bun 单文件产物（claude 二进制）的 CLI 工具；FINDINGS-phase0.md 逆出了 Bun StandaloneModuleGraph 二进制格式
metadata: 
  node_type: memory
  type: reference
  originSessionId: f65604ae-7d66-4e59-bea4-186e8ae462c5
---

`tools/unbun/` 是本仓库自研的 CLI 工具，用于**静态提取/分析 + 运行时内省任意 `bun build --compile` 单文件可执行产物**（primary 用例是 claude 二进制）。做 bun 二进制/claude 二进制相关的逆向、提取、分析工作时先看它，别重造。

**命令**（`bun tools/unbun/cli.mjs <cmd>`）：通用 `extract`（切 app.js+美化） / `split`（拆 ~6183 per-module 文件） / `assets`（切内嵌 .node 等） / `layout`（体积分解） / `diff`（跨版本结构 diff） / `rebuild`（bun --compile 重打包，round-trip oracle）；Claude 专用 `cc patch <channels|agent-model>`（**就地功能补丁**，见下） / `cc patch-loader-hook`（等长 loader-hook 打副本） / `cc run --ext` / `cc introspect --probe assets|graph|facts`（只读运行时内省）。

**权威格式事实在 [tools/unbun/docs/FINDINGS-phase0.md]**：逆出了 Bun `StandaloneModuleGraph` 二进制布局（`.bun` section 内 `---- Bun! ----` trailer 之前是 32B Offsets 头 + N×52B 定长记录，每条 name/contents StringPointer + loader 字节；跨 205/201/195 三版实测）。**关键纠正**：旧 `exp/patch-the-claude-binary/README.md`（现 `tools/unbun/archive/README.md`）断言的「文件末 48 字节是 Bun footer 自指针」是**错的**——那是 ELF section header 表被误读；已加删除线注解。

模块 wrapper 靠 helper 定义**签名**动态识别（名字跨版本漂移：205=esm `b`/cjs `K`，201=E/J，**绝不硬编码**）。docs 齐全：spec(what/why) / ARCHITECTURE(how) / FINDINGS（格式事实） / deferred-backlog（A1-A8 待办）。原始 exp 探索脚本归档在 `tools/unbun/archive/`（provenance）。

**就地二进制补丁已并入 unbun**（2026-07-12）：原 `~/.claude/scripts/agent-patch/patch.py`（放开 Agent 工具 model 枚举 `E.enum([...])→E.string()`）与 `channels-patch/patch.py`（启用 `--channels`：决策函数塌缩 + feature-flag/permissions/bun-fallback/cap-strip，打全 9 edit blocks）均 **JS 重写**为 `lib/patch-{channels,agent-model,binary}.mjs`，经 `cc patch <feature> [bin] [--check|--revert|--all]` 就地改写 live claude（channels 走 backup-revert 从干净 .bak 整文件恢复+刷新基线；agent-model 等长可逆走 inplace-revert）。破坏性写拒绝静默批量改多个 live（需 --all/显式 bin）。硬验证：对干净 .bak 打 channels 与原 Python 工具逐字节 0 diff。**原 Python 工具已移出仓库**（channels-patch 原在 `tools/channels-patch/`，现两者均落在 `~/.claude/scripts/{agent-patch,channels-patch}/` 作 provenance 对照；unbun 的 `cc patch` 是仓库内唯一的 JS 等价实现）。

相关：[[knowledge-routing-docs-vs-memory]]；调研/逆向大 bundle 属 fan-out 应外包并发 agent、主线只做紧耦合实现（用户级规则 orchestrate-and-offload / parallelize-agents）。
