# 双实现补丁器实施 kickoff

在 `/home/xp/src/unbun` 实施 [`dual-implementation-plan.md`](dual-implementation-plan.md)。权威规格是 [`dual-implementation-spec.md`](dual-implementation-spec.md) 与 [`shared-store-format.md`](shared-store-format.md)；冲突时以规格为准，不自行缩减 feature、互操作、TUI 或平台 fixture 范围。

先从 Phase 0 Task 0.1 开始，逐任务执行 TDD：先写能命中缺陷的失败测试，确认红，再实现，跑窄测试与阶段累计闸门，最后在 `dual-implementation-progress.md` 记录文件清单、验证命令和结果。仓库尚无首个 commit；先核对 `.gitignore`、复跑当前 `bun test` 的 109/109 基线和旧 Python 276/276 测试，再记录独立仓库基线。只有用户明确授权时才创建 commit。

硬约束：

- JavaScript 与 Python 是完整、独立实现，不得通过 import、RPC、FFI、subprocess 或代码生成调用对方核心；跨实现测试只能把两个公开 CLI 或独立 runner 当黑盒。
- 共同 oracle 是 schemas、frozen vectors、golden、人工 byte diff 与运行时行为，不以任一实现为规范。
- 所有写路径只操作合成 fixture 或临时副本。live `2.1.217` 已三 feature patched 且无 baseline，只允许只读 probe，绝不能用于 baseline、patch、revert、snapshot restore、lineage 成功或运行时写验收。
- Phase 1 先完成 JS/Python 两个 ELF exact replay 原型，再做 PE 与 Mach-O fixture/gate；未通过的平台写路径保持 disabled，不得退化为 version-only、masked hash 或 hash-only proof。
- 保留旧 JS 缺陷正样本、跨实现一写一读、临时副本运行时 oracle 与两套 TUI 的真实 PTY screen-grid 测试，防止 false green。
- `claude-v1` 使用修订后的依赖图：`agent-model` 无依赖，`channels` 依赖 `source-exec`，`source-exec` 仍是独立 feature。Phase 0 资产尚未提交或发布，本次属于有 ledger 证据的 pre-implementation correction，不新建虚增 contract 名称。
- 不引入 legacy backup 兼容、durable journal、服务化并发状态机或企业安全扩展。
- 不删除 `/home/xp/.claude/scripts/cc-patch`，直到 Phase 5 前置验收全部通过且删除步骤得到显式确认。

Phase 0 contract 冻结后，Phase 1 的两个原型可并行；Phase 1 完成后，Python Phase 2 与 JS Phase 3 可并行；Phase 4、Phase 5 必须串行。每完成一个任务，更新计划复选框或单独进度 ledger，记录测试命令、结果、commit 与未通过 gate。不要跳过阶段出口，也不要把 skipped fixture/runtime gate 报告为通过。
