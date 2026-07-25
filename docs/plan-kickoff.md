# unbun 实施 — 续跑 kick-off（Stage 4-5）

> 给接手的新会话：`unbun` 工具（Bun 单文件二进制提取/分析/内省）的实施已完成 **Stage 0-3**（6 个静态命令 `extract`/`split`/`assets`/`layout`/`diff` 全绿，全部经独立对抗评审、真二进制验证）。本文让你从 durable ledger 无损续跑 **Stage 4（cc 运行时内省）+ Stage 5（rebuild/exp 归档/docs）+ final whole-branch review**。截至 commit `1944ab4`，全套 `bun test` 14 pass。

## 起手（按顺序读）

1. **进度 ledger（权威、可恢复）**：`.superpowers/sdd/progress-unbun.md` — 已完成任务的 commit SHA、每任务的评审结论、剩余任务清单、累积 Minor 清单。**ledger 标为 complete 的任务=已 DONE，别重跑**；`git log --oneline` 交叉核。
2. **实施计划**：`tools/unbun/docs/plan.md` — Stage 2-5 的完整 task 分解（Files/Interfaces/TDD 步骤/代码）。
3. **规格**：`tools/unbun/docs/spec.md` — what/why + Global Constraints。
4. **格式事实（Stage 0 逆向产出，下游解码地基）**：`tools/unbun/docs/FINDINGS-phase0.md` — Bun StandaloneModuleGraph 布局、helper 双签名判据、version P0-d 锚、无 sourcemap 结论。

## 已建成的接口（Stage 2-5 消费它们，别重造）

- `lib/bun-binary.mjs`：`readBinary(bin)→{buf,sections,elf}`、`defaultBinary()`。
- `lib/module-graph.mjs`：`parseModuleGraph(bin)→{trailerOffset,entryPointId,blobs:[{name,offset,length,loader,isEntry}]}`（fail-loud 自证）。
- `lib/extract.mjs`：`extractApp(bin)→{app,version,blob:{offset,length}}`（isEntry 权威消歧、version P0-d 锚）。
- `lib/beautify.mjs`：`beautify(app)→string`。
- `cli.mjs`：`switch(argv[2])` 分发，`extract` 已实现，其余子命令占位「not yet implemented」待填。

## 工作流（严格照做）

用 **superpowers:subagent-driven-development** skill：每 task 一个 fresh implementer subagent → task review（spec 合规 + 质量）→ 有 Critical/Important 就 fix→re-review 闭环 → 更新 ledger。脚本在 `~/.claude/plugins/cache/superpowers-marketplace/superpowers/6.1.1/skills/subagent-driven-development/scripts/`（`task-brief PLAN N`、`review-package BASE HEAD`）。**每 task 用 task-brief 抽 brief 成文件**，dispatch 里给 brief 路径 + 消费的接口 + 消歧，别把历史粘进去。report 用 `.superpowers/sdd/unbun-task-N-report.md`（带 unbun 前缀避免撞邻居 scratch）。

**模型选择**：机械转录用 sonnet；2.1 split（helper 识别有判断）用 sonnet/opus；review 按 diff 规模选。

## 关键纪律（本仓库硬约束，务必传给每个 subagent）

- **共享 main 树 + 活跃并发邻居**（另一会话在做 intercom channel-self-probe，同 main 提交、HEAD 常动）：一律精确 pathspec `git add -- <文件>` / `git commit -m "msg" -- <文件>`（**`-m` 在 `--` 前**）；**绝不** `git add -A`/`-am`/`clean`/`reset --hard`/`restore`/裸 `stash`；提交前 `git diff --cached --name-status` 验暂存集只含 tools/unbun/ 自己文件（会看到邻居预暂存的 `.claude/settings.json`、`claude-remote-3rd/...`——别碰别提）。**review-package 锚 my-commit^..my-commit**（邻居 commit 会交错，别用 recorded-BASE..HEAD）。**用独立 ledger `progress-unbun.md`，绝不碰邻居的 `progress.md`**。
- **bun** 跑测试；纯静态命令不执行目标 binary；`cc` 命令只对副本打桩+跑。
- **版本无关**：helper 按 FINDINGS 签名判据动态识别，绝不硬编码 minified 名（E/Q/ve 跨版本变）。
- **长度精确非盲**：切 blob 用 module-graph 权威 offset/length，JS 靠整块 acorn 解析+`})` 收尾验，绝不对启发式 run 做 latin1。
- **oracle 是子集**：`embeddedFiles ⊆ static assets`，绝不 `===`。
- 测试断言结构/行为，**绝不 byte-pin 专有文案**；活二进制 smoke 走 gitignored 路径、不入库（refs/ 已忽略）。

## 剩余任务（照 plan.md 逐个）

- **Stage 2** ✅ 已完成（split + CLI split/index，commit 4aa17bd/f0535ba/7be1187）。
- **Stage 3** ✅ 已完成（assets/layout/diff + PLACEHOLDER 单一真相源根因修复，commit 17aa30a/37db4b4/22f5bbf/bc38dff/1944ab4）。
- **Stage 4**：4.1 `lib/hook.mjs`（等长 loader-hook，`patchLoaderHook(buf,{anchor,payload})`、`CC_ANCHOR/CC_PAYLOAD` 常量、守卫拒碰 versions/ live、合成 buffer 单测）；4.2 probes（`dump-assets/module-graph/runtime-facts.cjs`）+ CLI `cc run/introspect` + 可打桩 fixture（**`//!` 法律注释等长锚**——`//` 注释被 bun bundler 剥、string/`//!` 存活；`with{type:'file'}` 嵌小资产填充 `Bun.embeddedFiles`；子集 oracle）；4.3 double-magic fixture 消歧真测（去 skip）。
- **Stage 5**：5.1 `rebuild`（`bun build --compile`，round-trip 无损 oracle）；5.2 `git mv exp/patch-the-claude-binary/*` → `tools/unbun/archive/` + 每脚本 `ARCHIVED` banner + 被证伪的 README「footer 自指针」断言加删除线注解指向 FINDINGS（B1 核验）+ archive/** 排除出 lint/test glob；5.3 `README.md` + `docs/ARCHITECTURE.md` + spec 状态改「已实现」。

## 收尾（全部 task 后）

1. **final whole-branch review**（opus，用 `review-package $(git merge-base ...) HEAD`）——指向 ledger 的「Minor 累积清单」triage 哪些 merge 前必修。
2. Minor 累积清单（已在 ledger）：bun-binary 名字扫描越界守卫 + ELF magic 校验；module-graph 死分支/检查前置；**extractApp 双读 257MB → 给 module-graph 加接受/透出 buf 复用 seam**（较值得）。
3. **superpowers:finishing-a-development-branch**。
4. 活文档回写：spec 状态、ARCHITECTURE、README；本 kickoff 与 FINDINGS 归位。
5. 归还 `.superpowers/sdd/task-*.md`、`review-*.diff`、`unbun-task-*-report.md` scratch（gitignored，可留可清）。

当前 HEAD 的 unbun 工作止于 commit `1944ab4`（Stage 3 末，全套 14 pass）。开跑 Stage 4 前记录 BASE。剩余仅 **Stage 4（cc）+ Stage 5（rebuild/归档/docs）+ final review**——详见 durable ledger `.superpowers/sdd/progress-unbun.md` 的「剩余」段与「Minor 累积清单」。
