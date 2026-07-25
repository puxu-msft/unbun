# L2 — 契约与互操作评审

> 层目标：判定 `contract/`（schemas / vectors / golden）是否**名副其实**，以及 JS 与 Python 双实现是否**真等价**——用假绿检测视角，不轻信「已通过/已对齐」的自报。
> 上级索引：[README.md](README.md)。前置：L1 宏观结论（架构心智模型是否可信）。

## 评审提问（待执行时逐条落实）

1. **contract 是否两边都真消费**：`contract/schemas/*.json`(10)、`contract/vectors/**`(22)、`contract/golden/**`(4) 是否 JS 与 Python 都真的加载并断言？还是有一侧只是摆设？（grep 两侧对 contract 路径的引用）
2. **golden 的生成与校验闭环**：`contract/golden/SHA256SUMS` 由谁生成、两侧是否都校验？会不会两侧同源生成、导致同错一起绿（假绿）？
3. **frozen vectors 的独立性**：feature/store/lineage/known-bad vectors 是不是从**冻结 spec** 独立推导，还是从某一侧实现导出的（若后者，等价性证明退化为同义反复）。
4. **互操作矩阵**：`test/interop/**`(13) 是否真的做「JS 建 baseline → Python 消费」「Python 建 snapshot → JS 消费」双向交替？还是只测了单向/半边？
5. **双实现等价的证据链**：README 声称「公开 CLI 双向交替矩阵 + 共同 PTY 场景是发布 gate」——这些 gate 是否有可复现的测试落地，跑起来是否真绿。
6. **known-bad vectors**：是否有对「应当拒绝」的负样本（如 channels 已 patched 且无 baseline 时拒绝猜造 clean bytes）的正向验证。

## 假绿模式检查清单（catching-false-green-tests）
- [ ] 同源 roundtrip（encode↔decode 都用自己的实现，无独立 oracle）
- [ ] 孤立微测跳过集成路径（primitive 单测绿但从未在端到端路径接线）
- [ ] 并行分支各测一半（JS 只测 JS、Python 只测 Python，交叉面无人测）
- [ ] golden 与被测同源生成

## 发现清单

| ID | 级别 | 位置 | 问题 | 建议 | 状态 |
|---|---|---|---|---|---|
| L2-seed-01 | 🔵 Note（待 L2 展开） | test/interop/runtime-oracle.test.mjs:8,142 | 该 release-gate 测试硬编码绝对 fixture 路径 `/home/xp/.local/share/claude/versions/2.1.214` 且依赖 live claude 运行时 + 网络（观察真实 gpt 子请求）。在无网络/无该 fixture 的环境下 clean-oracle 断言即失败（`tool_use_received_by_client`）。属环境耦合，非 gate 回归；但作为发布 gate 的可移植性/CI 稳定性需 L2 评估（是否应 skip-if-unavailable、参数化 fixture）。 | L2 核查：这类 live-runtime 断言在 CI 如何处理；是否有环境探测跳过；`UNBUN_CC_CLEAN_FIXTURE` 覆盖是否文档化。 | 待展开 |
| _(其余待执行)_ | | | | | |
