# L3-JS — 微观代码评审（JavaScript / Bun 侧）

> 层目标：逐模块审 JS 实现的正确性、错误处理、边界守卫与测试有效性。
> 上级索引：[README.md](README.md)。前置：L1（架构对账）、L2（契约等价）结论。

## 评审分块（可各自分派 agent）

| 块 | 范围 | 关注点 | 状态 |
|---|---|---|---|
| J1 通用解析层 | `lib/{bun-binary,module-graph,extract,split,layout,diff,beautify,naming,hook}.mjs` | ELF/trailer 解码正确性、fail-loud 自证、on-demand reader、helper 动态识别、等长守卫 | ⬜ |
| J2 补丁器 core/store | `lib/patch/{core,store,io}/**` | feature registry、依赖闭包、baseline/lineage、cooperative lock、raw-reader | ⬜ |
| J3 补丁器 transaction | `lib/patch/transaction/**` | 原子写、baseline-before-binary 顺序、codesign、snapshots、回读后验/回滚 | ⬜ |
| J4 targets/claude | `lib/patch/targets/claude/**` | 三 feature 的锚点/等长替换、probe、source-exec、variants | ⬜ |
| J5 CLI/TUI | `lib/patch/cli/**`、`lib/patch/tui/**`、`cli.mjs` | 分发、退出码严重度、Ink TUI final-target-set 提交语义、只读/写盘边界 | ⬜ |
| J6 probes | `lib/probes/*.cjs` | 只读探针正确性、CC_EXT 注入、子集 oracle | ⬜ |

## 发现清单

| ID | 级别 | 位置 | 问题 | 建议 | 状态 |
|---|---|---|---|---|---|
| _(待执行)_ | | | | | |
