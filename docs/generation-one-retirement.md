# 第一代 JavaScript patch 实现退役映射

> 状态：退役已完成，production 已切换到 `lib/patch/`；根级 `lib/patch-*.mjs` 已删除并归档到 `archive/generation-one-patch/`。本表留作历史核对与测试意图追溯。

## Production 引用结论

`cli.mjs` 与 `lib/patch/` 不 import 第一代模块。第一代模块只互相引用，并由旧测试与 known-bad positive controls 使用：

- `lib/patch-binary.mjs`
- `lib/patch-agent-model.mjs`
- `lib/patch-channels.mjs`
- `lib/patch-tui.mjs`

当前 production JavaScript入口是 `lib/patch/cli/`，Python入口是 `python/cc-patch/src/cc_patch/`。

## 测试意图映射

| 第一代文件 / 行为 | 新实现或共同contract中的覆盖 | 处置 |
|---|---|---|
| `patch-agent-model`: 等长replacement | `test/patch/agent-model.test.mjs`、`contract/vectors/feature-claude-v1/`、frozen golden | 已迁移 |
| `patch-agent-model`: apply幂等、多site、unsupported、不修改caller | `test/patch/agent-model.test.mjs`、`test/patch/feature-contract.test.mjs` | 已迁移 |
| `patch-agent-model`: reversible roundtrip | JavaScript/Python feature tests、`test/interop/runtime-oracle.test.mjs` 的公开CLI patch/revert与逐字节恢复 | 已迁移，并有真实runtime oracle |
| 硬编码receiver `E` | `contract/vectors/known-bad-v1/` 与 receiver-independent audited variants | 保留为known-bad，不迁移实现 |
| `patch-channels`: brace matcher、decision定位/塌缩 | `test/patch/channels.test.mjs`、feature vectors | 已迁移 |
| `patch-channels`: feature flag、permissions、cap-strip、source marker | `test/patch/channels.test.mjs`、`test/patch/source-exec.test.mjs` | 已迁移；source-exec拆成独立feature |
| `patch-channels`: essential缺失、best-effort absent、unsupported | channels vectors与JavaScript/Python feature tests | 已迁移 |
| `patch-channels`: quick/full一致 | `test/patch/probe.test.mjs`、`test/interop/live-probe-differential.test.mjs` | 已迁移到共同window contract |
| `patch-binary`: version probe | `lib/patch/targets/claude/probe.mjs`、Python `probe.py`及差分测试 | 已迁移 |
| `patch-binary`: 相邻 `.bak` | shared store v1 manifests/content-addressed blobs；known-bad corpus要求第一代失败 | 已废弃，不迁移 |
| `patch-binary`: channels整文件`.bak` revert | clean baseline + final target set replay；`alternating-cli`和公开`baseline-replay`证明移除channels保留agent-model | 已废弃且被更强语义取代 |
| `patch-binary`: mixed从`.bak`自愈 | exact replay proof + replayable substate vectors；公开baseline E2E | 已迁移，不信任邻接backup |
| `patch-binary`: stale `.bak`刷新 | same-version different-build exact replay拒绝与`baseline_stale_build` | 旧行为被刻意拒绝 |
| `patch-binary`: 原子替换、mode、binary-in-use | `test/patch/transaction.test.mjs`、`transaction-faults.test.mjs` | 已迁移并增强回读/回滚/quarantine |
| `patch-tui`: direct/batch/refuse与@clack确认 | 两套全功能TUI model/controller/PTY，共同TUI场景；显式CLI参数契约 | 第一代交互模型废弃，不迁移 |
| `patch-tui`: unsupported禁用、可见项批量 | `test/patch/tui/`、Python TUI tests、`test/pty/test_dual_tui.py` | 已迁移并跨实现验收 |

## 旧测试文件

| 旧测试 | 状态 |
|---|---|
| `test/patch-agent-model.test.mjs` | 全部有效意图已映射到 `test/patch/agent-model.test.mjs` 与runtime oracle |
| `test/patch-channels.test.mjs` | 全部有效意图已映射到 `test/patch/channels.test.mjs`、`source-exec.test.mjs`与probe差分 |
| `test/patch-binary.test.mjs` | `.bak`行为不再是目标；其version/等长/幂等/mixed/组合意图由新feature/store/transaction/interop覆盖 |
| `test/patch-tui.test.mjs` | 第一代@clack选择策略不再是产品契约；可见项切换、disabled与目标集合已由双TUI覆盖 |
| `test/contract/vector-integrity.test.mjs` 中对第一代模块的import | 仅用于证明known-bad corpus能够击败旧实现；归档时已改指向 `archive/generation-one-patch/`，该正样本仍保留 |

## 已完成的删除或归档核对

1. `rg`已证明 production 不引用第一代文件。
2. known-bad positive controls 继续实际执行归档实现并观察到预期失败。
3. `bun test`、Python 全套、公开 interop、共同 PTY 与 golden 校验均已通过。
4. 第一代文件已移入 `archive/generation-one-patch/`，archive README 已说明其不可作为 production 运行；known-bad test import 已更新。
5. 归档后已重新扫描源码，production 不从 `archive/` import。
