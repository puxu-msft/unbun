# ARCHIVED — generation-one JavaScript patch manager

本目录保存 `unbun` 第一代 JavaScript Claude Code patch 实现，仅供 provenance 与 known-bad positive controls 使用，禁止作为production入口运行。

第一代架构使用相邻 `.bak`、逐feature写盘和@clack选择器，存在已冻结缺陷：

- agent-model硬编码minifier receiver `E`。
- channels整文件revert会抹掉后来叠加的feature。
- 相邻backup可能进入launcher扫描目录。
- 缺少shared store identity、exact replay、双实现lock与完整错误合同。

当前production实现位于 `lib/patch/`；Python对等实现位于 `python/cc-patch/`。测试意图映射见 [`../../docs/generation-one-retirement.md`](../../docs/generation-one-retirement.md)。

除 `test/contract/vector-integrity.test.mjs` 的known-bad断言外，production与新测试不得import本目录。
