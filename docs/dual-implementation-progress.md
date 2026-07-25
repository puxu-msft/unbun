# 双实现补丁器实施进度

> 计划：[`dual-implementation-plan.md`](dual-implementation-plan.md)
>
> 最近更新：2026-07-23。
>
> 当前工作树尚无 commit。每个 Task 记录明确文件、验证命令和结果；只有用户明确授权时才创建 commit。

## Phase 0

### Task 0.1：独立仓库可复现基线

状态：完成。

变更文件：

- `.gitignore`
- `README.md`
- `package.json`
- `bun.lock`
- `docs/dual-implementation-spec.md`
- `docs/shared-store-format.md`
- `docs/dual-implementation-plan.md`
- `docs/dual-implementation-kickoff.md`
- `docs/dual-implementation-progress.md`

决策与结果：

- `unbun` 已从原父仓库 `tools/unbun/` 主动抽出为独立工具；README 记录 provenance，不伪造原 Git history。
- 根 `.gitignore` 明确排除 `node_modules/`、生成产物、Python 缓存和 `.claude/memory/`，正式源码、测试、archive 与 exp 仍可见。
- 将父仓库隐式提供的 `esbuild` 加入本地 dependency，独立仓库不再依赖父级安装。
- 删除 commit 作为阶段闸门的假设；当前以本 ledger 记录 Task 边界。
- 旧 `.ccbak`、`.agentbak`、`.channels.bak` 已按用户决定删除，不进入新 store migration。

验证：

```text
bun test
109 pass, 0 fail, 33117 expect() calls, 23 files

uv run --directory /home/xp/.claude/scripts/cc-patch pytest -q
276 passed in 23.32s

get_errors README.md package.json dual-implementation-spec.md shared-store-format.md plan/kickoff
No errors found
```

基线摘要，计算时尚未包含本 ledger 文件：

```text
git status --short --untracked-files=all | sort
sha256: 02aee32504853df8f48fc7490a050a8cf36b2885093e5f2194b64f46ea0ffb27

正式文件逐文件 sha256 后再聚合
sha256: 97426a480fd6adba4409f64f08cb7f0c009c8084c5d9d413fa010274d82b62aa
```

只读迁移事实：

- live `~/.local/share/claude/versions/2.1.217`：三个 feature 均 patched，无 baseline。
- clean `2.1.214` 与扩展内置旧版本不能作为 `2.1.217` baseline。
- 新实现面对 live `2.1.217` 必须返回 `channels_patched_no_baseline`，不得写入或猜造 baseline。

### Task 0.2：Schemas 与错误目录

状态：完成。

变更文件：

- `package.json`
- `bun.lock`
- `contract/README.md`
- `contract/schemas/status.schema.json`
- `contract/schemas/write-envelope.schema.json`
- `contract/schemas/error.schema.json`
- `contract/schemas/target.schema.json`
- `contract/schemas/baseline.schema.json`
- `contract/schemas/snapshot.schema.json`
- `contract/schemas/lock-owner.schema.json`
- `contract/schemas/quarantine.schema.json`
- `contract/vectors/error-codes-v1.json`
- `contract/vectors/canonical-path-v1.json`
- `test/contract/schema.test.mjs`

决策与结果：

- 使用 Bun 包管理器解析并安装 `ajv@8.20.0` 与 `ajv-formats@3.0.1`，采用 JSON Schema Draft 2020-12，不实现自定义 validator。
- 八个 schema 使用固定 `$id` 与 `schema_version: 1`，拒绝缺失字段、错误类型、未知 schema identity、更高 schema version、非法 slug/version、非法 hash、绝对 blob path 与 `..` traversal。
- schema 保持 `additionalProperties` 默认开启，测试证明同版本未知可选字段被接受。
- error vector 冻结共享 store 格式 §12 的 19 个 code、exit severity 与语义；自然语言 runtime message 不作为 golden。
- canonical path vector 冻结 POSIX symlink、空格、NFC，以及 Windows drive、UNC、混合 separator、`Ü`、`ß` 和仅 ASCII lowercase 行为；每个 `path_key` 是 canonical UTF-8 bytes 的完整 SHA-256 lowercase hex。

TDD 证据：

```text
bun test test/contract/schema.test.mjs
RED: 0 pass, 1 fail, 1 error
Cause: ENOENT contract/schemas/status.schema.json

bun test test/contract/schema.test.mjs
GREEN: 20 pass, 0 fail, 116 expect() calls
```

### Task 0.3：Frozen vectors 与 known-bad

状态：完成。

变更文件：

- `contract/vectors/feature-claude-v1/manifest.json` 及 8 个 pinned fixture
- `contract/vectors/store-v1/manifest.json` 及 2 个 pinned fixture
- `contract/vectors/lineage-v1/manifest.json` 及 2 个 pinned fixture
- `contract/vectors/known-bad-v1/manifest.json` 及 5 个 pinned fixture
- `contract/golden/README.md`
- `contract/golden/SHA256SUMS`
- `contract/golden/claude-v1/synthetic-2.1.175-clean.bin`
- `contract/golden/claude-v1/synthetic-2.1.175-all-patched.bin`
- `test/contract/vector-integrity.test.mjs`

决策与结果：

- 复制旧 Python 项目中已审计的 1031-byte synthetic clean/all-patched golden，并固定来源、size、SHA-256 与人工审计依据；日常测试不调用生成器。
- feature vectors 覆盖 source-exec discovery/state、receiver-independent agent-model variants、channels decoys/essential/best-effort 与依赖闭包。
- store 与 lineage vectors 覆盖 manifest faults、orphan/temp/lock/snapshot、target feature 集合、mixed 与 same-version different-build。
- 五类 known-bad 都有 `expected_failure` 与 `assertion`。原始“agent-only 缺 source-exec”正样本基于后来被决定性运行时 PoC 证伪的假设，已在下述 pre-implementation correction 中替换为旧 contract 错误添加 source-exec 的可执行正样本；其余正样本继续观察硬编码 receiver、channels revert 抹掉 agent-model、相邻 `.bak` 与 collapsed exit 的失败。

TDD 证据：

```text
bun test test/contract/vector-integrity.test.mjs
RED: 0 pass, 6 fail
Cause: manifests, golden README, and checksum inventory absent

bun test test/contract/vector-integrity.test.mjs
GREEN: 6 pass, 0 fail, 421 expect() calls

sha256sum --check contract/golden/SHA256SUMS
2 files OK
```

### Phase 0 累计闸门（Tasks 0.1-0.3）

```text
bun test test/contract/schema.test.mjs test/contract/vector-integrity.test.mjs
26 pass, 0 fail, 537 expect() calls

bun test
135 pass, 0 fail, 33654 expect() calls, 25 files
```

### Task 0.4：Contract runners 与 CLI harness

状态：完成。

变更文件：

- `test/contract/js-vector-runner.mjs`
- `test/contract/python-vector-runner.py`
- `test/interop/cli-harness.mjs`
- `test/interop/normalize-output.mjs`
- `test/interop/cli-harness.test.mjs`
- `test/interop/README.md`

决策与结果：

- 两个 runner 都从 stdin 读取一个 vector path，分别使用 JavaScript 与 Python 标准库独立解析；成功时 stdout 只有 key-sorted compact JSON，失败时 stdout 为空且 stderr 输出带 runner identity 的诊断。两边不 import、执行或调用对方，也不调用 patch 实现。
- dependency requests 与 lineage targets 都输出原始 `request_set`，并按固定 `claude-v1` 依赖图独立推导 `closed_set`；未修改 pinned lineage vector，也未把 expected closure 当作计算结果。
- CLI harness 提供可注入 command boundary。未来公开入口 `unbun-cc` 与 `ccpatch` 标记为 `public-contract / future`；当前 `python-contract-prototype` 明确是 Phase 0 只读 prototype，不伪称仓库内正式 `ccpatch` 或正式 interop 已完成。
- 当前 JS 写、Python 读场景只使用测试临时目录中的 fake CLI 和 JSON artifact。没有调用第一代 patch 写路径，没有写 live binary。
- normalization 只处理时间、显式临时根目录内的绝对路径、PID、hostname 与 JSON 内 implementation label；boundary identity 不归一化。正样本证明 feature state、`sites`、hash、code、exit 与 manifest 字段不会被删除或改写。
- feature vector 的 `agent_model_variant_unsupported`、`channels_essential_site_missing` 等 `expected_code` 属于 feature conformance code namespace，不使用 public `error.schema.json` enum 验证。
- 完整 dependency closure 输出对照 pinned `dependency-expected.json` 的 8 个 closure；lineage target 同时运行两 runner 并比较结构化结果。两个 runner 都要求 vector 根为 JSON object，并对 array 根对称地以 stderr 诊断和退出码 `1` 拒绝。
- 未修改 patch 实现、schema、vector、golden、`package.json` 或 `bun.lock`。

TDD 证据：

```text
bun test test/interop/cli-harness.test.mjs
RED positive control: 0 pass, 1 fail
Expected: python-write-js-read
Received: js-write-python-read

bun test test/interop/cli-harness.test.mjs
GREEN after restoring expected: 1 pass, 0 fail

bun test test/interop/cli-harness.test.mjs
RED before runners/environment propagation: 2 pass, 5 fail
Cause: fake implementation identity absent; JS/Python runner files absent

bun test test/interop/cli-harness.test.mjs
GREEN before independent review: 8 pass, 0 fail, 29 expect() calls

bun test test/interop/cli-harness.test.mjs
REVIEW RED: 8 pass, 1 fail
Cause: JS runner accepted a JSON array root while Python rejected it

bun test test/interop/cli-harness.test.mjs
FINAL GREEN: 9 pass, 0 fail, 37 expect() calls
```

窄闸门：

```text
bun test test/contract test/interop/cli-harness.test.mjs
35 pass, 0 fail, 574 expect() calls, 3 files
```

### Phase 0 累计闸门（Tasks 0.1-0.4）

```text
bun test test/contract test/interop/cli-harness.test.mjs
35 pass, 0 fail, 574 expect() calls, 3 files

bun test
144 pass, 0 fail, 33691 expect() calls, 26 files

uv run --directory /home/xp/.claude/scripts/cc-patch pytest -q
276 passed in 23.50s
```

Phase 0 的 contract process boundary 已建立，但两个仓库内正式公开 CLI 尚未完成，因此正式双向 interop 矩阵仍属于后续阶段。

## Phase 1

状态：合同与 PoC 完成；所有 production write gate 仍按证据层级显式禁用，未实现生产写路径。

### Task 1.1：Exact replay fixture 与结果合同

状态：完成。

变更文件：

- `contract/README.md`
- `contract/schemas/exact-replay-result.schema.json`
- `exp/exact-replay/README.md`
- `exp/exact-replay/fixtures/manifest.json`
- `exp/exact-replay/fixtures/synthetic-2.1.175-target-source-exec.bin`
- `exp/exact-replay/fixtures/synthetic-2.1.175-target-agent-model.bin`
- `exp/exact-replay/fixtures/synthetic-2.1.175-target-channels.bin`
- `exp/exact-replay/fixtures/synthetic-2.1.175-mixed-replayable.bin`
- `exp/exact-replay/fixtures/synthetic-2.1.175-mixed-unreplayable.bin`
- `exp/exact-replay/js/replay-proof.mjs`
- `exp/exact-replay/python/replay_proof.py`
- `test/contract/schema.test.mjs`
- `test/contract/exact-replay-harness.test.mjs`
- `docs/dual-implementation-progress.md`

决策与结果：

- 复用 1031-byte frozen clean/all-patched golden；clean 与 target-all 直接引用原件，测试只修改临时副本，源文件 hash 在 drift 前后均受断言保护。
- 原件是 synthetic ASCII blob，不是可执行 ELF；manifest 如实记录 `format=synthetic-elf-like`、`executable=false`、`arch=synthetic`。真实 Bun SFX 与 ELF runtime proof 留给 Task 1.4。
- manifest 初始冻结 8 个 request/closure target sets、当时依赖图下的唯一闭包状态、可 replay mixed、不可 replay mixed、same-version/different-build drift 与 feature-owned clean-byte drift。原始中间 fixture 曾由成熟 Python registry 派生；本次 contract correction 已用不调用生产实现的独立迁移脚本从 immutable clean golden 重新冻结 agent-only 与显式 source-plus-agent bytes，详情见下述迁移记录。all-target 始终必须逐字节等于 frozen all-patched golden。
- same-version/different-build 在非 feature-owned offset 30 注入单字节 drift；feature-owned 负样本在 channels decision-body owned range 内的 offset 600 注入单字节 drift，成熟探测仍将三个 feature 全部识别为 clean。两者均可从 baseline 完整重放 expected bytes，并固定为 `baseline_stale_build`、`byte_equal=false`，防止 version-only 与 masked-byte 假证明；无法完整观察的 mixed 则固定为 `substate_unreplayable` 且没有 expected hash。
- `exact-replay-result.schema.json` 固定 `implementation/format/supported/normalized_size/baseline_lineage_sha256/expected_sha256/current_sha256/byte_equal/error`。条件 schema 禁止 unsupported 骨架声称 equality，也禁止 supported success 缺 expected hash 或带 error。
- JS 与 Python 文件仍是明确未实现骨架：只读取 fixture 元数据与 current bytes，输出稳定 `supported=false`、`error=not_implemented` JSON，并以 exit 3 失败；没有调用对方实现，也没有实现 replay、normalization 或 success path。

TDD 红灯：

```text
bun test test/contract/exact-replay-harness.test.mjs
0 pass, 6 fail
Expected failure: manifest.json and exact-replay-result.schema.json did not exist; no skeleton could produce a false green.
```

窄绿灯：

```text
bun test test/contract/exact-replay-harness.test.mjs
7 pass, 0 fail, 88 expect() calls

bun test test/contract/schema.test.mjs test/contract/exact-replay-harness.test.mjs
29 pass, 0 fail, 213 expect() calls

bun test test/contract
35 pass, 0 fail, 634 expect() calls

get_errors Task 1.1 code, JSON, Markdown, and tests
No errors found
```

独立评审红灯与修复：

```text
REVIEW RED: manifest encoded baseline_stale_build with supported=false while the result schema reserved supported=false for unavailable proof paths; one request subset was also absent.

Fix: unreplayable mixed now uses supported=false/substate_unreplayable/null expected hash; replayable byte drift uses supported=true/baseline_stale_build/clean expected hash. The eighth request subset is explicit, and every manifest expectation is assembled into a complete result and validated by Ajv.
```

第二轮独立复审：无 findings；fixture hash/size、8 个 request subsets、offset 30/600 ownership、offset 600 drift 后三个 feature 均为 clean、manifest/schema 逐 case 一致性与最终测试数字均已重新核对。

### Task 1.2：JavaScript synthetic ELF-like exact replay 原型

状态：完成。

变更文件：

- `exp/exact-replay/js/replay-proof.mjs`
- `exp/exact-replay/js/replay-proof.test.mjs`
- `docs/dual-implementation-progress.md`

决策与结果：

- 原型只使用 Node.js 标准库与 JS 目录内的 synthetic site 定义，不 import、subprocess 或动态加载现有 JS patch 生产实现或 Python；运行期 expected 只从 frozen clean baseline 与 manifest substate vector 重放，不读取 target fixture 作为 expected。
- 以 `source-exec`、`agent-model`、`channels` 顺序重放；channels 支持 flat clean/patched 与 decision、feature_flag、permissions、cap_strip 四 site mixed vector。site 必须完整、等长、位于 normalized binary 内且与 clean baseline 字节一致；缺 site、越界、unknown state 与 unknown nested site 均稳定返回 `substate_unreplayable`、exit 3。
- synthetic ELF-like normalization 为 identity。成功前先要求 manifest normalized size、expected size 与 current size一致，再执行完整 normalized bytes compare；SHA-256 仅用于结果报告。测试在 expected 中间 offset 511 篡改单字节，同时保持报告 hash 元数据相同，证明完整 bytes compare 是 load-bearing。
- 8 个 manifest request/closure target sets、complete mixed 均逐字节成功；unreplayable mixed 拒绝；same-version/different-build 与 feature-owned clean-byte drift 均在完整重放后返回 `baseline_stale_build`、exit 4。stdout 始终为单个 schema JSON，诊断只写 stderr。

TDD 红灯：

```text
bun test exp/exact-replay/js/replay-proof.test.mjs
0 pass, 1 fail, 1 error
SyntaxError: Export named 'SYNTHETIC_SITES' not found in module 'exp/exact-replay/js/replay-proof.mjs'.
```

窄绿灯：

```text
bun test exp/exact-replay/js/replay-proof.test.mjs
21 pass, 0 fail, 61 expect() calls

CLI schema probe over all 9 manifest cases
clean/target closures/mixed-replayable: exit 0
mixed-unreplayable: exit 3, substate_unreplayable
same-version-different-build/feature-owned-clean-drift: exit 4, baseline_stale_build

get_errors exp/exact-replay/js/replay-proof.mjs exp/exact-replay/js/replay-proof.test.mjs
No errors found
```

Task 1.1 harness 复跑：

```text
bun test test/contract/exact-replay-harness.test.mjs
3 pass, 4 fail
```

失败来自 harness 仍将 JS 与并行实施中的 Python boundary 都断言为 `not_implemented` skeleton；JS 实际已对 clean 返回 success、对两类 drift 返回 `baseline_stale_build`，Python boundary 在复跑时也已不再返回 skeleton。Task 1.2 未修改 shared harness，以免覆盖并行 Python Task；应由合并两个原型状态的后续 shared contract 更新处理。

两轮独立评审发现并修复两类 partial-vector false green：channels nested vector 的额外未知 site，以及顶层额外未知 feature 原会被静默忽略。直接探针与聚焦测试分别证明加入 `typo_key` 或 `bogus-feature` 后错误返回 exit 0；两条回归测试均先得到 `Expected: 3, Received: 0`，随后增加精确 key 集合校验并复跑全绿。评审建议的 baseline 自校验需要新的公共错误语义，留给 shared contract 后续任务，不在 Task 1.2 单边扩展 schema。

### Task 1.3：Python synthetic ELF-like exact replay 原型

状态：完成。

变更文件：

- `exp/exact-replay/python/replay_proof.py`
- `exp/exact-replay/python/test_replay_proof.py`
- `docs/dual-implementation-progress.md`

决策与结果：

- 原型只使用 Python 标准库与 Python 目录内审计固定的 replay site registry，不 import、执行或读取 JS 实现与输出，也不 import 旧 Python feature 实现。运行期 expected 仅由 manifest 指向的 frozen clean baseline 与 case substate vector 重放，不读取 target fixture 生成 expected。
- 按 `source-exec`、`agent-model`、`channels` 顺序重放；channels 支持 flat clean/patched 与 decision、feature_flag、permissions、cap_strip 四个子 site 的 mixed vector。每个 site 必须存在、等长、边界有效且匹配 clean baseline；缺 site、越界、unknown feature/state/site 与 incomplete mixed 均 fail closed 为 `substate_unreplayable`、exit 3。
- synthetic ELF-like normalization 为 identity。成功前验证 normalized size，并直接比较完整 normalized bytes；SHA-256 只写入结果报告。承重测试同时篡改 expected 中间 offset 30 并 monkeypatch hash 使 expected/current 报告 hash 相等，仍要求 `baseline_stale_build`，证明 bytes compare 不会被 hash equality 短路。
- manifest 的 8 个 request/closure target sets、clean、全部唯一 target 与 replayable mixed 均逐字节成功；unreplayable mixed 拒绝；same-version/different-build 与 feature-owned clean-byte drift 均在完整重放后返回 `baseline_stale_build`、exit 4。CLI stdout 只含单行 schema JSON，失败诊断只写 stderr。

TDD 红灯：

```text
uv run --with pytest pytest -q exp/exact-replay/python
25 failed
Expected failure: not_implemented skeleton lacked replay_substates/SITE_SPECS/evaluate_case, success cases still exited 3, and rejection cases still reported not_implemented.
```

首次实现与测试修正：

```text
uv run --with pytest pytest -q exp/exact-replay/python
23 passed, 1 failed
Failure was a test-construction error: target-all channels is a flat state, so the unknown nested-state probe was moved to mixed-replayable's channels substate map.

uv run --with pytest pytest -q exp/exact-replay/python
24 passed in 0.60s
```

独立评审红灯与修复：

```text
REVIEW RED: replay_substates rejected unknown values and nested sites but silently ignored an extra top-level feature key.

uv run --with pytest pytest -q exp/exact-replay/python/test_replay_proof.py::test_rejects_unknown_feature
1 failed: DID NOT RAISE SubstateUnreplayable

Fix: validate the exact top-level feature set before replay.
```

最终窄绿灯：

```text
uv run --with pytest pytest -q exp/exact-replay/python
25 passed in 0.68s

get_errors exp/exact-replay/python/replay_proof.py exp/exact-replay/python/test_replay_proof.py
No errors found
```

Task 1.1 稳定合同复跑：

```text
bun test test/contract/schema.test.mjs
22 pass, 0 fail, 125 expect() calls

bun test test/contract/exact-replay-harness.test.mjs --test-name-pattern 'pins synthetic facts|every manifest expectation|accepts explicit'
3 pass, 4 filtered out, 0 fail, 61 expect() calls
```

shared harness 的其余四条仍是 Task 1.1 时代的双 skeleton 断言，与已成熟的 JS/Python boundary 冲突；Task 1.3 未修改 shared harness，避免越过 Python 专属修改边界。后续 shared contract 合并任务应同时更新两个 boundary 的 maturity 与 case expectations。

### Task 1.4：ELF 双原型交叉证明与临时副本 oracle

状态：synthetic 双原型合同完成；真实 Bun SFX runtime gate 为 `not-proven`，ELF 写路径保持 disabled。

变更文件：

- `test/contract/exact-replay-harness.test.mjs`
- `test/contract/exact-replay-elf.test.mjs`
- `exp/exact-replay/js/replay-proof.mjs`
- `exp/exact-replay/js/replay-proof.test.mjs`
- `exp/exact-replay/python/replay_proof.py`
- `exp/exact-replay/python/test_replay_proof.py`
- `exp/exact-replay/README.md`
- `docs/dual-implementation-progress.md`

决策与结果：

- shared harness 将两个 boundary 从 `explicit-skeleton` 升为 `mature-poc`，逐一启动 JS/Python CLI 覆盖全部 9 个 manifest case。除 `implementation` 外，双方完整比较 format、supported、normalized size、byte equality、error、baseline lineage hash、expected hash、current hash，并要求 exit code 一致；每份结果独立通过 frozen schema。
- 两个 PoC 各自实现仅实验使用的可选 `--write-expected PATH`。成功时各自从 frozen clean baseline 与 substate vector 独立重放并写出完整 expected bytes，写前核对结果 hash；失败时不创建文件；stdout 仍只有一行 JSON，未扩展 shared schema、golden 或 vectors。
- 每个成功 case 都执行 JS 产出 bytes 后由 Python 验证，以及 Python 产出 bytes 后由 JS 验证。harness 用 `Buffer.equals` 将输出 bytes 与 pinned current fixture 显式逐字节比较，并在另一实现验证后再次确认文件 bytes 未变；不是 hash-only 或同实现 roundtrip。
- runtime oracle 使用测试临时目录构建真实 Linux Bun SFX，命令为 `bun build --compile --bytecode`。源码含可审计表达式 `6 * 7` 与行为输出 `unbun-bytecode-oracle value=42`；两个副本均等长改为 `6 * 8`，其中一个保留所有 `@bytecode`，另一个将全部 marker 等长翻为 `@source__`，随后实际执行原件与两个副本。
- Bun 1.3.14 的真实输出是 original=`42`、edited-bytecode=`48`、edited-source=`48`。也就是说，仅改源码且仍保留 3 个 `@bytecode` marker 时行为已经改变，无法构造“旧 bytecode 仍承重、翻 marker 后 source 才承重”的所需对照。测试将当前 gate 冻结为 `not-proven` 并保留这一 runtime counterexample；没有用 marker 数量代替运行时行为。生成的 original fixture 前后 SHA-256 相等，所有编辑只发生在测试临时副本，不读取或修改 live binary。

TDD 红灯：

```text
bun test test/contract/exact-replay-harness.test.mjs
3 pass, 4 fail, 78 expect() calls
Cause: Task 1.1 harness still expected both mature PoCs to return not_implemented.

After upgrading the shared case contract:
6 pass, 1 fail, 147 expect() calls
Cause: JavaScript producer did not create the requested --write-expected file.
```

窄绿灯：

```text
bun test exp/exact-replay/js/replay-proof.test.mjs
24 pass, 0 fail, 71 expect() calls

uv run --with pytest pytest -q exp/exact-replay/python
27 passed in 0.70s

bun test test/contract/exact-replay-harness.test.mjs
7 pass, 0 fail, 264 expect() calls

bun test test/contract/exact-replay-elf.test.mjs
1 pass, 0 fail, 10 expect() calls
Runtime evidence status: not-proven
```

独立合并态评审：无 blocker、无 major。评审指出并已修复三项 minor：shared mutation helper 不再硬编码 clean，而是读取每个 case 的 `base_fixture`；JS 在 replay 前与 Python 对称地校验 frozen baseline size/SHA-256；JS 的 hash-equality 负样本升级为通过 `evaluateCase` 完整 pipeline 注入 replay/hash seam，先复现错误 exit 0，再修复为完整 bytes mismatch 的 exit 4。两个实现文件也补齐 POSIX 尾部换行；Python 局部变量重命名建议不影响行为，本 Task 不做无关改名。

### Task 1.5：PE 双原型 fixture 与 gate

状态：完成；PE contract gate 为 `enabled`，未修改或发布生产 patch 写路径。

变更文件：

- `exp/exact-replay/fixtures/pe/generate-fixtures.mjs`
- `exp/exact-replay/fixtures/pe/manifest.json`
- `exp/exact-replay/fixtures/pe/platform-gate.json`
- `exp/exact-replay/fixtures/pe/pe-2.1.175-*.exe`
- `exp/exact-replay/js/replay-proof.mjs`
- `exp/exact-replay/js/replay-proof.test.mjs`
- `exp/exact-replay/python/replay_proof.py`
- `exp/exact-replay/python/test_replay_proof.py`
- `test/contract/exact-replay-pe.test.mjs`
- `docs/dual-implementation-progress.md`

Fixture 与实现结论：

- 生成器构造固定、不可执行、结构有效的 x86_64 PE32+ fixture。512-byte DOS/COFF/optional/section header 后是唯一 `.payload` section；section raw size 按 512-byte file alignment 固定为 1536 bytes，其中前 1031 bytes 原样承载 Task 1.1 已审计 synthetic replay vector，余下 bytes 固定为零。完整文件固定为 2048 bytes，PE v1 normalization 返回原 bytes，header、payload 与 padding 全部参与比较。
- provenance 固定生成命令 `bun exp/exact-replay/fixtures/pe/generate-fixtures.mjs`、来源、audit basis、repository-generated license 与日期。生成器复跑前后对 manifest、gate 和全部 fixture 的聚合 SHA-256 均为 `cf9075313a63ce57f1420092f1707752ccd2f7b82c2ec40c1619fa4b0327cc53`。
- clean=`3699499cc545246d218f8b2fbb5cfa64eb35b3a7ba99d6fdb991454ed7a364b4`；target-source-exec=`49fd66e2f0a7cd53da661fffe152cfcdcd4d301353a2c9b6bf6134078578a032`；target-agent-model=`9ec34de1bf67f562298fc1c8fb611ad06f474fd0c46362fd3e02e1818fa4436c`；target-source-exec-agent-model=`47047926024253dd2adc805a28bb02910827f097255f4d4de0275163e6ddb64a`；target-channels=`8a353e858e9a949e70033418e68cfc3a25cd940b03483292ccdbcbc130e950d3`；target-all=`c0f64020cae38ccfa704a24ae8f12d4e0a74d7f05d68b325dc044201320037e9`；mixed-replayable=`01e99165539688e11c52c928fde5f94575c78165576029da955652f06d52702a`；mixed-unreplayable=`7d09e9f2488ced1a732e73d323a36851ae4452455d5fe2480a5543a06fc8fa07`。
- JS 与 Python 各自实现 PE parser、identity normalizer、payload-offset site dispatch 与 expected materialization；两边不 import、执行或调用对方。双方都先验证 DOS `MZ`、`e_lfanew`、`PE\0\0`、x86_64 COFF machine、非零 section count、PE32+ optional-header size/magic、file alignment、header/section table 边界和 raw section 边界，再允许 replay。
- contract 负样本覆盖错误 DOS magic、错误 PE magic、截断 header 与 PE32/PE32+ 矛盾 optional-header magic，双方均以 exit 3、`unsupported_format` fail closed，并在 stderr 留下具体 PE parser 证据。same-version/different-build 保留 embedded version `2.1.175`，在非 feature-owned payload byte 注入 drift，双方完成 replay 后以 exit 4、`baseline_stale_build` 拒绝。
- 全部 10 个 synthetic replay cases 被映射为 PE corpus：clean、agent-only、显式 source-plus-agent、其他 target/全部 target 与 replayable mixed 成功；unreplayable mixed 拒绝；same-version/different-build 与 feature-owned clean drift 完整比较失败。cross harness 比较双方除 implementation 外的完整 JSON 结论；每个成功 case 都执行 JS 写完整 expected bytes/Python 验证和 Python 写完整 expected bytes/JS 验证，并用逐字节 equality 对照 pinned current fixture。
- `platform-gate.json` 固定 `platform=windows`、`writes=enabled`、`skipped=false`，并列出全部 required cases、4 类 header negative、两种 implementation 与 `full_byte_cross_verification=true`。该 gate 只冻结 Phase 1 PE PoC 证据；本 Task 没有修改 `lib/patch-*.mjs` 或任何生产写路径。

TDD 红灯：

```text
bun test test/contract/exact-replay-pe.test.mjs
0 pass, 6 fail
Cause: PE manifest and platform gate did not exist.

After adding deterministic fixtures:
2 pass, 4 fail, 56 expect() calls
Cause: both PoCs still returned unsupported format for valid PE.

bun test exp/exact-replay/js/replay-proof.test.mjs --test-name-pattern PE
0 pass, 1 fail, 1 error
Cause: normalizePe export did not exist.

uv run --with pytest pytest -q exp/exact-replay/python -k pe
11 passed, 6 failed
Cause: normalize_pe/UnsupportedFormat did not exist and PE CLI still exited 3.
```

窄绿灯与回归：

```text
bun test exp/exact-replay/js/replay-proof.test.mjs --test-name-pattern PE
6 pass, 0 fail, 9 expect() calls

uv run --with pytest pytest -q exp/exact-replay/python -k pe
17 passed, 16 deselected

bun test test/contract/exact-replay-pe.test.mjs
6 pass, 0 fail, 197 expect() calls

bun test exp/exact-replay/js/replay-proof.test.mjs test/contract/exact-replay-harness.test.mjs test/contract/exact-replay-pe.test.mjs
43 pass, 0 fail, 541 expect() calls

uv run --with pytest pytest -q exp/exact-replay/python
33 passed in 0.79s

get_errors Task 1.5 JS, Python, generator, and tests
No errors found
```

### Task 1.6：Mach-O 签名 normalization 双原型与 gate

状态：parser、合成 signature normalization 与双方 fail-closed corpus 完成；真实 codesign equivalence 为 `not-proven`，macOS 写 gate 保持 `disabled`。未修改或发布生产 patch 写路径。

变更文件：

- `exp/exact-replay/fixtures/macho/*`
- `exp/exact-replay/js/macho-normalizer.mjs`
- `exp/exact-replay/js/macho-normalizer.test.mjs`
- `exp/exact-replay/python/macho_normalizer.py`
- `exp/exact-replay/python/test_macho_normalizer.py`
- `test/contract/exact-replay-macho.test.mjs`
- `docs/dual-implementation-progress.md`

Fixture 与实现结论：

- Linux 有 Bun 1.3.14 cross compile，无 `codesign`。固定源 `console.log("unbun-macho-fixture-v1")` 生成 69173328-byte thin x86_64 Mach-O；真实 header 为 `MH_MAGIC_64`、`ncmds=23`、`sizeofcmds=2632`，唯一 `LC_CODE_SIGNATURE dataoff=68617792,datasize=555536`，`LC_SEGMENT_64 __LINKEDIT fileoff=68415488,filesize=757840,vmsize=770048`。`source-header.bin` 固定其完整 2664-byte header/load-command 区，SHA-256 为 `2abf3ca7eaa43f4557d10d61fa77ea0b73856212328f9b1e635325ed192dae2e`。
- 生成器从真实 header 的 magic、CPU、filetype 与 flags 构造两个 LLVM 可独立解析的最小 thin Mach-O。`synthetic-original-layout.macho` 为 224 bytes、signature `dataoff=192,datasize=32`、`__LINKEDIT filesize/vmsize=96`、SHA-256 `751788d24b8d45841fc34cadbbc9c78eaf78f9254b67707baac7bd8df228f313`；`synthetic-adhoc-layout.macho` 为 272 bytes、signature `dataoff=192,datasize=80`、`__LINKEDIT filesize/vmsize=144`、SHA-256 `01285b434268bea9d3f35a8ae3bb4174e3da16383e5a0307a64f463f1dc85df2`。两者 `sizeofcmds=88`；名称、manifest 与 `signature_evidence=synthetic-not-codesign-equivalent` 明确不声称它们经过真实 codesign。
- JS 与 Python 各自使用标准库独立解析，不 import、执行或读取对方实现。双方支持 thin 32/64-bit、little/big-endian header，严格遍历 `ncmds/sizeofcmds`，要求唯一 `LC_CODE_SIGNATURE` 与唯一 `__LINKEDIT`，验证 signature blob 完整位于 `__LINKEDIT`、两者均以 EOF 结束且不与 load commands 重叠。
- normalization 删除 EOF signature blob，将 `dataoff/datasize` 归零，并把 `__LINKEDIT filesize/vmsize` 归一化为去签名后的真实长度。两个进程边界对两份 fixture 产生逐字节相同的完整 normalized stream，SHA-256 均为 `f392b1be9fe5ec51c0d193e3a939732f0454cd15c5e08ec2cfcb40fa70df357b`；成功结论不是 hash-only，contract 直接比较 stdout bytes。
- 双方负样本覆盖多个冲突 signature command、越界 blob、blob 与 load-command 区重叠、截断 command、FAT container、缺 signature、signature 不在 EOF，以及 big-endian 越界 blob。指定 contract 负样本均返回 exit `3`、空 stdout 和明确 Mach-O stderr，fail closed。
- generator 对 Bun source layout 漂移硬拒绝；二次复跑固定产物聚合 SHA-256 前后均为 `54fad8c631fcded36f0768cfab1b17df2e703bfc624ac12860ab4a4b9a74d52b`。`llvm-objdump --macho --private-headers` 独立接受两份固定 fixture，并观测到上述 `datasize`、`filesize/vmsize` 与总长差异。
- 本机无法执行真实 `codesign --remove-signature` 与 `codesign -s -` 对照，因此合成结构只证明 parser 与共同 normalization vector，不冒充真实 original-signed/ad-hoc-resigned 等价证明。`platform-gate.json` 固定 `writes=disabled`、`conclusion=not-proven`、`reason=real-codesign-equivalence-unavailable`、`real_adhoc_equivalence=false` 与 `skipped=false`。

TDD 红灯：

```text
bun test exp/exact-replay/js/macho-normalizer.test.mjs
0 pass, 1 fail, 1 error
Cause: Cannot find module './macho-normalizer.mjs'.

uv run --with pytest pytest -q exp/exact-replay/python/test_macho_normalizer.py
Collection error
Cause: ModuleNotFoundError: No module named 'macho_normalizer'.
```

窄绿灯与验收：

```text
bun test exp/exact-replay/js/macho-normalizer.test.mjs test/contract/exact-replay-macho.test.mjs
17 pass, 0 fail, 68 expect() calls

bun test test/contract/exact-replay-macho.test.mjs
4 pass, 0 fail, 51 expect() calls

uv run --with pytest pytest -q exp/exact-replay/python -k macho
13 passed, 33 deselected in 0.04s

get_errors Task 1.6 JS, Python, generator, and tests
No errors found
```

Phase 1 exact-replay 累计回归：

```text
bun test exp/exact-replay/js test/contract/exact-replay-harness.test.mjs test/contract/exact-replay-elf.test.mjs test/contract/exact-replay-pe.test.mjs test/contract/exact-replay-macho.test.mjs
61 pass, 0 fail, 619 expect() calls

uv run --with pytest pytest -q exp/exact-replay/python
46 passed in 0.75s
```

独立评审：无 blocker、无 major。两个 minor 已修复：合成单测 `__LINKEDIT vmsize` 改为 segment 实际长度；JS/Python 各增加 big-endian 越界 signature fail-closed 覆盖。保留的已知边界是 32-bit 只有合成单测，以及真实 ad-hoc codesign equivalence 必须留待 macOS 环境证明。

### Pre-implementation correction：移除 `agent-model -> source-exec`

状态：完成；未修改生产 patch 实现、公开入口或 live binary，未创建 commit。

裁决依据：

- `docs/source-exec-runtime-findings.md` 与 `exp/agent-model-runtime` 的决定性 PoC 使用 clean Claude Code 2.1.214 临时副本和独立 localhost mock。agent-model-only 副本保留 5 个 `@bytecode` marker，Agent schema 已变为 unrestricted string，并真实发出 `model=gpt-5.5` 的子请求；agent-model + source-exec 副本行为相同。
- 因此 `agent-model` 无依赖；`channels -> source-exec` 保持不变，`source-exec` 仍为独立 feature。
- 字节/依赖语义改变通常要求新 contract 名称，但当前 `claude-v1` 只是尚未提交、发布或被生产实现消费的 Phase 0 资产。本次明确记录为 pre-implementation correction 并保留名称，避免虚增版本。

严格 TDD 红灯：

```text
仅修改 dependency-expected.json 中 agent-model request closure：
Expected: ["agent-model"]
Received: ["source-exec", "agent-model"]

bun test test/interop/cli-harness.test.mjs
8 pass, 1 fail, 36 expect() calls
Cause: JS 与 Python runner 的旧固定依赖图都仍为 agent-model 添加 source-exec。
```

迁移与人工字节审计：

- `dependency-input.json`、JS/Python runner 与 lineage expected 使用新图；agent-model 启用时移除 source-exec 现在允许并返回 exit 0，channels 启用时仍以 `feature_dependency_conflict` 拒绝。
- `exp/exact-replay/fixtures/migrate-agent-model-dependency.mjs` 只读取 immutable clean golden，使用审计固定 site，不 import 或执行任何生产 patch 实现。clean golden 前后 SHA-256 都是 `0a067e12954675a56d6a2aa25c4180c1746005d5cd9e438607d0fb913355ff61`。
- synthetic agent-only 为 1031 bytes、SHA-256 `7006d69a6050bcb9847f27263e41ed11afabab6ea034e4553df592b421016715`；相对 clean 仅 model site 的 `307-322` 与 `324-345` 不同，bytes `8-16` 仍为 `@bytecode`，model bytes `305-345` 为 patched string schema。
- synthetic source-plus-agent 为 1031 bytes、SHA-256 `4689ec9329f8e6e9f719e8eaef1b0647b76a0000a189af595140ae3812a655fe`；除 model site 外仅 marker 的 `9-12` 与 `14-16` 不同。该 SHA 与旧 target-agent-model 相同，证明旧 fixture 实际编码的是错误闭包后的 source-plus-agent 目标。
- PE agent-only SHA-256 为 `9ec34de1bf67f562298fc1c8fb611ad06f474fd0c46362fd3e02e1818fa4436c`；PE source-plus-agent 为 `47047926024253dd2adc805a28bb02910827f097255f4d4de0275163e6ddb64a`；PE target-all 保持 `c0f64020cae38ccfa704a24ae8f12d4e0a74d7f05d68b325dc044201320037e9`。PE manifest、gate 与全部 fixtures 的重冻结聚合 inventory SHA-256 为 `9bd4278cfd2ff84efee8a8b250da3ee387fc7008b38f164baa31f966ac25c465`。
- synthetic manifest 与 6 个派生 fixture 的聚合 inventory SHA-256 为 `e7c99a503b6d28ce9212127a95ddc4efb9e8f26f680a95f4bb6ac04278bbbc49`。
- known-bad `agent-without-source-exec` 已删除，因为它把被证伪的历史假设当作缺陷；替代的 `incorrect-agent-source-dependency` 独立闭合冻结旧图，证明 agent-only 请求会被错误扩成 source-plus-agent。

绿灯证据：

```text
bun test test/interop/cli-harness.test.mjs
9 pass, 0 fail, 39 expect() calls

bun test test/contract/vector-integrity.test.mjs
6 pass, 0 fail, 421 expect() calls

bun test test/contract/exact-replay-harness.test.mjs
7 pass, 0 fail, 300 expect() calls

bun test test/contract/exact-replay-pe.test.mjs
6 pass, 0 fail, 221 expect() calls

bun test exp/exact-replay/js/replay-proof.test.mjs
30 pass, 0 fail, 80 expect() calls

uv run --with pytest pytest -q exp/exact-replay/python
47 passed in 0.87s

bun test test/contract/schema.test.mjs test/contract/vector-integrity.test.mjs test/interop/cli-harness.test.mjs
37 pass, 0 fail, 585 expect() calls

bun test exp/exact-replay/js test/contract/exact-replay-harness.test.mjs test/contract/exact-replay-elf.test.mjs test/contract/exact-replay-pe.test.mjs test/contract/exact-replay-macho.test.mjs
61 pass, 0 fail, 679 expect() calls

RUN_CLAUDE_RUNTIME_PROBE=1 uv run --with pytest pytest -q exp/agent-model-runtime
2 passed in 17.37s

bun test
208 pass, 0 fail, 34385 expect() calls, 33 files
```

### Task 1.7：冻结 lineage algorithm 与平台写能力矩阵

状态：完成；未修改生产 patch、spec dependency graph 或 live binary，未创建 commit。

变更文件：

- `contract/vectors/platform-writes-v1.json`
- `docs/exact-replay-poc-findings.md`
- `test/contract/platform-gates.test.mjs`
- `docs/dual-implementation-progress.md`

合同与 gate 结论：

- 固定 `lineage_algorithm=claude-v1-exact-replay`。平台记录必须分别包含 `format_exact_replay`、`shared_store_transaction`、`runtime_execution_oracle`、`source_exec_dependency_evidence` 与 `production_write_gate`；顶层和 capability map 均禁止汇总 `writes` 字段。
- 聚合规则 fail closed：只有 format replay、shared-store production transaction、runtime oracle、source-exec dependency evidence 和 production implementation 全部达到放行状态时，production gate 才能为 `enabled`。测试构造 PE replay 已通过但 runtime/store/implementation 不完整的假阳性，结果必须为 `disabled-incomplete-evidence`。
- Linux synthetic ELF-like 双原型 full-byte cross proof 为 `proven`；普通 Bun source-exec necessity 为 `not-proven`；独立 agent-model Claude 临时副本 oracle 为 `proven`，`agent-model -> source-exec` 为 `refuted`，`channels -> source-exec` 仍为 `not-proven`。production gate 为 `disabled-not-implemented`。
- Windows PE structure/replay gate 为 `enabled/proven`，但真实 Windows runtime 未验证，shared-store transaction 与 production write 均未实现。Task 1.5 fixture gate 中旧 `writes=enabled` 只表示 PE 结构/replay 证据，不能汇总成 production write；权威 production gate 为 `disabled-pending-runtime`。
- macOS parser 与 synthetic signature normalization 为 `proven`，真实 codesign equivalence 为 `not-proven`，production gate 为 `disabled-not-proven`。
- shared store format、schema、vectors 与 failure corpus 已冻结，但 production transaction 尚未实现，因此三个平台的 `shared_store_transaction` 均为 `contract-only`。
- live Claude Code 2.1.217 继续固定为 `read-only`：三个 feature 均为 patched，clean baseline absent，禁止从 patched target 猜造 baseline，production gate 为 `disabled-no-baseline`。
- findings 记录两个原型的独立进程边界、fixture provenance、ELF/PE/Mach-O normalization、runtime 与 dependency evidence、negative corpus、平台 gate、测试墙钟时间和残余边界。当前没有独立 throughput/RSS benchmark，测试耗时没有被冒充为生产性能结论。
- patch、revert、snapshot restore production write path 尚不存在；Task 1.7 只冻结机器合同并阻止越级启用，不创建 baseline、temp 或 lock，也不以 Linux 主机为由 skip PE/Mach-O fixture tests。
- 独立评审无 blocker/major。已落实的 minor：五个 production prerequisite 各自有独立阻断反例及全满足正样本；findings 区分 Mach-O contract 级 4 类 negative 与双方 unit 扩展 negative；Windows/macOS 的 Linux 来源 dependency evidence 明确只有本平台 runtime oracle 后才能升级。旧 PE fixture gate 保持 Task 1.5 原始产物，本 Task 只在权威矩阵与 findings 中消歧其 format-only scope。

严格 TDD 红灯：

```text
bun test test/contract/platform-gates.test.mjs
0 pass, 5 fail
Cause: contract/vectors/platform-writes-v1.json did not exist; every test failed with ENOENT.
```

聚焦绿灯：

```text
bun test test/contract/platform-gates.test.mjs
6 pass, 0 fail, 39 expect() calls, 1.39s
Live 2.1.217 SHA-256 before/after remained equal; exact legacy baseline path was absent.
```

Phase 1 累计回归与独立 runtime probe：

```text
bun test exp/exact-replay/js test/contract/exact-replay-harness.test.mjs test/contract/exact-replay-elf.test.mjs test/contract/exact-replay-pe.test.mjs test/contract/exact-replay-macho.test.mjs test/contract/platform-gates.test.mjs test/contract/agent-model-runtime.test.mjs
68 pass, 0 fail, 722 expect() calls, 8 files, 9.64s

uv run --with pytest pytest -q exp/exact-replay/python
47 passed in 0.81s

RUN_CLAUDE_RUNTIME_PROBE=1 uv run --with pytest pytest -q exp/agent-model-runtime/test_runtime_probe.py
2 passed in 17.70s
```

## Phase 2

状态：进行中。

### Task 2.1：原样迁入 Python 包并建立迁移基线

状态：完成；未修改 store、migrate、features 或其他生产行为，未删除旧源，未修改 JavaScript 文件，未创建 commit。

变更文件：

- `python/cc-patch/pyproject.toml`
- `python/cc-patch/uv.lock`
- `python/cc-patch/README.md`
- `python/cc-patch/SOURCE_BASELINE.sha256`
- `python/cc-patch/src/cc_patch/**`
- `python/cc-patch/tests/**`
- `docs/dual-implementation-progress.md`

迁移基线与结果：

- 复制前旧源全套为 `276 passed in 25.87s`。复制范围共 46 个文件，完整逐文件 SHA-256 保存于 `SOURCE_BASELINE.sha256`；hash 清单自身 SHA-256 为 `34a246ec638c568349869e8bd7c24bc256dbb543a63bf5a9a14557d52a9c8960`。
- 机械复制 `pyproject.toml`、`uv.lock`、README、`src/cc_patch/` 与 `tests/` 后，目标 46 文件的清单、逐文件 SHA-256 和清单聚合 hash 与旧源完全相同。纯复制目标原有套件为 `276 passed in 27.12s`。
- `.venv/`、`.pytest_cache/`、`__pycache__/` 与 `backups/` 均未复制。`uv sync` 在目标创建 ignored `.venv/`，不属于迁移源码。
- 目标 `src/cc_patch/**`、原有 276 tests 与 `uv.lock` 在 Task 完成后仍与旧源逐字节相同。README 只更新仓库内入口和“双实现独立、共享 contract”说明；`pyproject.toml` 新增 `ccpatch = "cc_patch.cli:main_entry"` 并保留 `cc-patch` alias。
- `test_package_boundary.py` 使用 Python AST 扫描生产源码，拒绝静态或动态 `lib.patch` import、`../../lib/patch`、`cli.mjs`、JS runner 路径，以及通过 `subprocess`、`asyncio` 或 `os` process API（含 module alias 与函数 alias）调用 Bun/Node/JS 核心；普通参数列表形式的 `codesign`、`uname` 等平台命令允许通过。
- 最后一次重算旧源 46 项逐文件 hash 与复制前快照无差异，聚合 hash 仍为 `34a246ec638c568349869e8bd7c24bc256dbb543a63bf5a9a14557d52a9c8960`。

严格 TDD 证据：

```text
uv run --with pytest pytest -q python/cc-patch/tests/test_package_boundary.py
RED: 1 failed, 8 passed
Cause: target pyproject.toml did not yet exist; the public ccpatch entry contract failed before migration.

uv run --directory python/cc-patch pytest -q tests/test_package_boundary.py
GREEN: 15 passed in 0.15s
```

验收：

```text
uv sync --directory python/cc-patch
Success; 19 packages resolved and target .venv created.

uv run --directory python/cc-patch pytest -q --ignore=tests/test_package_boundary.py
276 passed in 27.12s

uv run --directory python/cc-patch pytest -q
291 passed in 25.45s

uv run --directory python/cc-patch ccpatch --help
exit 0

uv run --directory python/cc-patch cc-patch --help
exit 0

get_errors python/cc-patch
No errors found
```

### Task 2.2：Python feature protocol 补齐 substates 与固定 window contract

状态：完成；直接消费 `contract/vectors/feature-claude-v1` 与 `contract/golden/claude-v1`，未修改 store、migrate、orchestrate、CLI、TUI 或 JavaScript 生产代码，未创建 commit。

变更文件：

- `python/cc-patch/src/cc_patch/models.py`
- `python/cc-patch/src/cc_patch/probe.py`
- `python/cc-patch/src/cc_patch/features/__init__.py`
- `python/cc-patch/src/cc_patch/features/source_exec.py`
- `python/cc-patch/src/cc_patch/features/agent_model.py`
- `python/cc-patch/src/cc_patch/features/channels.py`
- `python/cc-patch/tests/test_feature_vectors.py`
- 受修订依赖图或结构化 substate 字段影响的既有 feature、probe、CLI、orchestrate、report、TUI 与 live smoke tests
- `docs/dual-implementation-progress.md`

协议与结果：

- 新增 `FeatureSubstate(identity, offset, length, state, detail_code, essential)` 与 `ProbeSlice(offset, data)`；`Feature` 提供 `observe_substates`、`replay_substates`，不可逆 feature 不再被协议错误地要求实现 `reverse`。`FeatureStatus` 保留旧公开四态与 details/sites，并携带内部稳定 substates 与 detail codes。
- 权威依赖图固定为 `source-exec requires []`、`agent-model requires []`、`channels requires [source-exec]`。旧 tests 中把 agent-model 自动扩成 source-exec 的 oracle 已同步；agent-only apply、snapshot 与 TUI 不再伪造该依赖。
- `source-exec` 合并首尾各 32,000,000 bytes 的 discovery ranges，对全部有效 tag 建半径 8,000 bytes 小窗；owned site 固定为含前导分隔空格的 10 bytes，offset 与 frozen vector 一致。32MB 边界 candidate 无法证明完整时由 probe 回退 full detect；人工第二 tag 与 frozen 首尾、多边界、重叠窗口用例均证明全部 sites 被保留。
- `agent-model` 从尾向前收集全部 describe suffix，按 receiver-independent audited exact core 接受 E/S/A/Q，等长替换只覆盖 core 并保留 receiver。未知 enum 返回 `unsupported`、sites `0` 与 `agent_model_variant_unsupported`；人工第三 suffix 证明不是只取最后一个 site。
- `channels` 遍历全部 register、feature flag、permissions 与 capability-strip anchors，只把可解析为合法 decision body 的 register 计为站点，因此全部尾部 decoy 被跳过。decision 与 feature flag 固定 essential；permissions 与 capability-strip 固定 best-effort，optional absent 显式进入 substate vector，essential 缺失返回 `channels_essential_site_missing`。
- 三个 feature 的 replay 均按 substate identity/offset/length/state 从 clean bytes 精确重建 clean、patched 或 mixed 目标；channels replay 不再退化为 apply-all，不允许从 patched decision body 逆向恢复 clean。full 与 windowed 的完整 `FeatureStatus`，包括 state、sites、substates 与 detail codes，在 frozen vectors 和 historical golden 上一致。

严格 TDD 证据：

```text
uv run --directory python/cc-patch pytest -q tests/test_feature_vectors.py tests/test_features_registry.py tests/test_source_exec.py tests/test_agent_model.py tests/test_channels.py tests/test_probe.py
RED: collection error
Cause: FeatureSubstate 尚不存在，证明新 vector tests 在实现前生效。

uv run --directory python/cc-patch pytest -q tests/test_feature_vectors.py -k 'state_vectors_and_replay or multiple_suffixes_and_manual or replay_substates_rebuilds'
RED: 1 failed, 2 passed
Cause: channels replay_substates 仍是 apply-all，无法从 clean 精确重建只 patch cap-strip 的 mixed vector。

uv run --directory python/cc-patch pytest -q tests/test_feature_vectors.py -k 'state_vectors_and_replay or multiple_suffixes_and_manual or replay_substates_rebuilds'
GREEN: 3 passed, 9 deselected in 0.03s
```

验收：

```text
uv run --directory python/cc-patch pytest -q tests/test_feature_vectors.py tests/test_features_registry.py tests/test_source_exec.py tests/test_agent_model.py tests/test_channels.py tests/test_probe.py tests/test_models.py
67 passed in 1.12s

uv run --directory python/cc-patch pytest -q
346 passed in 34.14s

uv run --directory python/cc-patch pytest -q tests/test_live_smoke.py
2 passed in 6.92s

get_errors Task 2.2 Python production/tests
No errors found
```

完整套件与 live smoke 均在独立 user systemd transient unit 中运行，stdout/stderr 写入 journal，避免共享终端被并行 Phase 3 的 `Ctrl-C` 接管。live smoke 仅 mmap/read-only probe 与 owned range 不重叠检查，未写 binary、baseline、snapshot 或 backup。

独立评审：第一轮结论为 0 blocker、0 major。两项 Task 内 minor 已采纳：把 `reverse` 从基础 `Feature` 拆到 `ReversibleFeature`，以及在 channels 全 anchor 扫描前先确认 register 存在；另补 best-effort mixed 状态断言。评审指出 CLI 的旧 dependency 提示硬编码仍列 `agent-model / channels`，但用户明确禁止本 Task 修改 CLI 生产代码，因此本 Task 不越界修入，留给后续 CLI 重构。第一轮所见 6 个全套失败经 journal 逐项确认均为修订依赖图与新增内部字段引起的旧 test oracle，已仅修改 tests 后复跑至 346 pass。

### Task 2.3：Python shared store v1 parser、identity 与 lock

状态：完成；独立 reviewer 复核 PASS。未接 `orchestrate`，未删除或 import `migrate`，未修改 features、CLI、TUI、JavaScript 或 contract 资产，未创建 commit。全 Python 套件存在 6 个并行 Task 2.2 的外部失败，已独立隔离并记录，不归因于或越界修入 Task 2.3。

变更文件：

- `python/cc-patch/src/cc_patch/store.py`
- `python/cc-patch/src/cc_patch/locking.py`
- `python/cc-patch/src/cc_patch/lineage.py`
- `python/cc-patch/tests/test_store_contract.py`
- `python/cc-patch/tests/test_locking.py`
- `python/cc-patch/tests/test_lineage.py`
- `docs/dual-implementation-progress.md`

实现结果：

- store root 按 `UNBUN_CC_STORE`、XDG/HOME/macOS Application Support、Windows LOCALAPPDATA 顺序解析；override 必须是平台原生绝对路径，并拒绝未展开 `~`、`$VAR` 与 `%VAR%`。
- canonical path 独立消费全部 9 个 frozen cases：POSIX absolute/symlink/NFC，Windows extended prefix、separator、ASCII-only lowercase 与非 ASCII 保留；`path_key` 始终是 canonical UTF-8 bytes 的完整 64 位 lowercase SHA-256。
- `target.json` 使用 hard-link no-clobber publish，存在时重新验证 schema、path key 和 canonical path；baseline/snapshot 使用 content-addressed blob，正式 manifest 是唯一激活点。
- manifest parser 实现 UTF-8 no-BOM、object root、schema/version/type/pattern、受约束相对 blob path、feature states 与未知 optional field 兼容；消费时重新校验 hash、size、目录 identity，并通过 fixture inspector seam 校验内容 version 和 clean baseline states。
- baseline 发布按 blob temp flush/fsync/readback、blob no-clobber、manifest temp flush/fsync/readback、manifest no-clobber、directory fsync、正式资产回读顺序执行；故障注入证明 blob-only、manifest-temp-only、temp-only、manifest-only 和 orphan blob 均不 active。
- snapshot slot 支持普通 no-clobber 与 `force` 原子 manifest replace；选择规则覆盖 current-version 优先与跨版本 ambiguity。quarantine 把资产移出 active namespace并记录受约束原路径、reason、hash、时间和实现。
- POSIX durability adapter 执行 file/directory fsync；Windows adapter 明确暴露 `file-flush-and-atomic-rename-no-directory-fsync` 边界，不伪造 directory fsync。
- cooperative lock 使用原子 `mkdir(write.lock)`；owner token 必须匹配才能释放。缺失或损坏 owner 仍视为有效锁，不自动抢占；cleanup 仅在显式 force 下删除空目录或唯一 `owner.json`，拒绝递归删除未知内容。
- lineage 模块读取 frozen platform capability map，拒绝未知平台和 `writes` 汇总捷径；exact replay proof 通过 fixture adapter 注入 `observe_substates`/`replay_substates`，验证 baseline lineage hash、平台 normalization、size 与完整 bytes，相同 path/version 不同 build 和不可完整 replay mixed 均报 `baseline_stale_build`。本 Task 不调用 JavaScript，也未直接接入仍并行实施的正式 feature protocol。

严格 TDD 证据：

```text
uv run --directory python/cc-patch pytest -q tests/test_store_contract.py tests/test_locking.py tests/test_lineage.py
RED: collection failed with 3 ModuleNotFoundError errors for cc_patch.store, cc_patch.locking and cc_patch.lineage.

uv run --directory python/cc-patch pytest -q tests/test_store_contract.py tests/test_locking.py tests/test_lineage.py
GREEN: 43 passed in 1.18s

get_errors store.py locking.py lineage.py and corresponding tests
No errors found
```

独立评审与完整回归：

```text
reviewer round 1
PASS with 2 minor findings: Windows file fsync reopened O_RDONLY; lock frozen expected values were not directly bound to runtime assertions.

reviewer round 2 after fixes
PASS; both minors closed, snapshot slug validation introduced no regression.

independent verifier narrow suite
43 passed in 0.67s; exit 0

independent verifier full Python suite
340 passed, 6 failed in 42.72s; exit 1
```

完整套件的 6 个失败均位于本 Task 禁止修改的并行 Task 2.2/legacy 集成表面：`test_orchestrate.py` 4 项仍期待旧 `agent-model -> source-exec` closure/幂等行为，`test_report.py` 1 项期待 tuple 经 JSON round-trip 后仍为 tuple，`test_tui.py` 1 项仍期待旧 dependency degraded 提示位置。Task 2.3 三个 production 模块未被这些失败 import 或出现在 traceback 中；待 Task 2.2 同步 orchestrate/report/TUI tests 后应重跑完整套件。

### Task 2.4：删除 Python legacy migrate 路径并接入 exact replay baseline

状态：完成；未修改旧 `/home/xp/.claude/scripts/cc-patch` 源、CLI/TUI/JavaScript 生产代码或 contract 资产，未创建 commit。

变更文件：

- `python/cc-patch/src/cc_patch/orchestrate.py`
- `python/cc-patch/src/cc_patch/store.py`
- `python/cc-patch/tests/test_orchestrate.py`
- `python/cc-patch/tests/test_store_contract.py`
- `python/cc-patch/tests/test_cli.py`
- 删除迁入副本 `python/cc-patch/src/cc_patch/migrate.py`
- 删除迁入副本 `python/cc-patch/tests/test_migrate.py`
- `docs/dual-implementation-progress.md`

实现结果：

- `orchestrate.write_features` 不再 import/call `migrate`，也不再搜索、读取或迁移旧 `.ccbak`、`.agentbak`、`.channels.bak`。旧 migrate 专属测试的纯发现/不发布/invalid 不激活保障已迁入 shared store activation、content validation、crash residue 和 legacy-name ignore 合同，未以删除测试方式丢失覆盖。
- baseline 写路径现由 `StoreV1`、`DirectoryLock` 与 `prove_exact_replay` 承担。target identity 和 `write.lock` 按 canonical path key 建立；持锁后、写任何 target/baseline 资产前再次核对 entry bytes；baseline manifest 激活并正式回读、验证完成后才允许 atomic binary write。
- shared store 始终注入真实 Python feature inspector；每次消费都重新校验 manifest schema/path/version、blob hash/size、embedded version、实际 all-clean states、lineage hash，并以三个正式 feature 的完整 `observe_substates`/`replay_substates` 执行 full-byte exact replay proof。same path/version different build 返回 `baseline_stale_build`。
- 无 baseline 决策固定为：all-clean current 直接建立；仅 reversible patched 时按反向拓扑 reverse，并使用入站正式 substates 正向 replay，要求完整 bytes 等于 current；`channels=patched` 返回 `channels_patched_no_baseline`；mixed/unsupported 无 baseline 返回 `unsupported_or_mixed_no_baseline`。有 baseline 的 replayable mixed 必须先通过 exact replay proof，随后才从 clean baseline 自愈到请求 target；不能证明则拒绝。
- 新 baseline 在 binary 交换失败前已经 active，证明 baseline-before-binary；若发布后发现 binary 并发变化，只把本次新建的 activation manifest 移入 quarantine，保留 content-addressed blob 为非 active orphan。若锁后首次复核已发现变化，则不写 target/baseline 资产。已有 baseline 不因普通并发被自动删除或覆盖。
- `StoreV1.utc_now()` 作为 manifest timestamp 的公开小接口，避免 orchestrate 复制 store 的时间编码格式。`SOURCE_BASELINE.sha256` 保持 Task 2.1 的 46 文件迁移前历史快照，不改写为当前文件清单；其中已删除迁入副本的条目仍用于证明旧源未动。

严格 TDD 证据：

```text
uv run --directory python/cc-patch pytest -q tests/test_store_contract.py tests/test_orchestrate.py -k 'baseline or legacy or lineage'
RED: 17 setup errors
Cause: orchestrate 尚无 shared STORE 接口，证明 legacy-ignore/shared-store tests 在生产接线前生效。

uv run --directory python/cc-patch pytest -q tests/test_orchestrate.py -k 'legacy_backups or clean_current_publishes or channels_patched_without or baseline_is_published_before'
GREEN: 6 passed, 33 deselected

uv run --directory python/cc-patch pytest -q tests/test_orchestrate.py -k concurrent_binary_change_before_commit
RED: active baseline.json remained after a post-publication concurrent binary change.

uv run --directory python/cc-patch pytest -q tests/test_orchestrate.py -k 'binary_change_before_locked or binary_change_after_baseline'
GREEN: 2 passed, 38 deselected; pre-store drift writes no baseline, post-publication drift quarantines the activation manifest.
```

验收：

```text
uv run --directory python/cc-patch pytest -q tests/test_store_contract.py tests/test_orchestrate.py -k 'baseline or legacy or lineage'
24 passed, 49 deselected in 0.98s; detached unit result=success

uv run --directory python/cc-patch pytest -q tests/test_store_contract.py tests/test_locking.py tests/test_lineage.py tests/test_orchestrate.py tests/test_cli.py
129 passed in 2.60s; detached unit result=success

uv run --directory python/cc-patch pytest -q tests/test_store_contract.py tests/test_locking.py tests/test_lineage.py tests/test_orchestrate.py
86 passed in 2.61s

detached user systemd transient unit: uv run pytest -q
349 passed in 35.94s; unit result=success

sha256sum --check python/cc-patch/SOURCE_BASELINE.sha256 from /home/xp/.claude/scripts/cc-patch
46/46 entries OK, including old migrate.py/test_migrate.py; old source unchanged.

get_errors python/cc-patch
No errors found
```

独立评审：第一轮结论为 0 blocker、0 major、2 minor。两项均已采纳并以测试闭环：reversible feature 带 clean dependency 时，round-trip replay 现在只对入站实际 patched features 执行，不再对未观察的 clean dependency 索引 substate；新增测试先复现 `KeyError` 后转绿。CLI 测试 helper 统一使用 `resolve_closure`，避免未来构造依赖不完整的 fixture。另采纳精确 `FeatureSubstate` tuple 类型标注；已有 baseline 的二次 proof 保持不变，它用于 store 操作后、binary write 前重新证明 entry lineage。第二轮复审结论为 PASS，0 blocker、0 major、0 minor；两项第一轮问题均确认关闭，修复未引入新问题。

### Task 2.5：Python transaction、snapshot、codesign 与回滚按 v1 重构

状态：完成；未修改 CLI/TUI/JavaScript 生产代码、contract vectors 或 live binary，未创建 commit。

变更文件：

- `python/cc-patch/src/cc_patch/orchestrate.py`
- `python/cc-patch/src/cc_patch/transaction.py`
- `python/cc-patch/src/cc_patch/atomicio.py`
- `python/cc-patch/src/cc_patch/store.py`
- `python/cc-patch/tests/conftest.py`
- `python/cc-patch/tests/test_atomicio.py`
- `python/cc-patch/tests/test_transaction.py`
- `python/cc-patch/tests/test_orchestrate.py`
- `python/cc-patch/tests/test_cli.py`
- `docs/dual-implementation-progress.md`

`snapshots.py`、`codesign.py` 与 `models.py` 的 shared-store v1 结构已满足本 Task 合同，本轮通过新增故障注入、跨实现 manifest 和全套回归确认，无需为制造 diff 做空重构。

实现结果：

- feature write 在 canonical target 的 cooperative `DirectoryLock` 内重新读取 entry bytes并校验可选 SHA-256 digest；lock 覆盖 baseline resolve/publish、binary temp/replace、binary-in-use quarantine。snapshot save/rm/restore 同样持 target lock，list 保持只读无锁。
- dependency contract 固定为 agent-model 可独立启用，channels 依赖 source-exec；移除 source-exec 而保留 channels 时在 version probe、baseline 与 temp write 前拒绝。最终目标集合始终从 clean baseline 按稳定 closure 顺序重放，不做就地逆向。
- 既有或新建 baseline 均正式回读并执行完整 exact replay proof。新 baseline 在任何 binary temp 前发布；发布失败不准备、不 replace binary；发布后并发变化将本次 activation manifest 移入 quarantine。
- 内存结果在 baseline publish 前验证 feature states、embedded version 与 entry/baseline 等长。`edits` 现在按 entry→result 的 feature substate 变化精确计数，与共同 `transaction-v1.json` 的静态 `expected_edits` 一致。
- idempotent result 在再次读取 entry 后返回 `edits=0`，不创建 temp、不 replace、不 codesign。binary result temp 使用同目录 `.<name>.tmp.<uuid-v4>`，以 exclusive create 写入、flush/file fsync、继承 entry mode并逐字节回读。
- replace 前再次读取 entry并重做 exact replay proof；随后使用 `os.replace`。Linux/Windows 写后逐字节比对 result；`EACCES`、`EPERM` 与 `EBUSY` 映射为 `binary_in_use`，verified ready temp 移入 v1 quarantine。
- quarantine manifest 发布失败时先尽力将 artifact 回迁到 store staging，再回迁到 binary 同目录原 ready temp；回迁失败不覆盖原始发布异常，也不删除剩余诊断资产。
- macOS baseline manifest 与 transaction 的 pre/post-codesign lineage proof 统一通过可注入 `MACOS_NORMALIZE` 计算 normalized SHA-256。codesign 后重新验证 version、三个 feature states、normalized lineage 与 executable；signature drift 不要求 full-byte 相等。
- 任一 replace 后 readback、feature/version/lineage 或 codesign 失败均从 transaction entry bytes 原子恢复并回读。rollback 失败稳定返回 `rollback_failed`/exit `2` 并保留 entry diagnostic quarantine；恢复来源不是 baseline。
- snapshot v1 save/list/rm/force/restore 继续使用 shared manifest 激活和 content-addressed blob；restore current-version 优先，同 slug 跨版本 ambiguity fail closed，跨版本按 embedded version 告警并要求显式确认，随后复用同一 transaction/codesign/rollback 路径。
- `NoBaselineRejected` 保留 `.reason` 供既有 CLI/TUI 文案，同时携带 frozen catalog 的稳定 `.code/.exit_code`。内部 round-trip failure 映射为合法 `unsupported_or_mixed_no_baseline`/1，invalid baseline 映射为 `baseline_invalid`/2。
- Python 测试直接读取语言中立 `contract/vectors/transaction-v1.json`，不 import、执行或生成 JavaScript。全 suite autouse fixture 将 `UNBUN_CC_STORE` 指向每例 `tmp_path/shared-store` 并重置模块 store cache；所有写目标均为 `tmp_path`。

严格 TDD 证据：

```text
temp naming / stable concurrent code RED
4 failed, 4 passed: non-UUID temp，no-write/发布后 drift 抛内部异常且 activation manifest 未 quarantine。
GREEN: 8 passed in 0.44s。

in-memory version/length RED
2 failed, 1 passed: corrupted result 到 baseline readback 才失败，证明步骤 6 后验缺失。
GREEN: 3 passed in 0.12s。

quarantine publish failure RED
1 failed: ready temp 被移动为无 manifest quarantine artifact，原路径丢失。
GREEN: failure rollback + normal binary-in-use + ordinary quarantine，3 passed in 0.19s。

Windows errno RED
EBUSY 原样泄漏为 OSError；EACCES/EPERM 已映射。
GREEN: EACCES/EPERM/EBUSY + macOS feature-drift rollback，4 passed in 0.23s。

review RED
UUID parse failure；revert-channels vector edits 实际 1、预期 5；macOS baseline normalized lineage hash mismatch。
GREEN: UUID、4 frozen scenarios、binary-in-use cleanup、macOS normalized lineage，7 passed in 0.47s。
```

验收：

```text
uv run --directory python/cc-patch pytest -q tests/test_atomicio.py tests/test_transaction.py tests/test_orchestrate.py tests/test_snapshots.py tests/test_codesign.py tests/test_models.py tests/test_store_contract.py tests/test_lineage.py tests/test_locking.py
168 passed in 4.28s

uv run --directory python/cc-patch pytest -q
379 passed in 35.02s

get_errors python/cc-patch
No errors found
```

独立评审：第一轮结论为可进入下一阶段，0 blocker、0 major、4 minor。精确 `expected_edits`、UUID-v4 temp 与旧 temp residual glob 已采纳并通过 RED→GREEN 闭环。macOS `lineage_sha256` 经 shared-store §6.2.1 与 JS Task 3.6 `lineageSha256(...normalizers)` 独立核验后，确认不是未来注释项而是当前互操作缺口，已统一接入 normalization seam并增加 pre/post-codesign proof 测试。`NoBaselineRejected` 稳定 code 建议也已采纳，但按 frozen `error-codes-v1.json` 映射，而非把内部 reason 名直接泄漏为协议 code。未采纳提取重复 `_states` 的 nit，因为两个模块拥有不同 transaction/snapshot 边界，当前两行重复不足以引入新公共抽象；共同 vector 扩容属于 contract 变更且用户要求读取既有 Task 3.6 vectors，本 Task 未反向修改 vector。残余风险是无真实 macOS codesign 与 Windows runtime CI，本轮只通过注入 adapter 和平台 errno/bytes oracle 验证，不能据此升级 frozen platform production gate。

### Task 2.6：Python CLI、JSON、profile 与 store/lock 诊断完成

状态：完成；未重构既有 Textual TUI，保留裸 TTY 入口；未操作 live binary，未创建 commit。

变更文件：

- `python/cc-patch/src/cc_patch/cli.py`
- `python/cc-patch/src/cc_patch/report.py`
- `python/cc-patch/src/cc_patch/models.py`
- `python/cc-patch/src/cc_patch/interactive.py`
- `python/cc-patch/src/cc_patch/probe.py`
- `python/cc-patch/tests/test_cli.py`
- `python/cc-patch/tests/test_cli_contract.py`
- `python/cc-patch/tests/test_report.py`
- `python/cc-patch/tests/test_models.py`
- `python/cc-patch/pyproject.toml`
- `python/cc-patch/uv.lock`
- `python/cc-patch/README.md`
- `contract/schemas/status.schema.json`
- `test/contract/schema.test.mjs`
- `docs/dual-implementation-progress.md`

实现结果：

- 所有 CLI 行为测试均通过安装后的公开 `ccpatch` 子进程或真 PTY 驱动，不 import/call `cli.main`，不 monkeypatch CLI 内部。每例设置临时 `UNBUN_CC_STORE`，fixture 位于 `tmp_path`；未对自动发现的 live binary 执行 patch、revert 或 snapshot。
- 裸 TTY 进入既有 Textual TUI；裸 non-TTY 和显式 `--check` 直接走只读 status，不先实例化 TUI；显式 patch、revert、snapshot 在 non-TTY 正常执行。status、profile 与 snapshot list 不取 write lock，store 不存在时不因 status/profile 被创建。
- status JSON 使用 byte 精度 `size_bytes`，只暴露共同 schema 公共字段；无法提取版本时 `version:null`，共同 schema 与 Python/Ajv 正例均覆盖。write JSON 使用 `schema_version/success/exit_code/action/results/errors` envelope，stdout 保持纯 JSON，进度与诊断写 stderr。
- `ERROR_EXIT_CODES` 逐项绑定 frozen `error-codes-v1.json` 的 19 个 code/exit；`CliError` 拒绝 catalog 外 code；多 binary 取最严重 exit 并保留每台结果或结构化错误。
- 公开 status 的 baseline lookup、feature patch/revert、snapshot save/list/rm/restore、store root 与 lock inspect/cleanup 均接入 shared `StoreV1`、transaction、snapshot 和 cooperative lock。snapshot list 使用 mmap 提取 version，保持无锁只读；save/rm/restore 持 target lock。
- 新增 `ccpatch store root`、`ccpatch lock inspect [--json]` 与 `ccpatch lock cleanup --force`。未知或损坏 owner 仍视为有效 lock；无 `--force` 拒绝清理；未知 lock 内容由既有 locking 层 fail closed。
- dependency 提示已按权威图修正：`agent-model` 无 source 依赖，只有启用的 `channels` 会阻止移除 `source-exec`。README 同步删除旧 short pathhash/project backups 叙述，改为完整 SHA-256 target identity 与 shared store v1。
- `--profile` 报告 `implementation=python`、version、三个 feature status 与总耗时，保持 mmap/小窗只读路径。

严格 TDD 证据：

```text
uv run --directory python/cc-patch pytest -q tests/test_cli_contract.py
RED: 4 failed；status/write 缺 schema_version，store/lock 子命令不存在。
GREEN: 4 passed；随后扩展公开命令、snapshot、bare TTY/non-TTY 与 batch severity 覆盖。

uv run --directory python/cc-patch pytest -q tests/test_models.py
RED: collection ImportError；ERROR_EXIT_CODES 尚不存在。
GREEN: 6 passed；19 项 code/exit 与 frozen vector 完全一致。

uv run --directory python/cc-patch pytest -q tests/test_cli.py -k 'probe_failure or unknown_option_and_feature or snapshot_commands'
RED: 2 failed, 1 passed；version:null 不过 status schema，snapshot rm missing 泄漏 traceback。
GREEN: 3 passed；schema 明确允许 null，snapshot StoreError 统一捕获并稳定诊断。
```

验收：

```text
uv run --directory python/cc-patch pytest -q tests/test_cli.py tests/test_cli_contract.py tests/test_report.py tests/test_models.py
34 passed in 7.83s

bun test test/contract/schema.test.mjs
26 passed, 0 failed, 135 expect() calls in 217 ms；包含 null-version 正例。

independent verifier: uv run --directory python/cc-patch pytest -q
362 passed in 41.98s；exit 0。

get_errors Task 2.6 Python/schema files
No errors found
```

独立评审第一轮：0 blocker、4 个可修实现 major、1 个 frozen contract major gap。已采纳并闭环：snapshot `StoreError` 不再泄漏 traceback；generic feature `ValueError/KeyError` 不再冒充 `codesign_failed`；status probe failure 的 null version 进入共同 schema；snapshot list 改 mmap；补公开 `revert --check`、missing snapshot 与 probe-failure schema 测试。测试重复项保留为 CLI 行为与 contract 专项两层，二者都只走公开进程边界。

第二轮复审：0 blocker、0 major、1 minor。唯一 minor 是未来 atomicio 原生 `SnapshotNotFound`/`AmbiguousSnapshot` 若直接进入统一 translator 会落入 generic 分支；已补显式 `snapshot_not_found`/`snapshot_ambiguous` 映射并关闭。复审结论为可进入下一 Task。

残余 frozen contract 缺口：19-code catalog 没有 `dependency_conflict`、`target_access_failed` 与 `feature_action_failed`。本 Task 不擅自扩成第 20-22 个 code；依赖拒绝暂用 exit 1 的 `unsupported_or_mixed_no_baseline` 并在 `details.category=dependency_conflict` 携带真实 dependency/dependants，目标访问失败暂用 exit 1 的 `baseline_not_found` 并在 details 标注实际类别和异常类型，generic feature action 为保持规格 severity 3 暂用 `codesign_failed` 并标记 `details.category=feature_action_failed`。catalog 外的内部 `StoreError` 统一收敛为 `content_mismatch` 并保留原 internal code，避免二次 `KeyError` 或 traceback。后续 contract 版本应新增专用 code，再由双实现共同迁移。

### Task 2.7：Python Textual TUI 迁到新 transaction 并保留完整功能

状态：完成；只修改 Python TUI、TUI tests 与本 progress，未修改 CLI、JavaScript、contract 或 live binary/store，未创建 commit。

变更文件：

- `python/cc-patch/src/cc_patch/tui/app.py`
- `python/cc-patch/tests/test_tui.py`
- `python/cc-patch/tests/test_tui_render.py`
- `docs/dual-implementation-progress.md`

实现与测试结果：

- TUI baseline badge 从 legacy `atomicio.find_baseline` 迁到 transaction 使用的 shared `StoreV1` identity/path-key 与 active baseline；生产写入继续通过 `orchestrate.write_features(binary, target_features, current_data=...)` 的目标集合公共合同，在 worker 中执行 shared lock、baseline replay、transaction commit 与写后只读 reprobe。
- 依赖图按冻结合同修正 TUI oracle：`agent-model` 可独立启用，`channels` 自动闭包到 `source-exec`；移除 source 时只有 channels 产生 dependency guard。mixed feature 被勾选时显示 `replay mixed`，取消勾选时显示 `revert[feature](mixed)`，不再出现 `1 pending` 却无 action preview。
- shared `StoreError` 的 message 与稳定 exit severity 直接进入 TUI，不再误报为 generic feature failure/exit 3；未知异常仍显式映射 severity 3。
- Pilot 保留并覆盖 path/feature filter、隐藏选择、`space`、可见项 `a`、unsupported disabled、mixed replay、执行中防双提交、进度、完成后 reprobe 并停留、再次提交和 non-TTY 规则。新增真实临时 shared transaction：clean -> patch -> badge `PATCHED` -> full revert -> badge `CLEAN`，以及两 source sites 的 mixed -> exact replay -> patched；不再只由 fake write seam 自证 transaction 生命周期。
- PTY + pyte 使用生产 `CcPatchApp`、临时 binary/store 和真实终端，在 80/100/120 宽度验证状态、计划、分组、footer 与确定性。真实 transaction 抓屏确认操作后 `[x] source-exec PATCHED` 和完成进度；退出后 termios 与初始值完全相等，并观察到 show-cursor 与 alternate-screen exit 序列。
- Python-only known-bad positive control 通过 `CC_PATCH_BAD_LAYOUT=1` 把 warning/progress/summary 恢复为相互重叠的 `dock: bottom`，同一 screen harness 必须抛 `AssertionError`。实现前还临时恢复过该已知坏 CSS：同一 PTY test 红于 `saw_ready`，屏幕显示 footer 空白；恢复 Vertical layout 后绿，证明 harness 能抓到覆盖/丢行而不是 false green。

严格 TDD 证据：

```text
known-bad footer positive control
RED: 1 failed, 9 deselected in 10.60s
Cause: warning/progress/summary 同时 dock:bottom，screen grid 中 footer 消失，harness 在 saw_ready 失败。
GREEN after restoring Vertical footer: 1 passed, 9 deselected in 0.86s。

shared transaction baseline/badge
RED: 1 failed, 27 deselected in 0.68s
Cause: transaction 已 patch 且 reprobe 为 PATCHED，但 TUI 仍查询 legacy atomicio baseline，has_baseline=False。
GREEN after shared StoreV1 lookup: 1 passed, 27 deselected in 0.81s。

shared StoreError
RED: 1 failed, 2 passed, 27 deselected in 1.51s
Cause: target_locked 被 generic feature failure 显示并错误抬高为 exit 3。
GREEN after StoreError mapping: 3 passed, 27 deselected in 1.43s。

mixed-to-clean preview
RED: 1 failed, 32 deselected in 0.58s
Cause: 目标集合会把未选 mixed replay 为 clean，但 group header 无 action badge。
GREEN with known-bad/generic severity checks: 3 passed, 42 deselected in 2.29s。
```

验收：

```text
uv run --directory python/cc-patch pytest -q tests/test_tui.py tests/test_tui_render.py
45 passed in 28.71s；exit 0。

uv run --directory python/cc-patch pytest -q
370 passed in 51.10s；exit 0。

get_errors app.py/test_tui.py/test_tui_render.py
No errors found。
```

两条最终 pytest 均由独立 user transient service 执行，避开共享终端中并行 JS PTY 命令与 `Ctrl-C`；先前被接管的输出全部作废，未冒充验收。独立 verifier 比较测试前后 9 个自动发现 live binaries 的 device/inode/mode/owner/size/mtime/ctime，全部不变；默认 live store 前后均不存在；TUI 写测试只使用 `tmp_path` 与临时 `UNBUN_CC_STORE`。完整 Python suite 暴露既有 `test_atomicio.py` 未隔离 legacy `BACKUP_DIR`，本轮新增的唯一 5-byte ignored backup 已精确清理，未触碰其余历史 backup；该非 TUI 测试隔离缺口不越界修改。

独立 reviewer 第一轮为 0 blocker、1 major、2 minor：缺少可持续 known-bad positive control、取消 mixed 时无 action preview、generic severity 3 无测试；三项均采纳并完成 RED -> GREEN。另指出成功 transaction 的终端退出恢复应独立验证，已有真实 PTY transaction 覆盖。第二轮 merged-state 复审为 PASS，0 blocker、0 major、0 minor；残余风险仅为极慢 CI 上 PTY deadline 与未来新增 StoreError 子类需正确设置 exit severity。

## Phase 3

状态：进行中。

### Task 3.1：跨平台 raw reader 与 ELF parser 分层

状态：完成；未修改 feature、store、CLI、Python、contract vectors 或 live binary，未创建 commit。

变更文件：

- `lib/patch/io/raw-reader.mjs`
- `lib/bun-binary.mjs`
- `test/patch/raw-reader.test.mjs`
- `docs/dual-implementation-progress.md`

决策与结果：

- `openFileReader(path)` 只建立跨平台 raw reader，不读取或验证 ELF metadata；合成 ELF、PE、Mach-O 与 arbitrary raw 均可打开。mmap 获取失败统一回落到一个 fd 的 positional pread，短读显式失败。
- mmap 与 pread reader 共享 `size`、`slice`、`u8/u16/u32/u64`、`toString`、`lastIndexOf` 与 `close` 行为；range 参数必须是 safe integer，负值、越界、`NaN`、Infinity 与小数在两个后端一致拒绝。多窗口按 caller 顺序读取并拼接可逐字节还原原始输入。
- `readElfBinary(path)` 在 raw reader 上解析 ELF64 section metadata；解析失败先关闭 reader 再传播错误。`readBinary` 保留为兼容 alias，`bufferReader` 从原模块兼容 re-export，因此 extract、module-graph、layout、assets 与一次访问契约不需改调用点。
- 新 JavaScript production patch tree `lib/patch/**` 有 Acorn AST import boundary 测试，禁止 import `lib/bun-binary.mjs`，未来 probe 只能依赖 raw reader。第一代 `lib/patch-binary.mjs` 按计划留待 Task 3.10 退役，本 Task 未改该 feature 路径。
- 并行边界：Phase 2、Task 3.2、`python/`、`lib/patch/core/`、feature/store/CLI、contract 与 package/lockfile 的已有或并行变化均不属于 Task 3.1；本小节没有覆盖或回退它们。

严格 TDD 证据：

```text
bun test test/patch/raw-reader.test.mjs
RED 1: 0 pass, 1 fail, 1 error
Cause: Cannot find module '../../lib/patch/io/raw-reader.mjs'.

bun test test/patch/raw-reader.test.mjs
RED 2 after independent review: 8 pass, 2 fail
Cause: mmap silently accepted fractional slice offsets while pread delegated them to Node's different ERR_OUT_OF_RANGE behavior.

bun test test/patch/raw-reader.test.mjs
GREEN after range fix: 10 pass, 0 fail, 66 expect() calls

bun test test/patch/raw-reader.test.mjs
FINAL GREEN after import-boundary adversarial case: 11 pass, 0 fail, 67 expect() calls
```

聚焦与下游回归：

```text
bun test test/patch/raw-reader.test.mjs test/bun-binary.test.mjs test/mmap-reader.test.mjs test/read-once.test.mjs
27 pass, 0 fail, 106 expect() calls, 4 files

bun test test/extract.test.mjs test/module-graph.test.mjs test/layout.test.mjs test/double-magic.test.mjs test/loader-aware-headsniff.test.mjs test/cli-assets.test.mjs test/cli-assets-collision.test.mjs
16 pass, 0 fail, 187 expect() calls, 7 files

get_errors lib/patch/io/raw-reader.mjs lib/bun-binary.mjs test/patch/raw-reader.test.mjs
No errors found
```

完整回归与独立验收：

```text
bun test
242 pass, 0 fail, 34515 expect() calls, 36 files
```

主会话的两次完整测试曾被共享终端上的并行 Phase 2 `Ctrl-C`/命令接管，均明确作废且未冒充测试失败或成功。独立 verifier 在隔离 process group 重跑最终树得到上述完整绿灯，并以 2000 次 forced-pread 非 ELF 解析失败探针确认 fd 数保持不变。独立 reviewer/verifier 发现并促成 safe-integer range 一致性修复和 production import boundary 测试；boundary 递归覆盖 static import、re-export 与 dynamic import，并用合成违规源码证明扫描器能失败。关于 mmap `slice` 返回零拷贝只读 view 的建议未采纳，因为既有 reader 合同与大文件性能依赖该语义，调用方不得原地修改读取窗口。

### Task 3.2：JS feature registry、依赖闭包与 substate protocol

状态：完成；未实现具体 feature，未修改旧 JavaScript patch、raw reader、Python、contract 或 live binary，未创建 commit。

变更文件：

- `lib/patch/core/feature.mjs`
- `lib/patch/core/registry.mjs`
- `lib/patch/core/dependencies.mjs`
- `test/patch/feature-contract.test.mjs`
- `docs/dual-implementation-progress.md`

决策与结果：

- `Feature` 在构造时验证 `detect`、`probe_windows`、`detect_windows`、`observe_substates`、`replay_substates` 与 `apply`；`reversible=true` 必须提供 `reverse`，不可逆 feature 不得提供 `reverse`。
- `FeatureRegistry` 保留声明顺序，拒绝非 `Feature`、重复名称、未知依赖与 dependency cycle，并按 registry 顺序稳定打破拓扑并列。
- dependency closure 去重且返回确定性 registry-topological 顺序；unknown request fail closed。移除检查不做隐式级联：仍有启用 feature 的传递闭包依赖目标时返回 `feature_dependency_conflict`、exit `1`，否则允许并返回 exit `0`。
- 测试直接读取 frozen `dependency-input.json` 与 `dependency-expected.json` 作为 oracle，不运行 expected 生成器。`claude-v1` 顺序固定为 `source-exec`、`agent-model`、`channels`，requires 分别为 `[]`、`[]`、`[source-exec]`；agent-model 启用时允许移除 source-exec，channels 启用时拒绝。

严格 TDD 证据：

```text
bun test test/patch/feature-contract.test.mjs
RED: 0 pass, 1 fail, 1 error
Cause: Cannot find module '../../lib/patch/core/feature.mjs'.

bun test test/patch/feature-contract.test.mjs
GREEN: 17 pass, 0 fail, 23 expect() calls

get_errors lib/patch/core/{feature,registry,dependencies}.mjs test/patch/feature-contract.test.mjs
No errors found
```

独立评审：第一轮无 blocker；建议增加 duplicate requires 与“dependent 先注册”拓扑覆盖，已采纳并复跑至 17 pass，未维护的 `pendingDependencies` Map 已删除。第一轮把“移除未启用 feature 返回 allowed”列为 major，经 frozen oracle、error catalog 与 Task 2.5/3.6 idempotent no-write 合同复核后不采纳：本 helper 只判定移除是否破坏剩余目标集合的依赖闭包，action 是否为 no-op 属于 transaction 层，不能在 core 中私造 `feature_not_enabled` code。第二轮独立复核确认该裁决与修改事实正确，结论为 consensus/pass，无 blocker、无 major。

完整 `bun test` 尚未记为验收证据：共享终端被并行 Phase 2/Task 3.1 命令占用，两次尝试均收到对方命令输出，不能冒充本 Task 的可靠执行结果。

### Task 3.3：JS 三 feature 独立重建

状态：完成；只注册到新 core registry，未修改 CLI、旧 JavaScript production patch 路径、Python、contract/golden/vectors 或 live binary，未创建 commit。

变更文件：

- `lib/patch/targets/claude/source-exec.mjs`
- `lib/patch/targets/claude/agent-model.mjs`
- `lib/patch/targets/claude/channels.mjs`
- `lib/patch/targets/claude/variants.mjs`
- `lib/patch/targets/claude/index.mjs`
- `test/patch/source-exec.test.mjs`
- `test/patch/agent-model.test.mjs`
- `test/patch/channels.test.mjs`
- `docs/dual-implementation-progress.md`

决策与结果：

- 新 `claudeFeatureRegistry` 按 `source-exec`、`agent-model`、`channels` 顺序注册，依赖图固定为 `source-exec=[]`、`agent-model=[]`、`channels=[source-exec]`。所有 feature 只改各自 owned sites；channels 不再私自改 Bun source marker。
- 三 feature 都实现 `detect`、`probe_windows`、`detect_windows`、`observe_substates`、`replay_substates` 与 `apply`；仅 reversible 的 source-exec 和 agent-model 实现 `reverse`。变换默认复制输入，显式 `{ mutate: true }` 才原地修改，所有替换保持等长。
- source-exec 覆盖全部 `// @bun @bytecode`/`@source__` sites，支持 clean/patched/mixed/unsupported、32,000,000-byte 首尾 discovery windows 与绝对候选偏移；apply/reverse 和 mixed replay 均逐 site 精确操作。
- agent-model 只接受冻结 audited E/S/A/Q receiver 与精确 enum/describe suffix，替换保留 receiver 并以 block comment 等长填充；全部 suffix 均被定位。未知 enum 或 audited suffix 前任意未识别 core drift 稳定返回 `agent_model_variant_unsupported`，pinned mixed-unreplayable fail closed 为 `substate_unreplayable`。
- channels 定位真实 decision body 并跳过全部尾部 register decoys；decision 与 feature flag 为 essential，permissions 与 cap-strip 为 best-effort。重复 owned sites 全部应用；optional 缺失允许；essential 缺失返回 `channels_essential_site_missing`；完整 mixed substate 可从 clean baseline 精确 replay，patched decision 请求 clean 因 feature 不可逆而 fail closed。
- substate records 使用稳定 `id`、`offset`、`length`、`state`，agent 另含 `receiver`。replay 严格校验完整站点集合、identity、offset、length、合法状态和 receiver；不完整、漂移、unknown state 或不可逆请求均抛 `substate_unreplayable`。
- 测试运行期只读取 frozen JSON、known-bad fixture、clean golden 与 pinned target fixtures；不 import Python、不执行 `ccpatch`，也不调用旧 `lib/patch-*.mjs` 生成 expected。manifest 的 8 个 target sets 均从 clean golden 经新 registry dependency closure/apply 后与 pinned fixture 逐字节相等。

严格 TDD 证据：

```text
bun test test/patch/source-exec.test.mjs test/patch/agent-model.test.mjs test/patch/channels.test.mjs test/patch/feature-contract.test.mjs
RED 1: 17 pass, 3 fail, 3 module errors
Cause: three new target modules did not exist.

Same focused command after first implementation
RED 2: 31 pass, 3 fail
Cause: source window candidate offsets were one byte off the frozen oracle; single audited agent detect omitted replacement_prefix.

Enhanced focused command after pinned mixed-unreplayable positive control
RED 3: 35 pass, 1 fail
Cause: arbitrary audited agent core drift such as Q.xnum was generic unsupported instead of agent_model_variant_unsupported.

Final focused command after fixes and independent-review tests
GREEN: 36 pass, 0 fail, 124 expect() calls, 4 files
```

权威资产、边界与完整回归：

```text
bun test test/contract/vector-integrity.test.mjs
6 pass, 0 fail, 422 expect() calls

sha256sum --check contract/golden/SHA256SUMS
2 OK

Boundary scan over new target tree and tests
0 Python/ccpatch/legacy lib/patch-*.mjs references

get_errors on 5 implementation and 3 test files
No errors found

bun test --timeout 120000
261 pass, 0 fail, 34616 expect() calls, 39 files
```

主会话完整测试和单文件诊断多次被共享终端中的并行 Python 命令与 `Ctrl-C` 接管，均明确作废。独立 verifier 使用隔离 transient systemd service/cgroup 重跑最终树取得上述完整绿灯；此前隔离默认 timeout 运行的 2 个真实 binary 测试超时，在资源恢复后的完整 suite 中 `cli-extract` 仅用 3.769s 通过，证实是固定 30s 阈值叠加异常主机负载，而非 Task 3.3 确定性回归。

独立 reviewer 第一轮结论为 0 blocker、0 major，提出 receiver mismatch 与不可逆 channels decision 两个防御分支缺少直接测试，均已补齐；同时 channels replay 改为复用一次 locate，避免真实大 binary 上重复全文扫描。第二轮 reviewer 误读 Python 实现后声称 channels JS guard 仍未覆盖；经直接读取 JS 测试并单独执行该 test，确认它构造 patched decision 后请求 clean 并以 1 pass、0 fail 命中 guard，因此该声称不采纳。最终无未关闭 blocker、major 或 minor。

### Task 3.4：JS windowed probe 与 performance contract

状态：完成；未修改 store、transaction、CLI、Python、旧 JavaScript patch 路径、contract assets 或 live binary，未创建 commit。真实 2.1.217 仅执行只读 mmap probe，未写 store/live。

变更文件：

- `lib/patch/targets/claude/probe.mjs`
- `lib/patch/targets/claude/channels.mjs`
- `test/patch/probe.test.mjs`
- `docs/dual-implementation-progress.md`

决策与结果：

- `probeClaudeBinary(path, options)` 通过可注入 `openReader` 对同一 binary 只打开一次，并在 `finally` 中恰好关闭一次；默认复用 `openFileReader`，不依赖 ELF parser。返回一次 probe 所需的 `version`、`size`、`timing` 与 `features`，其中 timing 包含 version、features、total 和逐 feature 毫秒数，可直接供后续 `--profile` 消费。
- 编排器先收集三个 feature 的 discovery ranges，按绝对 offset 排序并全局合并重叠/相邻范围，再一次读取每个合并范围。250MB 正常路径只读取 source 的首尾 32,000,000-byte discovery ranges 与 agent/channels 的尾部 64MiB range；重叠后不会为每 feature 重复 open 或重复读相同范围。
- discovery slices 只用于提取候选；所有 owned substates 转为绝对 offset 后建立半径 8,000-byte candidate ranges，再合并并以零拷贝 subarray 交给 `detect_windows`。大 binary 测试证明 source 的 `detect_windows` 每窗不超过 16,018 bytes，distant channels 的多个候选相隔 7MB 时仍只解码不超过 80KB，不解码中间跨度。
- candidate range 未完整落在 discovery cache 中、source candidate 跨 32MB discovery 边界、窗口无候选、`detect_windows` 返回 null 或 windowed unsupported 时均 fail closed 到 full detect；多个 feature fallback 共享同一份惰性 full buffer，不会每 feature 整读。unsupported/mixed 的 `state`、逻辑 `sites`、`detail_codes` 与完整 `substates` 均按 full detect 结果保留。
- `normalizeSubstates` 将各 candidate window 的 local offset 转为 absolute offset，按 kind 全局稳定重编号，避免多窗 ordinal id 冲突。channels `detect_windows` 改为聚合多 candidate windows，以 kind/absolute offset/length 去重，保留 full detect 的 decision `sites` 语义，并统一 unsupported `sites=0`。
- 测试直接消费 frozen source/agent/channels vectors、known states、decoys、essential/optional absence、mixed cases 与 historical golden；另用 sparse 40/70/80/100/250MB reader 覆盖 discovery overlap、32MB boundary、bounded candidates、non-source cache boundary、全局 range merge 和 shared full fallback。open count、close count、read ranges 与 timing 都通过注入 spy/clock 精确断言，不依赖墙钟。

严格 TDD 证据：

```text
bun test test/patch/probe.test.mjs test/read-once.test.mjs
RED 1: 5 pass, 1 fail, 1 error
Cause: Cannot find module '../../lib/patch/targets/claude/probe.mjs'.

Same focused command after initial implementation
RED 2: 8 pass, 1 fail
Cause: windowed agent-model unsupported lost agent_model_variant_unsupported detail code.

bun test test/patch/probe.test.mjs
RED 3: 5 pass, 1 fail
Cause: 250MB source detect_windows received a 32,000,000-byte discovery slice instead of a bounded candidate slice.

bun test test/patch/probe.test.mjs -t 'falls back when a non-source candidate'
RED 4: 0 pass, 1 fail
Cause: agent-model candidate at the 64MiB tail discovery boundary extended beyond the cache and threw before fallback.

Same filtered command after generic cache-coverage fix
GREEN: 1 pass, 0 fail.
```

验收与回归：

```text
Task 3.4 focused isolated service
14 pass, 0 fail (9 probe + 5 read-once)

Phase 3 adjacent isolated service
61 pass, 0 fail, 268 expect() calls, 7 files

Authoritative full Bun suite with real Bun/Node PATH
315 pass, 0 fail, 34868 expect() calls, 47 files, 82.33s

get_errors probe.mjs channels.mjs probe.test.mjs
No errors found
```

共享终端中的完整 suite 多次被并行命令的 `Ctrl-C` 接管，均作废。隔离 service 初次因 PATH 落到未配置 Bun/Node 的 Volta shim 产生 contract 子进程失败；修正 Bun PATH 后全套 314 pass，仅 `cli-extract` 在 30s 超时，随后带真实 Node/Bun PATH 单独复跑该文件为 2 pass、0 fail，主测试 8.56s，证明该失败为环境/负载而非 probe 回归。权威完整 suite 显式把真实 Bun/Node 目录置于 PATH 首位并取得 315 pass、0 fail；unit 最终 `Result=success`、`ExecMainStatus=0` 且无残留进程。

真实只读 smoke：`/home/xp/.local/share/claude/versions/2.1.217` 返回 version `2.1.217`、size `268573680`、total `2126ms`，states 为 source-exec patched、agent-model unsupported、channels patched。只调用 `probeClaudeBinary`，未执行 apply、transaction、store、CLI 或任何写盘。

独立 reviewer 第一轮结论为 0 blocker、0 major、1 minor：agent-model/channels candidate 靠近 discovery 起点时可能越出 cache。该问题以真实 agent feature 精确 RED 重现后，修为所有 feature 通用 cache coverage gate；source 另保留 32MB 边界规则。第二轮 reviewer 确认 minor 已关闭，最终 consensus/PASS，0 blocker、0 major、0 minor。

### Task 3.5：JS shared store、lineage 与 lock

状态：完成；独立 reviewer 复核 PASS。未修改 transaction、CLI、Python、旧 JavaScript patch 路径、contract 资产或 live binary，未创建 commit。

变更文件：

- `lib/patch/store/root.mjs`
- `lib/patch/store/identity.mjs`
- `lib/patch/store/manifests.mjs`
- `lib/patch/store/assets.mjs`
- `lib/patch/store/lock.mjs`
- `lib/patch/store/lineage.mjs`
- `lib/patch/store/quarantine.mjs`
- `test/patch/store/root.test.mjs`
- `test/patch/store/identity.test.mjs`
- `test/patch/store/manifests.test.mjs`
- `test/patch/store/assets.test.mjs`
- `test/patch/store/lock.test.mjs`
- `test/patch/store/lineage.test.mjs`
- `test/patch/store/quarantine.test.mjs`
- `docs/dual-implementation-progress.md`

实现结果：

- store root 按 `UNBUN_CC_STORE`、XDG/HOME、macOS Application Support、Windows LOCALAPPDATA 顺序解析；override 必须是平台原生绝对路径并拒绝未展开 shell 变量。
- canonical path 独立消费全部 9 个 frozen cases，覆盖 POSIX symlink/NFC、Windows extended drive/UNC prefix、separator、ASCII-only lowercase 与非 ASCII 保留；`path_key` 是 canonical UTF-8 bytes 的完整 64 位 lowercase SHA-256。
- Ajv 2020 验证 target/baseline/snapshot/lock-owner/quarantine schema；manifest parser 拒绝 UTF-8 BOM、非法 UTF-8、非 object root、高版本、错类型、缺字段与路径穿越，允许 schema 未禁止的未知 optional fields。消费资产时重新验证 path key、目录/内容 version、hash、size、states 与 baseline lineage。
- `target.json`、baseline 与普通 snapshot manifest 使用 hard-link no-clobber publish；baseline/snapshot blob 为 content-addressed，正式 manifest 是唯一激活点。orphan blob 与 dot temp 不 active；snapshot force 只原子 replace manifest，并准确区分首次创建与替换；snapshot 选择优先 current version，否则对跨版本同 slug 报 `snapshot_ambiguous`。
- blob temp 与 manifest temp 均 flush/file fsync/readback；POSIX/macOS 在 blob publish 和 manifest publish 后分别 fsync 对应目录。Windows adapter 明确暴露 `file-flush-and-atomic-rename-no-directory-fsync`，不伪造 directory fsync。
- cooperative lock 以原子 `mkdir(write.lock)` 获取，owner token 必须匹配才能释放。缺失或损坏 owner 仍是有效锁；仅显式 force 可删除空锁目录或唯一 `owner.json`，任何未知内容均拒绝且不递归删除。
- quarantine 将资产移出 active namespace，记录受约束原相对路径、reason、observed SHA-256、UTC 时间与 implementation，并由正式 schema 验证。
- lineage 直接读取 frozen platform capability map，拒绝未知平台及任意层级 `writes` 汇总捷径；对正式 JS feature registry 依次调用 `observe_substates` 与 `replay_substates`，验证 baseline lineage hash、normalized size、expected/current hash 和完整 normalized bytes。replayable mixed 通过；不完整 substates 与同 path/version 的非 feature byte drift 均报 `baseline_stale_build`。ELF/PE 为 identity normalization；Mach-O 必须注入经过证明的 normalizer，production gate 保持 frozen disabled 状态。
- `assessBaselineCreation` 为 Task 3.6 提供无写入判定。actual live `/home/xp/.local/share/claude/versions/2.1.217` 只读 probe 得到 `source-exec=patched`、`agent-model=unsupported`、`channels=patched`；空 test store 返回 `channels_patched_no_baseline`、exit `1`，且 probe 前后 store 路径均不存在。当前正式 agent-model detector 的 live 结果与冻结 platform metadata 中的历史 `patched` 观测不同，本 Task 未伪造或改写该事实。

严格 TDD 证据：

```text
bun test test/patch/store/identity.test.mjs test/patch/store/root.test.mjs
RED: 0 pass, 2 fail, 2 module errors
Cause: identity.mjs 与 root.mjs 尚不存在。

bun test test/patch/store/manifests.test.mjs test/patch/store/assets.test.mjs
RED: 0 pass, 2 fail, 2 module errors
Cause: manifests.mjs 与 assets.mjs 尚不存在。

bun test test/patch/store/lock.test.mjs test/patch/store/quarantine.test.mjs
RED after correcting one test syntax error: 0 pass, 2 fail, 2 module errors
Cause: lock.mjs 与 quarantine.mjs 尚不存在。

bun test test/patch/store/lineage.test.mjs
RED: 0 pass, 1 fail, 1 module error
Cause: lineage.mjs 尚不存在。

Additional REDs after review/self-review
- snapshot selection export missing；
- first quarantine parent missing；
- force snapshot replacement misclassified as conflict；
- strict UTF-8 byte parsing, blob-directory fsync and non-self-proving target identity were not yet implemented。

bun test test/patch/store
GREEN: 45 pass, 0 fail, 182 expect() calls, 7 files

get_errors lib/patch/store test/patch/store
No errors found
```

独立评审：第一轮为 0 blocker、0 major、4 minor。全部采纳：inspector tests 真实消费 bytes/manifest；force snapshot 准确区分 create/replace；补齐 clean/mixed/unsupported/existing baseline creation 分支；lineage 显式断言 expected/current normalized hash 相等。另补 Windows extended UNC、strict UTF-8、双目录 fsync 与 target identity 防自证测试。第二轮 reviewer 逐项复核后结论 PASS，无 blocker、major、minor 或建议。第三轮针对补强后的协议复核发现 1 个 minor：内部 manifest load 仍先用 Node 宽容 UTF-8 string decode，绕过 fatal decoder；已将 target/baseline/snapshot/lock 的全部内部 readback 改为 bytes，并补 Buffer BOM 断言。publish/load 也统一要求标准 64-hex target directory 或显式外部 path key，不允许 manifest 自证 identity；修复后 45 项 store tests 全绿。

完整 Bun 回归曾两次因共享终端注入 `Ctrl-C` 作废；第一次隔离窄套件的唯一稳定失败位于当时并行 Task 3.4 的 `probe.test.mjs` bounded candidate slice，32MB discovery window 被直接传给 `detect_windows`，与 store 模块无 import/call 关系，本 Task 按边界未越界修改。该并行任务随后自行更新 probe；最终 Task 3.5 直接依赖窄套件为 129 pass、0 fail、607 expect() calls、15 files。

权威 detached full suite 使用真实 Bun 目录置于 PATH 首位并执行 `bun test --timeout 120000`，结果为 314 pass、1 fail、1 error、34868 expect() calls、47 files。唯一失败是既有 `test/cli-extract.test.mjs` 的测试内固定 30 秒 timeout：四个 extract 产物已经写出，最后 `node --check app.js` 被 SIGTERM；单文件 detached 复跑同样得到 1 pass、1 fail、1 error，稳定证明是该既有大 live-binary 测试的性能阈值问题，不经过或 import Task 3.5 store。排除这一个已独立归因文件后，其余全仓 46 files 在 detached service 中为 313 pass、0 fail、34849 expect() calls。Task 3.5 的 45 项在 full suite 与聚焦套件中均全绿。

### Task 3.6：JS transaction、原子写、snapshot、codesign 与回滚

状态：完成；独立 reviewer 三轮复核最终 PASS，0 blocker、0 major、0 minor。未修改 CLI、TUI、旧 JavaScript patch 路径、Python 或 live binary，未创建 commit。

变更文件：

- `lib/patch/transaction/transaction.mjs`
- `lib/patch/transaction/atomic-write.mjs`
- `lib/patch/transaction/codesign.mjs`
- `lib/patch/transaction/snapshots.mjs`
- `lib/patch/targets/claude/probe.mjs`
- `contract/vectors/transaction-v1.json`
- `contract/schemas/transaction-scenario.schema.json`
- `test/patch/transaction.test.mjs`
- `test/patch/transaction-faults.test.mjs`
- `test/patch/snapshots.test.mjs`
- `test/patch/codesign.test.mjs`
- `test/patch/probe.test.mjs`
- `test/contract/schema.test.mjs`
- `docs/dual-implementation-progress.md`

实现结果：

- `runPatchTransaction` 默认使用 cooperative target lock、新 Claude bytes inspector、正式 feature registry、store baseline 与 exact replay lineage；所有关键边界仍可注入测试 adapter。入口在持锁后重读 binary并校验可选 entry SHA-256，baseline resolve/publish/复验先于任何 binary temp。
- 无 baseline 时仅允许全 clean 或只含 reversible patched feature 的入站态。可逆态按反向拓扑 reverse 到全 clean，再正向重放并逐字节证明等于 entry；`channels=patched` 返回 `channels_patched_no_baseline`，mixed/unsupported fail closed。既有与新建 baseline 均执行完整 normalized exact replay。
- 最终目标集合由 dependency closure 决定，并始终从 clean baseline 按稳定拓扑顺序重放。内存中验证 version、等长和每个 feature 的最终状态；result 与 entry 完全相同时再次重读 binary 后返回 `edits=0`，不写 temp、不 replace、不 codesign。
- binary result temp 使用同目录隐藏 UUID 名，先写 bytes和 entry mode，再 file fsync、关闭、回读逐字节核对；紧贴 replace 前再次读取 entry bytes并重新执行 exact replay proof。随后原子 replace、Linux/Windows full-byte readback、feature/version/lineage 后验。
- macOS codesign 是可注入的两阶段 `--remove-signature` + `-s -` adapter。签名后允许 full-byte signature drift，但重新验证 embedded version、feature states、normalized lineage 和 executable regular-file 状态。patch transaction 与 snapshot restore 的 codesign/postverify 失败都原子恢复 transaction entry bytes。
- 任一 replace 后失败均恢复 entry bytes并回读；restore 失败升级为 `rollback_failed`，携带原错误、rollback错误和可用的诊断 temp 路径。replace 前错误不触发错误回滚。`EBUSY`/`EACCES`/`EPERM` 将已 fsync/readback 的 ready temp 移入 target quarantine、写 v1 manifest并返回 `binary_in_use`；manifest 发布失败会尽力把 artifact 移回 ready temp。
- snapshot v1 完成持锁 save/force/remove/restore、无锁 list、manifest 激活、content-addressed blob 保留、current-version 优先选择、跨版本显式确认、entry digest、atomic replace、postverify、macOS codesign和失败回滚。remove 只移除 active manifest，blob 留待显式 GC。
- 新增语言中立 `transaction-v1.json` 和 Ajv 2020 schema，expected 是静态 frozen data，不由 JS 或 Python 在测试时生成。场景覆盖 apply、idempotent、channels revert 保留 agent 和 entry digest mismatch。
- frozen generation-one 五类 known-bad 全部从新 transaction 入口验证：receiver S、agent-model 不错误依赖 source-exec、channels revert 保留 agent、相邻 `.bak` decoy 不读取且不创建新 backup、结构性 feature 失败保持 `content_mismatch`/exit `2`。生产事务模块零 `.bak`、旧 JS、Python、CLI 或 TUI import。
- 所有写测试使用 `mkdtemp` binary/store fixture。真实 2.1.217 只由既有 contract/interop suite 执行只读 probe；本 Task 未对 live binary、live store 或当前 LiteLLM 实例执行写操作。

严格 TDD 证据：

```text
bun test test/patch/transaction.test.mjs
RED: 0 pass, 1 fail, 1 module error
Cause: transaction.mjs 尚不存在。

bun test test/patch/transaction.test.mjs test/patch/transaction-faults.test.mjs
RED: transaction happy path 已绿；fault suite 因 atomic-write.mjs 尚不存在报 module error。

bun test test/patch/codesign.test.mjs
RED: codesign.mjs 尚不存在。

bun test test/patch/snapshots.test.mjs
RED: snapshots.mjs 尚不存在。

后续逐项 RED 覆盖：post-write 不回滚、codesign 原始异常未映射、rollback_failed 缺失、baseline resolver 缺失、macOS signature drift 被错误要求等长、snapshot restore 缺 macOS codesign。每个 RED 均在同一聚焦测试中修复并复跑。

bun test test/patch/probe.test.mjs test/patch/transaction.test.mjs test/patch/transaction-faults.test.mjs test/patch/snapshots.test.mjs test/patch/codesign.test.mjs test/contract/schema.test.mjs
66 pass, 0 fail, 310 expect() calls, 6 files

bun test test/patch
169 pass, 0 fail, 628 expect() calls, 21 files

bun test test/contract
56 pass, 0 fail, 1181 expect() calls, 8 files

bun test test/*.test.mjs test/interop
120 pass, 0 fail, 33166 expect() calls, 25 files

get_errors lib/patch/transaction lib/patch/targets/claude/probe.mjs test/patch test/contract/schema.test.mjs
No errors found

git diff --check
No errors
```

两次单命令 `bun test` 在共享终端被其他并行会话发送的 `Ctrl-C` 和后续命令接管，均作废且未记为测试结论。为取得不受长命令窗口影响的完整证据，按互不重叠的 `test/patch`、`test/contract`、顶层 `test/*.test.mjs + test/interop` 三组运行，合计 345 pass、0 fail、34975 expect() calls、54 files；三组覆盖仓库全部 Bun test 文件。

独立 reviewer 第一轮结论：0 blocker、1 major、4 minor。经代码和规格核验，dynamic `stat` import 的功能风险评级被认为夸大，但改为静态 import；采纳 macOS snapshot restore codesign、quarantine manifest 发布失败回迁、移除静态 known-bad 常量断言。另主动补默认 bytes probe wiring、默认 cooperative lock 的真实执行测试、macOS patch/snapshot signature drift 与 rollback测试。未采纳“remove snapshot 同时清理 blob”，因为 shared-store §7.4 明确要求 blob 可留待显式 GC；未升级 frozen platform capability matrix，因为它同时要求跨语言 writer 和真实平台 runtime/codesign evidence，不能由本 Task 的 JS 合成测试单边升级。第二轮 reviewer 总体 PASS，但指出 macOS snapshot restore 在 codesign 后未重新比对 manifest 的三个 feature states；以注入 codesign 反向破坏 agent-model 的 RED 复现后，加入 source-exec/agent-model/channels 严格比对并验证 `content_mismatch` 后恢复 entry。第三轮 reviewer 独立模拟该路径并确认无 precedence 或 rollback 问题，最终 PASS，0 blocker、0 major、0 minor。

### Task 3.7：重建 `unbun cc` CLI、JSON 与诊断命令

状态：完成；独立 reviewer 两轮复核最终 PASS，0 blocker、0 major、0 minor。未修改 live binary/store，未创建 commit。

变更文件：

- `cli.mjs`
- `lib/patch/cli/actions.mjs`
- `lib/patch/cli/binaries.mjs`
- `lib/patch/cli/context.mjs`
- `lib/patch/cli/diagnostics.mjs`
- `lib/patch/cli/dispatch.mjs`
- `lib/patch/cli/errors.mjs`
- `lib/patch/cli/output.mjs`
- `lib/patch/cli/status.mjs`
- `test/patch/cli.test.mjs`
- `test/interop/live-probe-differential.test.mjs`
- `test/contract/vector-integrity.test.mjs`
- `contract/vectors/known-bad-v1/manifest.json`
- `docs/dual-implementation-progress.md`

实现结果：

- `cli.mjs` 不再 import 一代 `patch-binary.mjs` 或 `patch-tui.mjs`；`cc status|patch|revert|snapshot save/list/rm|store root|lock inspect/cleanup` 统一转交 `lib/patch/cli/`，既有 `cc run/introspect/patch-loader-hook` 保留原参数和行为并在新 manager 前明确消歧。新 patch production tree 也不 import ELF compatibility layer、Python 或 `ccpatch` subprocess。
- bare `unbun cc` 在 non-TTY 只走只读 status；bare TTY 返回明确 `not-yet-implemented`/exit `1`，为 Task 3.8-3.9 的全功能 TUI 保留入口；显式 `status` 即使在真实 PTY 中也始终走 status，不进入 TUI。`--profile` 只读输出 `implementation=js` 和 probe timing。
- status 复用 windowed `probeClaudeBinary`，按共同 `status.schema.json` 输出；active baseline 只读验证复用 transaction 同源 frozen platform matrix、content inspector 与 lineage adapter。无 baseline 时不创建 store、target metadata 或 lock；`store root` 只解析 `UNBUN_CC_STORE`，`lock inspect` 只计算 identity并读取 lock。
- 写命令先 canonicalize target并发布 v1 target metadata，再调用正式 `runPatchTransaction`。patch/revert 计算最终 feature target set；联合移除 channels/source-exec 合法，单独移除仍被 channels 依赖的 source-exec 稳定拒绝。每台 binary 持有独立结果或结构化错误，batch exit 取最大 severity并保留成功项。
- snapshot save/list/rm/restore 全部调用正式 shared-store transaction API，支持 force、同 slug跨版本、`--snapshot-version` 与 `--yes/-y` 跨版本确认；write envelope 只暴露共同 schema 的 `binary/applied/edits/resigned`，不泄露内部 manifest 或 blob bytes。
- lock inspect 稳定报告 unlocked、known owner 或 `lock exists but owner unknown`；cleanup 无 `--force` 返回 `target_locked`/1，force 只调用正式 stale-lock cleanup，前后不改 binary。cleanup result 同样收敛到共同 write-envelope schema。
- status 与 write envelope 在写 stdout 前通过 Ajv 2020 strict runtime validation；stdout JSON 始终单一、无诊断污染，store/transaction错误使用 frozen 19-code catalog，stderr保留人类诊断。CLI用法错误因不属于 frozen error schema，稳定使用 stderr `usage_error`、空 stdout、exit `1`。目标 `ENOENT/ENOTDIR/EACCES/EPERM` 映射 `version_probe_failed`/1；未知内部错误保持 `content_mismatch`/2。
- 所有 CLI 写测试从 frozen synthetic golden复制 `mkdtemp` binary，并为每个场景设置临时 `UNBUN_CC_STORE`。只读 live 2.1.214/2.1.217 differential仅比较共同 public status 的 version/state/sites；内部 substates继续由 probe/frozen-vector tests覆盖。generation-one known-bad positive control改为直接调用保留的一代 `runPatch`，避免 Task 3.7 新 dispatch 让旧错误折叠测试假绿。

严格 TDD 证据：

```text
bun test test/patch/cli.test.mjs
RED: 0 pass, 3 fail
Cause: explicit status 与 bare non-TTY仍进入一代 patch 分发；生产 CLI仍 import patch-binary.mjs。

首次 status 接线后：2 pass, 1 fail
Cause: probe 已把 sites规范化为整数，status adapter错误读取 `.length`；修复后 3 pass。

扩展 patch/revert/snapshot/batch 后：3 pass, 3 fail
Cause: manager写命令仍为 not-yet-implemented；接正式 transaction/store 后，剩余 2 项定位为 status active baseline缺 lineage adapter；复用 transaction同源配置后 6 pass。

扩展 store/lock/TTY 后：7 pass, 2 fail
Cause: store root与 lock命令仍为占位；接正式 diagnostics 后 9 pass。

后续 RED 依次覆盖并关闭：snapshot envelope泄露 bytes、`--snapshot-version`键名错误、help命令表缺失、联合 feature revert被逐项依赖检查误拒绝、profile缺实现/timing、unknown option/feature错误边界、patch production tree误 import bun-binary ELF compatibility layer、public live differential误要求 status schema暴露内部 substates、missing target被误报 content_mismatch/2。

bun test test/patch/cli.test.mjs
16 pass, 0 fail, 116 expect() calls, 1 file

bun test test/patch
185 pass, 0 fail, 746 expect() calls, 22 files

bun test test/contract
56 pass, 0 fail, 1181 expect() calls, 8 files

bun test test/*.test.mjs test/interop
140 pass, 0 fail, 33590 expect() calls, 27 files

get_errors cli.mjs lib/patch/cli test/patch/cli.test.mjs test/interop/live-probe-differential.test.mjs test/contract/vector-integrity.test.mjs
No errors found

git diff --check
No errors
```

完整 Bun分组最终合计 381 pass、0 fail、35517 expect() calls、57 files。一次聚焦 CLI运行和此前两次长命令被共享终端的 `Ctrl-C` 或其他会话命令接管，均明确作废并从头重跑；仅自然结束的结果计入上述证据。

独立 reviewer 第一轮结论为 PASS、0 blocker、0 major、3 minor。采纳 lock cleanup result不应泄露 schema未声明 `removed` 字段并补 missing target错误映射；`--json`用法错误不伪装成 frozen store/transaction code，保留 stderr文本/空 stdout/exit `1`；真实 PTY的 `script`会合并 child stdout/stderr，因此 TTY测试只证明分支、用户可见诊断与退出码，通道分离由 non-TTY JSON tests覆盖。复审逐项确认处置合理，最终 PASS、0 blocker、0 major、0 minor；唯一 nit建议把 raw `EPERM`归入目标访问失败，已采纳且不影响优先命中的 stable `binary_in_use` StoreError。

独立 verifier 最终在 detached transient systemd service 中以真实 Bun、Node、uv 与 Python PATH运行 `bun test --timeout 120000 test/*.test.mjs test/interop`，unit自然结束为 `Result=success`/exit `0`，取得 140 pass、0 fail、33590 expect() calls、27 files；同时只读复核 patch 185 pass、contract 56 pass与 `git diff --check`。此前 detached尝试分别因 Volta shim、精简 PATH缺 bun/uv/node、默认 5秒 interop timeout或等待客户端被共享 PTY `Ctrl-C`中断而未形成完整成功汇总，均作废且未计入最终证据。

## Phase 4

状态：进行中。Tasks 4.1 与 4.4 的公开 CLI 差分、关键交替和可由公开边界稳定构造的故障矩阵已完成；Tasks 4.2-4.3 既有底层 adapter 证据也新增了公开 baseline/snapshot/lock gate；Task 4.5 的 runtime oracle 与 live-readonly 已完成。双 PTY 与完整发布矩阵尚未完成，不能据此声明完整 Phase 4 通过。

### Tasks 4.1 与 4.4：公开 CLI 差分、关键交替与故障

状态：完成；所有写入只发生在 frozen synthetic golden 的临时副本和同一临时 `UNBUN_CC_STORE`，未调用内部 runner/API，未写 live binary/store，未修改 TUI，未创建 commit。

#### Task 4.1：双实现差分 contract suite

新增测试：

- `test/interop/differential.test.mjs`
- `test/interop/alternating-cli.test.mjs`
- `test/interop/faults.test.mjs`

公开边界与比较规则：

- 每一步都通过既有 harness 真实启动 `bun cli.mjs cc ...` 或 `uv run --directory python/cc-patch ccpatch ...`；三份新测试静态扫描确认不 import `lib/patch`、`cc_patch` 或底层 transaction runners。
- status 比较 `state`、`sites`、稳定 detail codes 与公开 `substates[{identity,state}]`。共同 status schema 和两端 JSON projection 新增稳定 substates，不公开 offset/length 等实现定位细节。
- write envelope 比较 `success/exit_code/action/results/errors` 以及每步 `applied/edits/resigned`；忽略 message、时间、PID、hostname、implementation 和实现私有附加字段。
- dependency closure 使用 frozen graph：`channels -> source-exec`，`agent-model` 无依赖。关键步骤由 frozen transaction oracle 固定：channels patch 为 `source-exec+channels`/5 edits，追加 agent 为三 feature/1 edit，移除 channels 为 agent-only/5 edits，revert all 为 clean/1 edit。

- clean golden比较三 feature的完整公开状态；`channels-missing-essential.txt` 作为非空 detail-code与 absent substate正样本，要求两端都报告 `channels_essential_site_missing` 以及 feature-flag/permissions/cap-strip 的稳定 absent identity。该正样本发现并修复 JS channels observation漏报 absent substates，未改 apply/replay写算法。另用完全无 feature anchor的临时 binary锁定 channels unsupported时双方 `substates=[]`，避免把不存在的 decision错误表示为 absent。

#### Task 4.4：关键交替与 transaction 故障

关键交替：

- 场景 A：clean → JS patch channels → Python status/patch agent-model → JS revert channels → Python status确认 agent-only且 binary仍含 `@bytecode` → Python revert all → JS status clean且完整 bytes等于 original。
- 场景 B 完整交换 JavaScript/Python 角色；两条链共享各自唯一的 temp binary/store，每一步均解析公开 JSON。最终 2 pass、60 expect，随后加入 baseline visibility 后保持通过。

公开 store 互操作：

- baseline：两个交替方向均由第一实现建立 baseline，另一实现公开 status报告 `has_baseline=true` 并继续写/最终 revert all。
- snapshot：JS save → Python list/restore/rm及完整反向角色；restore 比较保存时完整 bytes，remove 后由 producer公开 list确认空。
- lock：两端公开 inspect读取同一 unknown-owner lock；两端 writer均返回 `target_locked`/1且 binary/quarantine不变；Python公开 `lock cleanup --force --json` 清理后由 JS inspect确认 unlocked。

故障矩阵：

- 双向损坏 active `baseline.json`：consumer公开 CLI返回 `baseline_invalid`/2，binary bytes与 quarantine文件集不变。
- 双向 same-version different-build：在 feature外追加一个 byte，consumer返回 `baseline_stale_build`/2，binary保持 altered entry且 quarantine不增。
- lock占用：两端错误视图统一为 `target_locked`/1、空 results；忽略 message与可选 feature归因差异。
- entry drift没有公开 CLI 可控的 pre-replace pause/fault adapter；本 Task未调用内部 hook伪造公开证据。已有双方 transaction fault suites继续覆盖 replace前 entry re-read/concurrent drift，但不计为本次公开 CLI gate。

严格 TDD 与 production缺陷：

```text
故意漏 sites：
bun test --timeout 30000 test/interop/differential.test.mjs
RED: clean golden三个 feature均显示 JS received sites、故意删减后的 Python expected无 sites；证明差分 oracle能抓字段缺失。

公开 substates：
RED: 两端 feature.substates均不存在。
修复共同 status schema与两端 projection后，继续 RED：Python details输出人类说明而 JS输出稳定 codes。
修复 Python JSON details为 detail_codes后 GREEN。

关键交替首次运行：
RED: 两个方向的 revert channels都错误留下 orphan source-exec，返回 source-exec+agent-model/4 edits，而 frozen oracle要求 agent-only/5 edits。
修复两端 CLI revert target-set orphan dependency清理后，场景 A通过；场景 B暴露 Python漏 import resolve_closure，修复后 2 pass。

same-version different-build：
RED: JS consumer正确；Python consumer让 LineageError traceback泄漏、stdout为空。
将 frozen LineageError code映射到 Python公开 envelope后 2 pass。

snapshot公开互操作：
RED: Python save/list输出文本，public JSON harness无法解析。
只改 Python CLI projection，使 save/rm/restore使用共同 write envelope、list使用共同 snapshots shape后 3 pass。

lock公开 cleanup：
RED: Python cleanup输出文本，public harness无法解析。
新增 --json共同 write envelope后 faults 5 pass。
```

最终验证：

```text
bun test --timeout 30000 test/interop/differential.test.mjs test/interop/alternating-cli.test.mjs test/interop/faults.test.mjs
12 pass, 0 fail, 156 expect() calls, 3 files

bun test --timeout 30000 test/interop
43 pass, 0 fail, 629 expect() calls, 7 files

bun test --timeout 30000 test/patch
185 pass, 0 fail, 746 expect() calls, 22 files

bun test --timeout 30000 test/patch/cli.test.mjs test/contract/schema.test.mjs
42 pass, 0 fail, 251 expect() calls, 2 files

uv run --directory python/cc-patch pytest -q tests/test_cli.py tests/test_cli_contract.py tests/test_report.py tests/test_orchestrate.py tests/test_store_contract.py tests/test_locking.py tests/test_snapshots.py
123 passed in 13.15s

新测试内部 API/runner扫描：none；harness精确公开命令两条均命中。
get_errors：本 Task修改文件 No errors found。
git diff --check：No errors。
```

独立 reviewer 第一轮结论为 0 blocker、0 major、3 minor：故障前置 quarantine未显式证明为空；clean golden不能证明非空 detail-code差分；substate item错误使用封闭 schema，不符合 v1其余公开 schema的可选字段扩展策略。三项均采纳：三类故障先断言空 quarantine；新增 frozen missing-essential公开正样本；移除 substate `additionalProperties: false` 并用未知可选字段正样本锁定。非空 detail-code正样本进一步发现 JS漏报 absent substates，修复后复审确认前三项关闭，但指出完全 unsupported时 JS额外报告 `decision:absent`。新增公开红测后修正为无 decision即空 substates；有 decision时才补三个支持站点 absent。最终复审结论为 PASS，0 blocker、0 major、0 minor，可进入下一阶段。

### Task 4.5：临时副本 runtime oracle 与 live binary 只读 probe

状态：完成；未创建 commit。新增 `test/interop/runtime-oracle.test.mjs` 与 `test/interop/live-readonly.test.mjs`。所有写入只发生在测试创建的 Bun SFX、clean Claude 2.1.214 临时副本及其独立临时 store；mock 只监听随机 `127.0.0.1` 端口，不读取、停止、重启或请求 LiteLLM。live 2.1.217 与默认 store 只读。

runtime gate：

- 测试先用真实 `bun build --compile --bytecode` 生成普通 Bun SFX并执行得到 `unbun-runtime-sfx=42`。JavaScript/Python 两套公开 CLI 分别对独立副本尝试 `patch --feature agent-model --json`，双方都因缺 Claude-specific anchor以失败 envelope拒绝；副本完整 bytes不变且仍执行得到 `42`。因此普通 Bun SFX只充当“不适用”正样本，不伪装成完整 Claude feature runtime gate。
- 完整 gate 使用本环境 clean `/home/xp/.local/share/claude/versions/2.1.214`，固定 SHA-256为 `3c029136f7c81f54ed4a38e9d52e655aad536433dbbde50519c8c31bb646ad14`；可用 `UNBUN_CC_CLEAN_FIXTURE`显式提供同一已审计 fixture。测试开始先验证固定 hash，再为 JavaScript/Python各复制到唯一临时 canonical path并设置唯一临时 `UNBUN_CC_STORE`。
- 每个副本必须由对应仓库内公开 CLI真实 patch `agent-model`，测试不调用 feature/transaction API制造 bytes。随后只复用 `exp/agent-model-runtime` 的决定性 `ThreadingHTTPServer` mock与 `run_variant`行为采集器，启动真实 Claude副本。测试内先运行未 patch clean副本作为阴性对照：Agent schema仍为四项 enum，client收到 mock注入的 Agent tool use，但不会产生 `gpt-5.5` child request。
- JavaScript/Python两份公开 CLI patched副本都实际观测到 Agent schema `model.type=string`且无 enum，随机 localhost mock收到后续 `model=gpt-5.5` child request；binary observation同时证明 agent-model为 patched、全部5个 `@bytecode` marker保留、无 `@source__`。同 test内的 clean阴性与两份 patched阳性共同证明行为变化来自公开 CLI agent-only patch；对审计的2.1.214构造，`agent-model`无需 `source-exec`。
- clean源 fixture前后 SHA-256、mtime与size不变；没有把缺 clean fixture的 skip计为 green。本环境固定 fixture缺失、hash不匹配或被替换都会让测试失败。

live-readonly gate：

- current `/home/xp/.local/share/claude/versions/2.1.217`依次通过 JavaScript `status --json`与 Python `--check --json`公开只读入口；两端完整公开 status视图一致，version为2.1.217、`has_baseline=false`，`source-exec`、`agent-model`、`channels`均为 patched。
- 调用前后比较 live binary SHA-256、纳秒 mtime与size。默认 store snapshot包含根目录存在性/mtime以及递归每个目录/file的相对路径、纳秒mtime、size与file SHA-256；前后完全相同，因此也能抓住“原本缺 store但 status意外创建空目录”的 false green。

严格 TDD 与验证：

```text
首轮两个 gate：1 pass, 1 fail。
live-readonly直接通过；runtime在行为 oracle前因测试错误要求两套成功 stderr风格相同而失败。仓库内既有 Python CLI合同明确要求成功诊断 `OK model enum -> string()` 写 stderr；移除该非合同假设，保留 exit、JSON envelope和行为断言。

补普通 Bun SFX正样本后：
bun test --timeout 180000 test/interop/runtime-oracle.test.mjs
2 pass, 0 fail, 48 expect() calls；普通SFX拒绝4.64s，clean阴性+双实现真实Claude行为oracle 111.24s，总计126.01s；clean 2.1.214 SHA运行前后均为固定值。

bun test --timeout 60000 test/interop/live-readonly.test.mjs
1 pass, 0 fail, 12 expect() calls, 5.48s。

组合 gate（增强store根快照前）：
bun test --timeout 120000 test/interop/runtime-oracle.test.mjs test/interop/live-readonly.test.mjs
2 pass, 0 fail, 44 expect() calls, 105.61s；后续新增普通SFX test与store根快照分别由上述聚焦命令验证。

get_errors：两个新增测试 No errors found。
git diff --check：No errors。
```

共享 PTY中的两次验证在命令真正进入隔离 unit前被其他会话 `Ctrl-C`接管，均明确作废。独立 verifier前三次隔离尝试暴露 PATH环境问题：缺字面 `bun`、Volta shim在无 `VOLTA_HOME`的 unit中失败、精简 PATH漏 `uv`；最终使用实际 Bun目录加 `/home/xp/.local/bin`运行到自然结束，上述通过结果才计为证据。

### Task 4.2：baseline 与目标集合双向 E2E（底层 adapter）

状态：底层完成；公开 CLI gate 待后续接线。未修改 JavaScript production transaction、feature、store 或 live binary/store，未创建 commit。

实现：

- 新增 `test/interop/js-transaction-runner.mjs` 与 `python-transaction-runner.py`。两者都是 stdin 单 JSON、stdout 单 JSON 的独立 process adapter，只调用本语言仓库内正式 transaction/store/feature registry API，不调用另一实现，也不实现 feature、dependency、manifest、blob、lock 或 transaction 逻辑。
- 每个 case 从 `contract/golden/claude-v1/synthetic-2.1.175-clean.bin` 复制临时 binary，并让两个 runner 共享同一临时 `UNBUN_CC_STORE`。Python process-global store 只在 runner 子进程内初始化，不污染测试宿主或其他 runner。
- 完整交替矩阵双向覆盖：JS 建 baseline并 patch channels → Python 消费同 baseline追加 agent-model → JS 移除 channels且保留无 source 依赖的 agent-model → Python revert all且 bytes 等于 original；完整反向角色同样执行。
- 一边建立 baseline后，另一边从正式 feature substate API 构造的 exact-replay-valid mixed channels 入站态修复到完整 channels；双向验证最终 states、binary与 store tree。
- 同 version 不同 build 由 feature 外等长字节变化构造；双方都返回 `baseline_stale_build`/exit `2`，binary与完整 store tree不变。
- 所有成功响应都带最终 binary SHA-256 与 `store/v1` 全文件树摘要；测试逐文件比较相对路径、size、manifest/blob SHA-256，并在 revert all比较完整 final bytes，不只比较 state。

严格 TDD 证据：

```text
bun test test/interop/baseline-replay.test.mjs test/interop/store-assets.test.mjs
RED: 0 pass, 4 fail
Cause: js-transaction-runner.mjs 与 python-transaction-runner.py 均不存在；两个方向都在真实子进程边界失败。

首次 runner 实现后：3 pass, 1 fail
Cause: Python 正式 write_features 接收已解析目标闭包，adapter 错把原始 channels+agent request传入，移除 source-exec 时被正式依赖检查拒绝；runner 改为调用正式 resolve_closure 后转绿，未复制依赖图。

扩展 mixed/lineage 首跑：4 pass, 2 fail
Cause: mixed repair 本身双向成功，但测试错误期待 transaction 改写 store tree；修正为既有 baseline tree 完全不变后 6 pass。
```

### Task 4.3：snapshot、manifest 与 lock 双向 E2E（底层 adapter）

状态：底层完成；公开 CLI gate 待后续接线。互操作发现并修复一个 Python production list 格式缺陷；未写 live，未创建 commit。

矩阵与不变量：

- JS save → Python list/restore/rm，以及完整反向角色；restore 后比较保存时完整 bytes。覆盖 force activation、同 slug跨构造版本、无 current match 时 `snapshot_ambiguous`、显式 version + force跨版本 restore。
- non-force snapshot冲突保持 active manifest与所有非 blob资产不变；正式协议允许先发布但未激活的 content-addressed orphan blob，force 后确认两个 blob的 path/hash都保留且双方看到完全相同 tree。
- invalid active manifest 在双方 list 都保留 slot version并标记 `invalid=true`；blob path/hash与 binary bytes不变。删除 manifest留下 orphan blob时，双方 list都忽略 slot但完整 tree仍保留同一 blob hash。
- JS持正式 mkdir lock时 Python writer返回 `target_locked`，Python持锁时 JS同样；等待真实 `owner.json` 出现后才启动 contender，失败时 binary与除诊断 owner外的 active tree不变。
- 损坏 `owner.json` 的 unknown-owner stale lock 在双方都先拒绝无 force cleanup，只有另一边显式 force才解除；cleanup前后不改 binary、baseline或 snapshot。

互操作发现的 production 缺陷：

- RED：同一损坏 `snapshot.json`，JS list返回目录 slot version `2.1.175`，Python `SnapshotInfo.version` 返回 `None`。独立 Python `test_list_marks_invalid_manifest_with_its_slot_version` 复现为 1 fail、5 pass，证明不是 runner normalization 假象。
- 根因：`cc_patch.snapshots.list_for_binary` 异常分支丢弃了已从目录读取的 version，并错误标记 current-version invalid slot为 stale。
- 修复：invalid时保留目录 slot version并据此计算 stale；`SnapshotInfo.version` 收紧为 `str`，排序与 report移除死 `None` fallback；旧 `atomicio.list_snapshots` 只是正式 API兼容转发，其过时测试同步到 shared-store §7.4 与 JS正式行为。
- 修复后 Python snapshot单测 6 pass，Task 4.3 interop 14 pass；未修改 JavaScript production。

最终验证：

```text
bun test test/interop/baseline-replay.test.mjs test/interop/store-assets.test.mjs
20 pass, 0 fail, 424 expect() calls, 2 files

bun test test/patch/store test/patch/transaction.test.mjs test/patch/transaction-faults.test.mjs test/patch/snapshots.test.mjs
74 pass, 0 fail, 280 expect() calls, 10 files

python -m pytest tests/test_atomicio.py tests/test_locking.py tests/test_models.py tests/test_orchestrate.py tests/test_report.py tests/test_snapshots.py tests/test_store_contract.py tests/test_transaction.py -q
161 passed in 4.91s

get_errors test/interop python/cc-patch/src/cc_patch python/cc-patch/tests/test_snapshots.py python/cc-patch/tests/test_atomicio.py
No errors found

git diff --check
No errors
```

一次 Python测试命令因误写不存在的 `tests/test_store.py` 在收集前退出，明确作废且未计入验证；随后用 `rg --files` 确认真实文件名并运行上述完整聚焦 suites。一次 JS命令包含不存在的 `test/patch/store.test.mjs` 与 `lock.test.mjs`，Bun只执行了其他三个真实文件；该结果未作为完整 store suite证据，随后改为真实 `test/patch/store` 目录并取得 74 pass。

独立 reviewer 第一轮：0 blocker、1 major、2 coverage minor。major为 Python runner调用私有 `orchestrate._get_store()`；改用公开 `StoreV1(resolve_store_root())` 后完整 12-case矩阵通过。两项 coverage minor为缺 mixed/lineage与 invalid/orphan，均补 RED/双向测试；invalid场景由此发现并关闭上述 production缺陷。第二轮 reviewer：0 blocker、0 major、2 minor；确认第一轮问题全部关闭。采纳非 StoreError也保留正式 `exit_code` 与 `SnapshotInfo.version: str`；未采纳 rejected snapshot后全 tree不变，因为 shared-store §7.4明确允许未激活 orphan blob，测试已更严格地锁定 active manifest、所有非 blob资产与每个 blob hash。最终复审结论为可进入下一阶段。

### Task 3.8：选择并验证 JS 全功能 TUI 基础库

状态：完成；选择 Ink `7.1.1` + React `19.2.8`，未接 production transaction，未修改 CLI，未创建 commit。

变更文件：

- `exp/js-tui-poc/package.json`
- `exp/js-tui-poc/bun.lock`
- `exp/js-tui-poc/app.jsx`
- `exp/js-tui-poc/pty.test.mjs`
- `exp/js-tui-poc/tests/test_pty.py`
- `docs/js-tui-choice.md`
- `docs/dual-implementation-progress.md`

实现与选择结果：

- 使用 Bun `1.3.14` 执行 `bun add ink@7.1.1 react@19.2.8`，依赖准确锁定于 PoC 局部 lockfile，闭包共 38 个 package；根 production dependencies 本 Task不变。
- PoC 使用 Ink 的 layout、input、focus 与 stdout resize primitives，没有退回 `@clack/prompts` 一次性 prompt，也没有手写 ANSI 状态机。Ink 已通过真实 PTY，因此没有无必要地安装或转测 `neo-blessed`。
- Python harness 通过 `pty.openpty`、`setsid` 与 `TIOCSCTTY` 建立 controlling terminal，以 pyte `0.8.2` 解释真实屏幕网格。验证 focus/raw input、path/feature过滤、space当前行、`a` 可见可选项批量、unsupported disabled、Enter异步 `APPLYING -> DONE` 与 refresh generation、80/100/120 resize，以及 `q`/`Esc`退出。
- 退出后原位比较 parent-side slave termios，确认 `ICANON`、`ECHO`、`ISIG`、`IEXTEN`、`IXON`、`ICRNL`、`VMIN` 与 `VTIME` 恢复。测试不是组件 snapshot，也不只断言 ANSI byte stream。
- 选择、风险与 Task 3.9 adapter边界记录在 `docs/js-tui-choice.md`。PoC异步写是内存模拟，不连接 production transaction/store；正式 dependency closure仍由既有 transaction tests裁决。

严格红/绿证据：

```text
POC_BAD_LAYOUT=1 uv run --with pyte==0.8.2 python tests/test_pty.py
RED: 1 failed；80列首行的 RIGHT-EDGE 被故意宽于 viewport的 layout推出 screen grid。termios恢复断言通过，失败仅命中布局 oracle。

uv run --with pyte==0.8.2 python tests/test_pty.py
GREEN: 6 tests，覆盖完整交互与退出恢复。

bun test exp/js-tui-poc/pty.test.mjs --timeout 30000
GREEN: 2 pass；一项要求故意坏布局精确红，一项实际执行完整 6 场景真实 PTY+pyte suite。

bun test exp/js-tui-poc/pty.test.mjs --timeout 30000 --rerun-each 3
GREEN: run #1/#2/#3各自完成正样本与正常 suite，总计 6 pass、0 fail、12 expect，22.95s。命令在单个无共享 PTY的 user systemd transient unit中执行，unit `Result=success`、`ExecMainStatus=0`。
```

共享终端中的前台验证多次被并行会话的外部 `Ctrl-C` 中断，均未计为通过或失败；最终结果来自不连接共享 PTY、只写 journal 的隔离 unit。最小 Bun `spawnSync` 复核同样返回 status 0。

独立 reviewer 第一轮结论：0 blocker、0 major、2 minor。两项均已采纳：删除只证明 pyte补空格的行长恒真断言，改为 `RIGHT-EDGE` 必须精确贴住最后一列；unsupported space不再以短暂“无变化”判断，而是等待真实 grid显示 `EVENT:UNSUPPORTED_DISABLED` 后确认仍未选中。评审建议的 `_drain` 吞尽缓冲与字符输入提速不影响 PoC正确性，留给 Task 3.9正式 harness按场景规模处理。

最终独立复审：PASS，0 blocker、0 major、0 minor；确认两项 minor关闭、持续坏布局正样本有效、文档与实现一致。

完整仓库回归在无共享 PTY、完整 Bun/Node/uv PATH的隔离 unit中执行：`404 pass / 0 fail / 35698 expect()`，覆盖 59 files，unit `Result=success`、`ExecMainStatus=0`。此前一次精简 PATH运行的 `323 pass / 81 fail` 均为派生子进程找不到字面 `bun`/`node` 的 `ENOENT` 环境失败，修正 PATH后全部关闭，不计为代码回归。

### Task 3.9：实现 JS 全功能 TUI 与 PTY 回归

状态：完成；Ink `7.1.1` + React `19.2.8` 已提升为根 production dependencies，bare `unbun cc` TTY 已接正式 TUI，未创建 commit。

变更文件：

- `package.json`
- `bun.lock`
- `lib/patch/cli/actions.mjs`
- `lib/patch/cli/dispatch.mjs`
- `lib/patch/tui/adapters.mjs`
- `lib/patch/tui/app.jsx`
- `lib/patch/tui/controller.mjs`
- `lib/patch/tui/model.mjs`
- `lib/patch/tui/run.mjs`
- `test/patch/tui/adapters.test.mjs`
- `test/patch/tui/controller.test.mjs`
- `test/patch/tui/model.test.mjs`
- `test/patch/tui/pty.test.mjs`
- `test/pty/js-tui/driver.mjs`
- `test/pty/js-tui/fixtures/bad-layout.jsx`
- `test/pty/js-tui/positive_control.py`
- `test/pty/js-tui/screen_grid.py`
- `test/patch/cli.test.mjs`
- `docs/dual-implementation-progress.md`

实现结果：

- `lib/patch/tui/` 按 model、controller、production adapter、Ink view 与 runner 分层。model 按 binary 分组并保留完整 path/version/baseline/entry digest/feature state；path 与 feature 过滤使用逐 token AND 匹配，隐藏选择不丢失，`space` 只切当前可操作行，`a` 只统一切换当前可见可操作项，unsupported 始终 disabled。
- 初始 `patched` 与 `mixed` 均成为目标勾选；mixed 选中生成 replay，取消生成 revert。计划直接消费正式 `claudeFeatureRegistry` 与 `closeFeatures`，不复制依赖图：`agent-model` 独立，`channels` 最终 target set 自动闭包为 `source-exec,channels`。TUI 只把 final target set 与 entry digest 交给正式 transaction。
- production adapter 以 binary 双读 digest 包围 `readStatus`，探测期间变化返回 `concurrent_binary_change`；写入口复用 `targetContext`、shared store 与 `runPatchTransaction`，没有 import Python、PoC 或一代 patch 路径。临时 synthetic integration 已证明 clean -> source patched -> clean、baseline 激活与每次写后正式 reprobe。
- controller 串行处理多 binary，显示计划摘要与 completed/total/succeeded/failed 进度，执行中拒绝双提交和退出；完成后重新 probe、更新 badge并停留，可继续第二次提交。初始 probe error、write error、reprobe error均留屏；write 与 reprobe同时失败时合并错误并传播最高 exit severity，refresh失败不递增 generation、不把旧 badge伪装成已刷新。
- bare TTY 分支从 `not-yet-implemented` 改为动态 import production Ink/React；只接受重复 `--binary`，无参数使用默认 Claude binary。bare non-TTY仍走只读 status，显式 manager命令不加载 TUI。runner显式进入/退出 alternate screen并恢复光标，最终正式错误 severity传播到 public process exit code。
- Ink view 按 binary显示组标题、baseline与计划 badge，feature行显示 checkbox/state/disabled；footer将 filter、progress、pending summary 与快捷提示分为独立行。80列长计划允许受约束截断，最终 target set由 transaction trace严格验证，不以截断文本充当 oracle。
- production PTY driver只注入内存 rows，写调用只记到测试临时 JSONL trace；production adapter integration只使用 `mkdtemp` synthetic binary与临时 `UNBUN_CC_STORE`。没有执行 live TUI写入；仓库既有 live测试仍只读。

严格红/绿证据：

```text
uv run --with pyte==0.8.2 python test/pty/js-tui/screen_grid.py（早期故意坏布局）
RED: 先因 Linux PTY EIO暴露 harness EOF缺陷；修正后精确失败为 80列首行 `RIGHT-EDGE not found`，证明 screen-grid oracle可抓布局溢出。

bun test test/patch/tui/model.test.mjs test/patch/tui/controller.test.mjs
RED: 2 个 ModuleNotFoundError；实现后又精确暴露跨字段 filter整段 substring错误，改为 token AND后通过。

bun test test/patch/tui/adapters.test.mjs
RED: production adapter模块不存在；实现双读 probe与正式 write adapter后通过。

bun test test/patch/tui/controller.test.mjs
RED: 写成功后 reprobe failure被无条件 done覆盖；修复后新增组合路径再次 RED，证明 write severity 3 + reprobe severity 1会丢失前者；合并跨阶段错误、保护初始 probe error后全部通过。

bun test test/patch/tui
14 pass, 0 fail, 42 expect() calls, 4 files。

bun test test/patch/tui/pty.test.mjs --timeout 45000 --rerun-each 3
6 pass, 0 fail, 12 expect() calls；每轮都包含故意坏布局正样本与 production 6场景 PTY suite。

bun test test/patch/cli.test.mjs
16 pass, 0 fail；bare TTY真 Ink启动/q退出，显式 status与 non-TTY路径无回归。

get_errors Task 3.9 production/tests
No errors found
```

真实 PTY与验收覆盖：

- controlling PTY + pyte screen grid验证80/100/120列右缘 sentinel、两组 binary、feature states、progress与summary各自唯一可见且不重叠。
- 覆盖filter模态、path/feature多 token、隐藏选择、space、可见 `a`、unsupported无写trace、channels依赖闭包、mixed replay、双Enter/忙态q防护、写后reprobe、第二次提交、多 binary正式错误留屏、`q`/`Esc`。
- 退出后逐项比较 `ICANON`、`ECHO`、`ISIG`、`IEXTEN`、`IXON`、`ICRNL`、`VMIN`、`VTIME`，并要求输出包含 alternate-screen `1049h/1049l` 与 cursor `25h`恢复序列。
- 独立 verifier额外以不同 adapter验证：write+reprobe错误跨阶段最高severity、初始probe error后Enter、APPLYING/REFRESHING中的q/Esc、refresh失败generation与旧badge，最终 PASS，0 blocker、0 major。

独立 reviewer第一轮发现 1 major：TUI正式错误未传播process exit；独立 verifier发现 1 blocker：写成功后reprobe failure被done覆盖。两项修复后，第二轮共同发现write error + reprobe error组合路径会覆盖前者并降低severity；新增持久回归并合并错误。最终 verifier复验 PASS，剩余0 blocker、0 major。

完整 Bun回归最终在无共享PTY、带真实 Bun `1.3.14` 与 Node `24.16.0` PATH的 systemd transient unit中执行：`418 pass / 0 fail / 35741 expect()`，覆盖63 files，unit `Result=success`、`ExecMainStatus=0`。此前一次前台全套被外部 `Ctrl-C`中断，不计结果；第一次隔离unit的`415 pass / 1 fail`唯一失败为精简PATH缺少字面`node`导致`ENOENT`，第二次误走Volta shim在测试前exit 126，均修正运行环境后由最终全绿关闭。

### Task 4.6：双 TUI 共同 PTY 行为验收

状态：完成。JavaScript Ink 与 Python Textual 两套 production TUI 已由同一真实 PTY harness 驱动并达到相同行为结果；未写 live binary，未创建 commit。

变更与验收文件：

- `test/pty/dual_tui_driver.py`
- `test/pty/normalizer.py`
- `test/pty/scenarios.json`
- `test/pty/test_dual_tui.py`
- `docs/dual-implementation-progress.md`

共同 oracle：

- 每个 scenario 从同一 frozen clean、unsupported 或 replay-valid mixed fixture 开始；JavaScript 与 Python 分别使用独立 HOME，但共享相同临时 store 语义。
- harness 通过 controlling PTY 与 pyte 解释真实屏幕，使用相同按键序列驱动两套 production 入口：`bun cli.mjs cc` 与 `uv run --directory python/cc-patch ccpatch`。
- 场景覆盖 filter、space、只切可见项的 `a`、unsupported disabled、channels 依赖闭包、执行后 reprobe、第二次执行与 mixed replay。
- 每套 TUI 执行后都分别由 JavaScript 与 Python 公开 status probe 检查，要求两个实现看到相同 feature states；随后比较双方完整最终 state 与 store 文件树的相对路径、size 和 SHA-256。
- 80/100/120 列分别验证 `q` 与 `Esc` 退出，并逐项比较 `ICANON`、`ECHO`、`ISIG`、`IEXTEN`、`IXON`、`ICRNL`、`VMIN` 与 `VTIME`，要求终端状态恢复。
- `bad-oracle-control` 使用不存在的 feature，必须由同一 screen oracle 报错，证明共同 harness 不会把空屏或未启动进程误判为成功。

首次共同验收：

```text
uv run --with pytest --with pyte pytest -q test/pty/test_dual_tui.py
3 passed, 16 subtests passed in 34.57s
```

时序稳定性验收按 PTY 测试纪律连续运行 8 轮，每轮都包含 3 tests 与 16 subtests：

```text
run 01: 3 passed, 16 subtests passed in 34.36s
run 02: 3 passed, 16 subtests passed in 33.86s
run 03: 3 passed, 16 subtests passed in 34.88s
run 04: 3 passed, 16 subtests passed in 35.59s
run 05: 3 passed, 16 subtests passed in 35.38s
run 06: 3 passed, 16 subtests passed in 35.55s
run 07: 3 passed, 16 subtests passed in 34.93s
run 08: 3 passed, 16 subtests passed in 34.53s
```

累计为 24 tests、128 subtests，0 fail。单次绿不作为时序确定性证据；以上八轮全部自然结束后才标记本 Task 完成。

### Task 4.7：全套发布矩阵与独立审查

状态：完成。首次独立verifier判定FAIL并发现四个false-green接缝，均以持久测试与contract修复关闭；merged reviewer复核后确认0 blocker、0 major。

关闭的问题：

- `platform-writes-v1.json`不再把Linux transaction和公开CLI写成未实现；Linux gate在临时副本或具备matching clean baseline的目标上enabled，Windows/macOS仍按证据禁用。
- `PUBLIC_CLI_BOUNDARIES`由`future`改为`available`，contract测试锁定。
- `baseline-replay.test.mjs`改为通过真实`unbun cc`与`ccpatch`公开入口驱动双向baseline、mixed修复与same-version different-build拒绝，不再绕过CLI。
- 新增`public-store-assets.test.mjs`，通过公开CLI覆盖双向snapshot save/list/restore/rm和force activation；底层adapter corpus继续保留invalid/orphan/lock细节。
- runtime oracle在真实clean 2.1.214临时副本上完成patch行为后，使用同一公开CLI执行revert all，要求逐字节恢复并再次观察enum schema与无gpt子请求。
- 共同PTY harness增加真实overflowing Ink fixture和右缘screen-grid assertion，不再只用不存在feature的语义错误充当positive control。
- JS CLI拒绝`--all`与`--feature`冲突；transaction主体错误不再被finally中的lock release错误覆盖。

最终发布矩阵：

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

get_errors /home/xp/src/unbun
No errors found
```

第一代四个JavaScript测试文件按`generation-one-retirement.md`逐项映射后退役，因此Bun数量从归档前422调整为394；known-bad vector仍执行归档实现，production无archive引用。

## Phase 5

状态：全部完成。Task 5.3已获用户显式删除授权并通过删除后回归；仓库commit仍需用户另行授权。

### Task 5.1：更新live文档与安装说明

状态：完成。

- README、INSTALL、ARCHITECTURE、spec、exact-replay findings、Python README与deferred backlog已同步到独立仓库和双实现production现状。
- README不再宣称`.bak + @clack`第一代是当前写路径；快速上手不再使用`tools/unbun`路径。
- 文档化的两套help与临时fixture status命令已实际运行，status不创建store。
- 18份Markdown相对文件链接检查通过；编辑器诊断无错误。

### Task 5.2：旧入口一个发布周期的转发

状态：完成。

- `~/.claude/scripts/ccpatch`改为deprecation shim，转发到`${UNBUN_HOME:-$HOME/src/unbun}/python/cc-patch`。
- `--help`与临时synthetic只读status验证argv、stdout、stderr、exit和`UNBUN_CC_STORE`透传；只读status不创建store。

### Task 5.3：删除Python旧源码副本

状态：完成。用户在核对删除范围后显式选择“删除三个旧目录”。

- 删除`~/.claude/scripts/cc-patch`、`~/.claude/scripts/agent-patch`、`~/.claude/scripts/channels-patch`，逐一路径确认不存在；删除前分别有39、2、3个实际文件，原仓库相关跟踪路径总计53。
- 保留并验证`~/.claude/scripts/ccpatch`deprecation shim；删除后`--help`仍启动独立仓库Python实现。
- 原`~/.claude` Git history仍可通过`git log --all -- scripts/...`追溯，`docs/cc-patch`历史文档未删除。
- 独立仓库production代码对三个旧路径零引用；`SOURCE_BASELINE.sha256`和golden README中的源路径仅作历史provenance，刻意保留。
- 删除后重新运行Bun完整套件394/394与Python完整套件371/371，全部通过。

### Task 5.4：退役第一代JavaScript实现

状态：完成，采用归档而非丢弃。

- 四个第一代源码移入`archive/generation-one-patch/`，附不可运行说明。
- known-bad positive controls更新import并继续真实执行归档代码。
- 四个已被新suite取代的第一代测试按映射删除；`bun test test/contract/vector-integrity.test.mjs test/patch`为173 pass。
- production源码扫描确认无archive引用。

### Task 5.5：最终验收与回滚点

状态：验收、删除后回归与回滚摘要完成；用户授权commit仍待决定。

- 规格验收矩阵写入`dual-implementation-acceptance.md`。
- merged reviewer最终0 blocker、0 major；独立verifier最初FAIL提出的四项接缝均关闭。
- 删除后final verifier又发现Python compatibility测试污染包内backups、两处production注释仍写旧`tools/unbun/archive`路径、ARCH仍记录422。已隔离`atomicio.BACKUP_DIR`到`tmp_path`、清理39个5-byte未跟踪artifact、连续两次Python全套371/371并断言目录为空；注释改为当前archive路径，ARCH数字改为394。
- 仓库仍无首个commit；没有擅自提交或清理用户index。回滚边界仍由本ledger的逐Task文件清单与测试结果定义。
- 最终测试隔离修复后，排除本ledger自身的正式文件内容聚合SHA-256为`47aa0b9a0900daec9749964533762b215be6c03c731e79ad2205494c35aa3daf`；`git status --short --untracked-files=all | sort`聚合SHA-256为`3581153face37898fc5f15a19bfebef667db68ea9aed93852415cdb3c44db93c`。这些hash记录的是未提交working tree发布点，不替代未来commit identity。
