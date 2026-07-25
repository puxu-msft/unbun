# Phase 0 CLI interop harness

本目录建立跨实现测试的进程边界，但不声称 Phase 0 已完成正式互操作。当前测试不调用现有一代 patch 写路径，也不写 live Claude binary；写读场景只使用测试创建的临时 fake CLI 与临时 JSON artifact。

## 入口身份

`cli-harness.mjs` 把入口身份作为结果的一部分保留，不能用 normalization 抹掉：

| Identity | Role | Availability |
|---|---|---|
| `unbun-cc` | 未来 JavaScript 公开入口 `bun cli.mjs cc ...` | `future` |
| `ccpatch` | 未来仓库内 Python 公开入口 `uv run --directory python/cc-patch ccpatch ...` | `future` |
| `js-contract-vector-runner` | Phase 0 只读 contract runner | `available` |
| `python-contract-prototype` | Phase 0 独立 Python 只读 prototype，不是公开 `ccpatch` | `available` |

正式 interop 只能在后续阶段使用两个仓库内公开入口。当前 Python runner 不 import 尚未迁入的正式包，JS runner 也不调用 Python；两者分别用各自标准库解析同一 pinned vector。

## Runner 协议

Runner 从 stdin 读取一个 vector path，vector 根必须是 JSON object。成功时 stdout 只包含一个 key-sorted compact JSON document，并以换行结束；失败时 stdout 为空，诊断写入 stderr，退出码为 `1`。

依赖闭包由 runner 内固定的 `claude-v1` 图独立推导：`agent-model` 无依赖，`channels` 依赖 `source-exec`。dependency vectors 与 lineage targets 的每项输出同时保留原始 `request_set` 和推导后的 `closed_set`，不修改 pinned vector，也不把 expected closure 原样当作计算结果。

Feature manifest 中的 `expected_code`，例如 `agent_model_variant_unsupported` 与 `channels_essential_site_missing`，属于 feature conformance code namespace。它们不是共享 store/public CLI 的 `error.schema.json` enum，不应拿该 public error schema 验证。

## Normalization 白名单

`normalize-output.mjs` 只替换以下动态值：时间字段、调用方显式提供的临时根目录下的绝对路径、PID、hostname，以及输出 JSON 内的 implementation label。外部 boundary identity、role、maturity 与 availability 保持原值，因此 prototype 不会伪装成正式公开入口。

Normalizer 不删除或改写 feature state、`sites`、hash、error/conformance `code`、exit 或 manifest 字段。`cli-harness.test.mjs` 保留包含这些字段的正样本，防止将过度 normalization 误判为一致。

运行 Phase 0 窄测试：

```bash
bun test test/contract test/interop/cli-harness.test.mjs
```

## Phase 4 底层 transaction adapters

`js-transaction-runner.mjs` 与 `python-transaction-runner.py` 是 Tasks 4.2-4.3 在公开 CLI/TUI 接线前使用的黑盒 process adapters。它们不属于产品入口，也不实现 feature、dependency、transaction、snapshot、manifest、blob 或 lock 逻辑：每个 runner 只把 stdin 的一个 JSON request 映射到本语言仓库内的正式 transaction/store API，且不会 import、执行或调用另一种语言的实现。

测试进程通过 `UNBUN_CC_STORE` 指定全新临时 store root；request 中的 `store` 必须与该环境变量完全相同。Python runner 在独立进程内让 `cc_patch.orchestrate` 从该环境初始化自己的 process-global store，因此不会污染测试宿主或后续 runner。所有 binary 都由 `contract/golden/claude-v1/synthetic-2.1.175-clean.bin` 复制到临时路径，测试不读取或写入 live binary/store。

Runner 当前从 stdin 接收一个 JSON object；未来 harness 可以扩展 argv transport。当前 action 字段为 `write-features`、`snapshot-save`、`snapshot-list`、`snapshot-restore`、`snapshot-rm`、`inspect-store`、`lock-hold` 与 `lock-cleanup`；其余字段按 action 使用 `binary`、`store`、`features`、`snapshot`、`version`、`force` 或 `release`。stdout 始终只有一行 JSON；成功退出 `0`，失败退出共享 error code 对应的 exit，stderr 保持为空。

每个成功响应都包含 implementation、最终 feature states、binary SHA-256 与完整 `store/v1` 文件树摘要。文件树逐文件保留相对路径、大小和 SHA-256，因此 manifest 与 content-addressed blob 都会参与跨实现比较，而不只是比较 probe state。

当前底层矩阵覆盖：

- JS 建 baseline 并 patch channels，Python 消费同一 baseline 追加 agent-model，JS 移除 channels 并保留无 source 依赖的 agent-model，Python revert all 后逐字节等于 original；完整反向角色同样执行。
- 一边建立 baseline 后，另一边从 exact-replay-valid mixed channels 入站态修复到完整 channels；同版本不同 build 在双方都以 `baseline_stale_build` 拒绝，且 binary 与 store tree 不变。
- JS save 后 Python list/restore/rm，以及完整反向角色；覆盖 force activation、同 slug 跨构造版本的选择、显式跨版本 restore、invalid active manifest 与 orphan blob。restore 后比较完整 binary bytes，不只比较 feature state。
- JS 与 Python 分别持有正式 mkdir lock 时，对方 writer 返回 `target_locked`，binary 与 active assets 不变。
- owner 损坏的 unknown-owner stale lock 在两边都只有显式 `force` cleanup 才能解除，cleanup 前后不改 binary、baseline 或 snapshot。

运行底层互操作测试：

```bash
bun test test/interop/baseline-replay.test.mjs test/interop/store-assets.test.mjs
```

这组 adapter 测试不替代冻结计划中的公开 CLI JSON envelope、Task 4.1 differential suite 或 Phase 4 出口；等 CLI/TUI 接线完成后，公开入口矩阵仍需另行执行。