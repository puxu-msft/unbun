# 双实现补丁器验收矩阵

> 日期：2026-07-25。
>
> 权威需求：[`dual-implementation-spec.md`](dual-implementation-spec.md)。共享磁盘协议：[`shared-store-format.md`](shared-store-format.md)。详细实施证据：[`dual-implementation-progress.md`](dual-implementation-progress.md)。

## 完成结论

Linux 范围内，JavaScript/Bun `unbun cc` 与 Python `ccpatch` 已成为两套完整、独立、第一等实现；两边共享contract与store格式，不共享feature/store/transaction核心代码。公开CLI、shared store、runtime oracle、双TUI和故障路径均通过。

Windows与macOS production写gate未开放：Windows缺真实runtime证据，macOS缺真实ad-hoc codesign equivalence。当前live 2.1.217仍因channels patched且matching clean baseline缺失而只读。

## 规格完成定义

| Requirement | 验收证据 | 结果 |
|---|---|---|
| 两个公开CLI独立可运行 | `bun cli.mjs cc --help`；`uv run --directory python/cc-patch ccpatch --help` | PASS |
| 两个完整TUI | JS Ink production PTY；Python Textual PTY；`test/pty/test_dual_tui.py`共同场景 | PASS |
| 核心互不调用 | Python `test_package_boundary.py` 15 tests；JS production源码扫描 | PASS |
| feature状态/sites/substates一致 | `test/interop/differential.test.mjs`、`live-probe-differential.test.mjs` | PASS |
| `agent-model`无`source-exec`依赖 | dependency vectors；真实clean 2.1.214临时副本Agent schema/wire oracle | PASS |
| `channels -> source-exec` | 两个registry与dependency vectors；TUI target closure | PASS，必要性未独立行为证明 |
| shared baseline双向消费 | `test/interop/baseline-replay.test.mjs`通过两个公开CLI运行6个双向场景 | PASS |
| same-version different-build拒绝 | 公开baseline gate与`faults.test.mjs`返回`baseline_stale_build`且bytes/store不变 | PASS |
| feature追加/移除/revert all | `alternating-cli.test.mjs`双向A/B；公开baseline gate | PASS |
| snapshot双向消费 | `public-store-assets.test.mjs`公开CLI 4场景；底层详细store corpus 14场景 | PASS |
| shared lock互斥/显式清理 | `faults.test.mjs`公开CLI；`store-assets.test.mjs`双向holder/cleaner | PASS |
| transaction rollback/error severity | JS/Python transaction fault suites；write/reprobe最高severity；lock release不覆盖主体错误 | PASS |
| JSON schema/error code/exit一致 | contract schemas、公开CLI differential与fault suites | PASS |
| runtime行为与完整revert | `runtime-oracle.test.mjs`：两边patch后schema string + gpt子请求；revert all逐字节恢复并重现enum/no子请求 | PASS（前置：需**已认证** claude 会话与本机 clean fixture；缺 fixture 或未登录时该 gate 由测试内 precondition 探测**显式跳过并告警**，不静默假设已登录，见 review L2A-01） |
| live真实binary只读 | `live-readonly.test.mjs`：2.1.217 hash/mtime/size/store tree前后不变 | PASS |
| frozen golden独立 | `sha256sum --check contract/golden/SHA256SUMS` | PASS |
| known-bad正样本 | `vector-integrity.test.mjs`继续执行归档的一代实现 | PASS |
| live文档同步 | README、INSTALL、ARCHITECTURE、spec、findings、Python README；命令 smoke、相对链接检查，以及 review L1 批次的语义级订正（L1A-01/02/03） | PASS |

## 发布测试数字

```text
bun test
394 pass, 0 fail, 35758 expect() calls, 62 files

uv run --directory python/cc-patch pytest -q
371 passed

bun test test/interop
51 pass, 0 fail, 715 expect() calls, 10 files

uv run --with pytest --with pyte pytest -q test/pty
4 passed, 16 subtests passed

sha256sum --check contract/golden/SHA256SUMS
2 files OK
```

Python全套曾暴露一个legacy compatibility测试把5-byte `.ccbak`写入包内`python/cc-patch/backups/`的隔离缺口。全局autouse fixture现同时隔离`UNBUN_CC_STORE`和`atomicio.BACKUP_DIR`到每个test的`tmp_path`；39个已核实测试artifact已清理。修复后Python全套连续运行两次均371/371，包内backups始终为空，并由`test_atomicio.py`持久断言隔离路径。

共同双TUI场景另连续运行8轮，每轮3 tests/16 subtests，累计24 tests/128 subtests，0 fail；加入真实坏布局positive control后最终focused结果为4 tests/16 subtests。

第一代四个JavaScript测试文件已按[`generation-one-retirement.md`](generation-one-retirement.md)逐项映射并退役，因此Bun数量从归档前422变为当前394；有效意图由新feature/store/transaction/CLI/interop/TUI suite与known-bad positive controls承接，不是coverage静默减少。

## 平台能力

| 平台 | 代码实现 | 证据 | Production gate |
|---|---|---|---|
| Linux | JS+Python完整 | shared transaction、公开CLI互操作、真实Claude临时副本runtime、双TUI | enabled；只限临时副本或具备matching clean baseline的目标 |
| Windows | JS+Python代码存在 | PE结构与exact replay synthetic corpus | disabled-pending-runtime |
| macOS | JS+Python代码存在 | Mach-O parser与synthetic signature normalization | disabled-not-proven |

## 剩余非阻塞项

- Windows真实runtime与binary-in-use行为。
- macOS真实codesign equivalence。
- channels对source-exec必要性的独立行为oracle。
- 真实大小clean build上的完整channels/agent-model交替smoke。

这些项目记录于[`deferred-backlog.md`](deferred-backlog.md)，不会被Linux完成结论掩盖。

## 退役状态

- 第一代JavaScript实现已移入`archive/generation-one-patch/`，production无引用；known-bad corpus继续执行归档代码。
- `~/.claude/scripts/ccpatch`已改为一个发布周期的deprecation shim，转发到独立仓库Python实现。
- 用户已显式授权删除`~/.claude/scripts/cc-patch`、`agent-patch`与`channels-patch`三个旧目录；目录已删除并逐一确认不存在。`~/.claude/scripts/ccpatch`过渡shim、原仓库Git history和`docs/cc-patch`历史文档保留。删除后Bun 394/394、Python 371/371，shim仍能启动独立仓库实现。
