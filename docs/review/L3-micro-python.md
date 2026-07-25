# L3-Python — 微观代码评审（Python 侧）

> 层目标：逐模块审 Python `cc_patch` 实现的正确性、错误处理、边界守卫与测试有效性；并与 JS 侧同名子域做**行为对齐**核查（不是代码复用，而是可观察行为一致）。
> 上级索引：[README.md](README.md)。前置：L1、L2 结论。

## 评审分块（可各自分派 agent）

| 块 | 范围 | 关注点 | 状态 |
|---|---|---|---|
| P1 features | `src/cc_patch/features/**`（agent_model、channels、source_exec、bytes_util） | 与 JS targets/claude 的锚点/等长替换/依赖是否行为一致 | ⬜ |
| P2 store/lineage/lock | `src/cc_patch/{store,lineage,locking,snapshots,models}.py` | shared store v1 读写与 JS 互操作、lock 协议 | ⬜ |
| P3 transaction | `src/cc_patch/{orchestrate,transaction,atomicio,codesign}.py` | 原子写、baseline-before-binary、回滚 | ⬜ |
| P4 probe/report | `src/cc_patch/{probe,report,binaries}.py` | 只读探测、按需 reader、状态/profile 输出 | ⬜ |
| P5 CLI/TUI | `src/cc_patch/{cli,interactive}.py`、`tui/**` | ccpatch 分发、退出码、Textual TUI 语义、与 JS CLI 的 JSON schema 对齐 | ⬜ |

## 发现清单

| ID | 级别 | 位置 | 问题 | 建议 | 状态 |
|---|---|---|---|---|---|
| _(待执行)_ | | | | | |
