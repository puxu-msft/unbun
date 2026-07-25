# Exact replay PoC findings

> 状态：Phase 1 PoC 证据于 2026-07-23 冻结；Phase 4 production 状态于 2026-07-25 更新。权威平台能力矩阵为 `contract/vectors/platform-writes-v1.json`。

> **Production 更新：** JavaScript 与 Python shared store/transaction/CLI/TUI 已完成并通过公开进程边界互操作。Linux 临时副本与具备 matching clean baseline 的写路径已启用；当前 live 2.1.217 仍因 channels patched 且 baseline 缺失而只读。Windows 真实 runtime与macOS真实codesign equivalence尚未验证，对应平台production gate继续禁用。

## 结论

Phase 1 固定 `lineage_algorithm=claude-v1-exact-replay`，并证明 JavaScript/Bun 与 Python 两个独立原型能从 frozen clean baseline 和完整 substate vector 重放 synthetic ELF-like 与 PE fixture，再以完整 normalized bytes 而非 version、mask 或 hash-only 结果判定 exact replay。Mach-O 两个独立 normalizer 也对合成签名布局产生相同 normalized bytes。

Phase 1 证据当时不等于生产写能力；Phase 2 至 Phase 4 随后实现并验证 shared transaction。平台矩阵仍分别记录 `format_exact_replay`、`shared_store_transaction`、`runtime_execution_oracle`、`source_exec_dependency_evidence` 与 `production_write_gate`，不能用单一 `writes` 布尔掩盖平台证据差异。

## 两个独立原型

- JavaScript/Bun 原型位于 `exp/exact-replay/js/`。它使用标准库和本目录内审计固定的 replay site 定义，不 import、执行或动态加载 Python 原型及旧生产 patch 实现。
- Python 原型位于 `exp/exact-replay/python/`。它只使用 Python 标准库和本目录内独立固定的 replay site registry，不 import、执行或读取 JavaScript 原型输出及旧 Python feature 实现。
- shared harness 通过两个独立进程边界运行原型。每个成功 case 都执行 JavaScript materialize、Python verify，以及 Python materialize、JavaScript verify；除实现标识外，完整结果对象、exit code、hash 和最终 bytes 必须一致。
- Mach-O normalizer 也分别由 JavaScript 与 Python 实现，contract 直接比较两个进程写出的完整 normalized byte stream。

## Fixture provenance 与 normalization

### Synthetic ELF-like

1031-byte clean 与 all-patched golden 来自旧 Python 项目中已审计 fixture，并由 `contract/golden/SHA256SUMS` 固定 size 和 SHA-256。中间 target 与 mixed fixture 由 immutable clean golden、审计固定 site registry 和 `exp/exact-replay/fixtures/migrate-agent-model-dependency.mjs` 生成后人工 diff；它们是不可执行 synthetic ASCII blobs，不冒充真实 ELF。normalization 为 identity。

### PE

`exp/exact-replay/fixtures/pe/generate-fixtures.mjs` 把 frozen synthetic payload 包装进确定性的不可执行 x86_64 PE32+ corpus。DOS、COFF、optional header、section、alignment、padding 和完整文件 hash 都被固定；PE v1 normalization 为 identity，但双方必须先通过结构解析，不能把任意 bytes 当作 PE 成功。旧 `exp/exact-replay/fixtures/pe/platform-gate.json` 中的 `writes=enabled` 只表示 Task 1.5 的 PE 结构与 replay gate 已通过，不表示真实 Windows runtime 或 production write 已启用；Task 1.7 权威 production gate 为 `disabled-pending-runtime`。

### Mach-O

固定源由 Bun 1.3.14 cross compile 为真实 thin x86_64 Mach-O，并保存完整 2664-byte header/load-command 区。紧凑 fixture 保留真实 header identity，使用可审计的合成 `LC_SEGMENT_64 __LINKEDIT` 与 `LC_CODE_SIGNATURE` 布局。normalization 删除 EOF signature blob，归零 `dataoff/datasize`，并把 `__LINKEDIT filesize/vmsize` 归一化到去签名后的真实长度。Linux 环境没有 `codesign`，所以该 corpus 只证明 parser 和 synthetic normalization，不证明 original-signed 与真实 ad-hoc-resigned 的 codesign equivalence。

## Runtime 与依赖证据

- 普通 Linux Bun 1.3.14 SFX 的临时副本 oracle 是反例：保留 `@bytecode` marker 的源码等长编辑已经从 `42` 变成 `48`，与翻成 `@source__` 的副本相同。因此一般性的 source-exec 必要性为 `not-proven`，不能把 marker 数量当作执行证据。
- 独立 agent-model runtime PoC 在 clean Claude Code 2.1.214 临时副本与随机 localhost Anthropic mock 上运行。只应用 agent-model 且保留 5 个 `@bytecode` marker 的副本已经把 Agent model schema 从 enum 改为 string，并真实发出 `model=gpt-5.5` 子请求；加 source-exec 的副本行为相同。因此 `agent-model -> source-exec` 依赖被 refuted，真实 Claude 临时副本 oracle 为 proven。
- `channels -> source-exec` 尚无同等级行为 oracle，保持 `not-proven`。该未决证据不阻塞 format replay 研究，但阻止 production write gate 汇总为 enabled。

## Negative 与 false-green 防线

- Synthetic 与 PE corpus 覆盖 incomplete/unknown substate、same embedded version but different build、non-feature drift 和 feature-owned clean-byte drift。可重放状态仍必须通过完整 bytes equality，否则返回 `baseline_stale_build`。
- 测试显式证明 hash equality 不能替代 bytes equality，target fixture 不能在运行期充当 expected 生成源，同一实现 round-trip 不能替代跨实现 materialize/verify。
- PE parser 双边拒绝错误 DOS magic、错误 PE magic、截断 header 和 PE32/PE32+ 矛盾 header。
- Mach-O contract cross-boundary 测试要求双方拒绝冲突 signature command、越界 signature blob、与 load-command 区重叠和截断 command；双方各自的独立 unit test 进一步拒绝 FAT container、缺 signature、signature 不在 EOF 和 big-endian 越界结构。
- `test/contract/platform-gates.test.mjs` 要求五种能力分别存在，禁止平台记录或 capability map 出现汇总 `writes` 字段，并构造“PE replay 已通过但 runtime/store/implementation 未通过”的假阳性，证明它只能得到 `disabled-incomplete-evidence`。
- live Claude Code 2.1.217 只允许 read-only observation。它当前三个 feature 均为 patched 且 clean baseline 缺失；禁止从 patched target 猜造 baseline，production gate 固定为 `disabled-no-baseline`。

## 平台 gate

| 平台 | Format exact replay | Runtime oracle | Source-exec dependency | Production write gate |
|---|---|---|---|---|
| Linux | synthetic ELF-like 双原型 cross proof proven | agent-model Claude temporary copy + public CLI patch/revert proven；ordinary Bun necessity not-proven | agent-model refuted；channels contract保留、必要性未独立证明 | `enabled`，仅临时副本或具备matching clean baseline的目标 |
| Windows | PE structure/replay proven | real Windows runtime not verified | platform-specific runtime not verified | `disabled-pending-runtime` |
| macOS | parser 与 synthetic signature normalization proven；real codesign equivalence not-proven | real macOS runtime not run | platform-specific runtime not verified | `disabled-not-proven` |

`shared_store_transaction` 已由两套production实现完成。Linux公开CLI双向覆盖baseline建立/消费、feature追加与移除、revert all、snapshot、lock、same-version different-build拒绝、runtime oracle和live只读边界。Windows/macOS代码存在，但平台runtime/codesign证据不足，所以实现状态与平台启用状态分开记录。

Windows 与 macOS 的 `agent_model_dependency=refuted-on-linux-claude` 只携带 Linux Claude runtime evidence 的来源，不表示本平台已经验证。只有对应平台的真实 Claude runtime oracle 复现 schema 与 wire 行为后，才能升级为无来源限定的 `refuted`；否则 `platform_specific_runtime` 必须保持 `not-verified`，production gate 不得据此放行。

## 测试与性能

Task 1.7 最终 Phase 1 exact-replay 累计回归为 Bun `68 pass / 0 fail / 722 expect()`，耗时 `9.64s`；其中 `agent-model-runtime.test.mjs` 只执行 patch bytes、SSE 与 request oracle 的 `--self-test`。Python exact replay PoC 为 `47 passed in 0.81s`；完整真实 Claude wire probe 由显式设置 `RUN_CLAUDE_RUNTIME_PROBE=1` 的 Python 测试单列执行，结果为 `2 passed in 17.70s`。Task 1.7 平台 gate 聚焦测试为 `6 pass / 0 fail / 39 expect()`，耗时 `1.39s`；其中 live guard 对 268573680-byte 2.1.217 binary 计算前后 SHA-256，并核对精确 legacy baseline path 不存在。

这些数字是当前 Linux 主机上的测试墙钟时间，不是 replay throughput benchmark。Phase 1 没有建立独立 CPU、RSS、冷/热 cache 或大文件吞吐基准，因此不能从上述数字推导生产性能。当前可陈述的性能边界仅是：synthetic/PE corpus 很小，真实 Claude runtime probe 的主要成本是启动临时 Claude 进程；正式 200MB 级 binary replay 与 shared-store transaction 性能留待生产实现出现后测量。

## 残余边界

- Linux 尚无真实 ELF Claude binary 的完整 format replay corpus；当前 format cross proof 是 synthetic ELF-like，真实执行证据来自分开的临时副本 oracles。
- 普通 Bun source-exec 必要性未证明，channels 依赖未裁决。
- Windows 尚未执行真实 Windows Bun/Claude runtime oracle。
- macOS 尚未用真实 `codesign --remove-signature` 与 `codesign -s -` 建立 equivalence。
- Windows真实runtime与macOS真实codesign equivalence仍待对应平台验证；在此之前不得启用其production gate。
- live 2.1.217 没有同 build clean baseline，继续保持 read-only；其他版本的 clean binary 不能充当其 baseline。