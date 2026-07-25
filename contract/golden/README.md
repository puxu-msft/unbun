# Claude v1 frozen golden bytes

这些文件是测试 oracle，不在测试运行期由 JavaScript 或 Python feature 实现生成，也不允许日常测试自动更新。

## 来源与状态

| 文件 | 历史来源 | size | SHA-256 | 状态 |
|---|---|---:|---|---|
| `claude-v1/synthetic-2.1.175-clean.bin` | `/home/xp/.claude/scripts/cc-patch/tests/golden/synthetic-2.1.175-clean.bin` | 1031 bytes | `0a067e12954675a56d6a2aa25c4180c1746005d5cd9e438607d0fb913355ff61` | `source-exec=clean`、`agent-model=clean`、`channels=clean` |
| `claude-v1/synthetic-2.1.175-all-patched.bin` | `/home/xp/.claude/scripts/cc-patch/tests/golden/synthetic-2.1.175-all-patched.bin` | 1031 bytes | `3a8abf7b34a7c77f94d87e4939e380d6c075d85f6bedbc387c8ac0d5c9fee650` | `source-exec=patched`、`agent-model=patched`、`channels=patched` |

## 人工审计依据

历史 `_generate.py` 的审计记录说明，最初的 2.1.175 fixtures 已与退役实现逐字节核对；历史 `test_golden.py` 还逐项列出三个 feature 的 owned ranges，检查跨 feature 区间不重叠，并验证两个可逆 feature 能恢复 clean bytes。迁入本仓库时再次以 `cmp` 对两份源文件逐字节核对，并独立运行 `sha256sum` 与 `stat`，确认内容、hash 和 1031-byte size 完全一致。

clean 与 all-patched 的预期差异只允许出现在已审计的 source tag、model core、channel decision body、feature flag、permissions flag 与 capability-strip sites。任何更新都必须先人工复核 byte diff，记录双实现变更理由，并显式更新 `SHA256SUMS` 与引用它们的 manifests。