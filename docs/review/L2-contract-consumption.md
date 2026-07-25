# L2-B — 契约真消费审计

## 总体判断

`contract/` 目前不是可在干净 checkout 中成立的双实现共享协议，结论为**存在 Blocker**。两份被 `SHA256SUMS`、JS 测试和 Python 特征测试引用的 synthetic golden `.bin` 均被 `.gitignore` 的 `*.bin` 排除，且不在 Git 索引中；当前工作树中的残留文件让 `sha256sum --check` 与两侧测试出现假绿，而克隆仓库后核心契约输入会缺失。除此以外，JS 对全部 10 个 JSON Schema 有 Ajv 消费，但 Python 只以 `jsonschema` 加载 3 个 CLI schema，另外 7 个 schema 没有被 Python 加载；known-bad corpus 也只有 JS 真正将其作为正向负样本执行。故不应将当前状态表述为“schemas／vectors／golden 两侧均共同消费”。

已实际执行：`sha256sum --check contract/golden/SHA256SUMS`（本机残留两个 `.bin` 均显示 `OK`）；`bun test test/contract/schema.test.mjs test/contract/vector-integrity.test.mjs`（32 passed）；`bun test test/patch/store/identity.test.mjs test/patch/store/manifests.test.mjs test/patch/store/lineage.test.mjs test/patch/transaction.test.mjs test/patch/platform-gate.test.mjs test/patch/feature-contract.test.mjs`（64 passed）；`uv run pytest -q tests/test_models.py tests/test_store_contract.py tests/test_feature_vectors.py tests/test_lineage.py tests/test_transaction.py tests/test_golden.py tests/test_cli_contract.py tests/test_platform_gate.py`（89 passed）。这些绿色结果只证明当前未跟踪工作树的组合可用，不能推翻 Git 索引缺失 golden 的结论。

## 契约消费矩阵

| 契约文件 | JS 消费者（file:line） | Python 消费者（file:line） | 是否真断言 | 结论 |
|---|---|---|---|---|
| `schemas/target.schema.json` | `lib/patch/store/manifests.mjs:7-28` 编译，`test/patch/store/manifests.test.mjs:45-68` 拒绝坏输入 | `src/cc_patch/store.py:219-298` 手写 validator，`tests/test_store_contract.py:170-220` 断言行为；未加载该 schema 文件 | 两侧均有行为断言，但仅 JS 真消费 JSON Schema | schema 文件仅 JS 消费 |
| `schemas/baseline.schema.json` | 同上，`manifests.mjs:45-53` 生产验证，`manifests.test.mjs:52-61` 负例 | `store.py:260-298` 手写规则，`test_store_contract.py:204-220` 负例；未加载 schema | 两侧均有行为断言，但仅 JS 真消费 JSON Schema | schema 文件仅 JS 消费 |
| `schemas/snapshot.schema.json` | `manifests.mjs:7-28` 编译，`schema.test.mjs:269-286` 正反例 | `store.py:260-298` 手写规则；无 schema 加载 | Python 没有对 JSON Schema 的断言 | 单侧 schema 消费 |
| `schemas/lock-owner.schema.json` | `manifests.mjs:7-28` 编译，`schema.test.mjs:269-321` 正反例 | `store.py:242-249` 手写规则；无 schema 加载 | Python 没有对 JSON Schema 的断言 | 单侧 schema 消费 |
| `schemas/quarantine.schema.json` | `manifests.mjs:7-28` 编译，`schema.test.mjs:269-286` 正反例 | `store.py:250-258` 手写规则，`test_store_contract.py:451-469` 只验证自产物；无 schema 加载 | Python 未以 schema 验证 | 单侧 schema 消费 |
| `schemas/transaction-scenario.schema.json` | `schema.test.mjs:389-394` 以 Ajv 验证 `transaction-v1.json` | 无引用 | JS 真断言 | Python 侧摆设 |
| `schemas/status.schema.json` | `lib/patch/cli/output.mjs:6-20` 生产编译，`test/patch/cli.test.mjs:11-16` 验证输出 | `tests/test_cli_contract.py:19-29、53-66` 以 `Draft202012Validator` 验证 CLI 输出 | 两侧加载并验证 | 双侧消费 |
| `schemas/error.schema.json` | `output.mjs:6-20` 作为嵌套 error schema 注册，`test/patch/cli.test.mjs:12-16` 编译 | `test_cli_contract.py:19-29` 注册并验证引用 | 两侧加载并验证 | 双侧消费 |
| `schemas/write-envelope.schema.json` | `output.mjs:8-20、45-57` 生产验证，`test/patch/cli.test.mjs:13-16` | `test_cli_contract.py:19-29、69-88、220-228` 以 `Draft202012Validator` 验证 | 两侧加载并验证 | 双侧消费 |
| `schemas/exact-replay-result.schema.json` | `test/contract/exact-replay-harness.test.mjs:11、63-67、217-234` Ajv 验证 JS／Python PoC 输出 | 无 Python schema 加载；Python PoC 被 JS harness 调用不等于 Python 侧验证 | 仅 JS 真断言 schema | Python 侧摆设 |
| `vectors/canonical-path-v1.json` | `test/patch/store/identity.test.mjs:10` 加载；实现结果由该测试逐 case 比较 | `tests/test_store_contract.py:23-30、136-144` 逐 case 比较 canonical path 与 hash | 两侧真断言 | 双侧消费 |
| `vectors/transaction-v1.json` | `test/patch/transaction.test.mjs:11-13、68-112` 参数化事务场景 | `tests/test_transaction.py:141-145、155-212` 参数化事务场景 | 两侧真断言 | 双侧消费 |
| `vectors/error-codes-v1.json` | `lib/patch/cli/output.mjs:13-15` 仅允许 catalog 内 code；`schema.test.mjs:325-351` 只锁 code 顺序、数量、exit 范围与非空 meaning | `tests/test_models.py:57-64` 精确比较 `code → exit_code` | 两侧加载；但均未精确冻结完整 `(code, exit_code, meaning)` 列表 | 不满足“exactly freezes” |
| `vectors/platform-writes-v1.json` | `lib/patch/transaction/transaction.mjs:13`、`lib/patch/transaction/snapshots.mjs:16` 生产加载；`test/patch/platform-gate.test.mjs:17-104` 断言禁用平台不写盘 | `src/cc_patch/lineage.py:46-79` 生产加载；`tests/test_platform_gate.py:47-102` 断言 gate 与字节不变 | 两侧真断言 | 双侧消费 |
| `vectors/feature-claude-v1/fixtures/dependency-{input,expected}.json` | `test/patch/feature-contract.test.mjs:9-12、79-83、109-137` | `tests/test_feature_vectors.py:11-18、43-52` | 两侧以 frozen expected 比较 closure | 双侧消费 |
| `vectors/feature-claude-v1/fixtures/source-exec-{input,expected}.json` | `test/patch/source-exec.test.mjs:8` 直接加载并比较 feature 状态 | `tests/test_feature_vectors.py:55-94` | 两侧用预期状态／site 断言 | 双侧消费 |
| `vectors/feature-claude-v1/fixtures/agent-model-{input,expected}.json` | `test/patch/agent-model.test.mjs:8` 直接加载并比较 | `tests/test_feature_vectors.py:97-135` | 两侧用预期状态、site 与 replacement 断言 | 双侧消费 |
| `vectors/feature-claude-v1/fixtures/channels-{input,expected}.json` | `test/patch/channels.test.mjs:11` 直接加载并比较 | `tests/test_feature_vectors.py:142-209` | 两侧用预期 substate／错误语义断言 | 双侧消费 |
| `vectors/feature-claude-v1/manifest.json` | `test/contract/vector-integrity.test.mjs:142-180` 校验 fixture hash、coverage 与目录完整性 | 无引用 | JS 真断言 | Python 未消费 manifest／provenance／fixture hash |
| `vectors/store-v1/fixtures/store-{cases,expected}.json` | `test/patch/store/assets.test.mjs:18-19` 加载并断言 store 行为 | `tests/test_store_contract.py:26-30、197-220、223-259、479-501` | 两侧真断言 | 双侧消费 |
| `vectors/store-v1/manifest.json` | `vector-integrity.test.mjs:142-180` | 无引用 | JS 真断言 | Python 未消费 manifest／fixture hash |
| `vectors/lineage-v1/fixtures/lineage-{cases,expected}.json` | `test/patch/store/lineage.test.mjs:12-15、50-111` | `tests/test_lineage.py:17-22、64-140` | 两侧真断言 | 双侧消费 |
| `vectors/lineage-v1/manifest.json` | `vector-integrity.test.mjs:142-180` | 无引用 | JS 真断言 | Python 未消费 manifest／fixture hash |
| `vectors/known-bad-v1/fixtures/{hardcoded-receiver-s,incorrect-agent-source-dependency,generation-one-binary,channels-missing-essential,desired-observations}` | `test/contract/vector-integrity.test.mjs:206-253` 将 5 个 fixture 对旧 JS generation-one 路径作可执行正向负样本；`test/patch/transaction.test.mjs:217-286` 对新事务路径作部分回归 | 无 `known-bad-v1` 路径引用 | JS 真断言，Python 没有加载 corpus | Python 侧摆设 |
| `vectors/known-bad-v1/manifest.json` | `vector-integrity.test.mjs:206-245` 与 `transaction.test.mjs:13、217-286` | 无引用 | JS 真断言 | Python 未消费 manifest／fixture hash |
| `golden/claude-v1/synthetic-2.1.175-clean.bin` | 多处读取，例如 `test/patch/transaction.test.mjs:11` 与 `test/contract/exact-replay-harness.test.mjs:12` | `tests/test_feature_vectors.py:13、212-223` 读取 contract 路径并比较探测状态 | 两侧读取并做行为断言；但文件未被 Git 跟踪 | 当前工作树双侧消费，仓库产物缺失 |
| `golden/claude-v1/synthetic-2.1.175-all-patched.bin` | `test/contract/exact-replay-harness.test.mjs:13、194` 等读取 | `tests/test_feature_vectors.py:212-223` 读取 contract 路径并比较探测状态 | 两侧读取并做行为断言；但文件未被 Git 跟踪 | 当前工作树双侧消费，仓库产物缺失 |
| `golden/SHA256SUMS` | `test/contract/vector-integrity.test.mjs:183-204` 逐项重算 SHA-256；本次也实际运行 `sha256sum --check` | 无引用 | 仅 JS／shell 真校验 | Python 未做等价完整性校验 |
| `golden/README.md` | `vector-integrity.test.mjs:184-203` 仅检查存在及三段文字 | 无引用 | 非协议行为断言 | Python 未消费；文档不是 executable contract |

## 发现

| ID | 级别 | 位置 | 问题 | 建议 |
|---|---|---|---|---|
| L2B-01 | 🔴 Blocker → ✅ 已修 | `.gitignore:22`；`git ls-files contract/golden` 仅列出 `README.md` 与 `SHA256SUMS` | 两个 frozen golden bytes 被 `*.bin` 忽略且从未纳入提交。`SHA256SUMS` 引用的路径在干净 clone 中不存在；JS 的 `vector-integrity`、事务与 exact-replay 测试，以及 Python 的 `test_feature_vectors` 都依赖这两个未跟踪文件。本机 hash 校验与 185 个相关测试的绿色结果依赖开发机残留，不能证明仓库可复现。 | ✅ 已修（commit `e35bb3b`）：主会话查明爆炸半径更大——`*.bin/*.exe/*.macho` 还误伤 `exp/exact-replay/fixtures/**`(17) 与 `python/cc-patch/tests/golden/*.bin`(2)。加**精确 negation**（仅这三个冻结 fixture 目录、按扩展名）纳入全部 21 个 <3KB fixture，大体积 ephemeral（94MB `mini` 按名忽略、`refs/`）仍忽略。**全新 checkout 验证**：`git archive HEAD` 干净副本里 fixture 齐全、`sha256sum --check contract/golden/SHA256SUMS` 全 OK，不再依赖本机残留。 |
| L2B-02 | 🟠 Major → ✅ 已修（Python 侧） | `python/cc-patch/tests/test_contract_consumption.py` | Python 测试现从 `contract/schemas/` 加载全部 10 个 JSON Schema，以 `Draft202012Validator` 验证实际产出的 store manifest、CLI 输出、transaction vector 与 exact-replay PoC 输出，并为每个 schema 断言 malformed 实例被拒绝。 | 保留 `store.py` 手写 validator 作为额外语义检查；契约 schema 已由 Python 测试真消费。 |
| L2B-03 | 🟠 Major → ✅ 已修（Python 侧） | `python/cc-patch/tests/test_models.py` | Python 以 19 条内联 `{code, exit_code, meaning}` 完整列表与 `error-codes-v1.json` 整体相等比较，并继续验证运行时 `ERROR_EXIT_CODES`。 | JS 侧等价修复由主会话并行处理。 |
| L2B-04 | 🟠 Major → ✅ 已修（Python 侧） | `python/cc-patch/tests/test_contract_consumption.py` | Python 参数化 runner 读取 known-bad manifest 与冻结语料，校验其 hash，并分别验证 receiver、依赖闭包、channels 不可逆、store 隔离与完整性 exit 映射。 | JS generation-one 专属 whole-file revert、adjacent `.bak` 与 catch-all exit 以注释说明来源后，验证 Python 对应正确行为。 |
| L2B-05 | 🟠 Major → ✅ 已修（Python 侧） | `python/cc-patch/tests/test_contract_consumption.py` | Python 读取共享 `golden/SHA256SUMS`，逐项以 `hashlib.sha256` 重算，并显式断言私有 `tests/golden/` 副本与共享 golden 字节一致。 | 冻结 golden 的 hash 与副本一致性均由 Python 真断言。 |
| L2B-06 | 🟡 Minor → ✅ 已修（Python 侧） | `python/cc-patch/tests/test_contract_consumption.py` | Python 遍历 feature、store、lineage、known-bad 四份 manifest 的每个 pinned fixture，逐项断言路径仍在 `contract/`、size 与 SHA-256 匹配。 | Python 已消费 manifest 的 fixture integrity 声明。 |
| L2B-07 | 🟡 Minor | `docs/review/L0-structure-hygiene.md:18` 声称 vectors 为 22；实际 `contract/vectors/` 为 4 个独立 vector、8 个 feature fixture、5 个 known-bad fixture、2 个 lineage fixture、2 个 store fixture，即 21 个 payload fixture，另有 4 个 manifest | 题述与 L0 的“22 vectors”无法由当前目录结构复算，容易让覆盖矩阵漏项或重复计数。Git 历史只有导入 commit `77a0f8a`，没有后续 contract 变更可用于确认这是否是计数漂移。 | 在 `contract/README.md` 维护机器可验证 inventory，明确“payload fixture”和“manifest”的计数口径；用测试枚举而非文档常数断言总数。 |

## 遗留线索

- **已确认的正向负样本**：JS `test/patch/transaction.test.mjs:154-157` 与 Python `tests/test_orchestrate.py:221-253` 均真的断言 channels 已 patched 且无 baseline 时拒绝猜造 clean bytes，并断言目标 bytes 不变。坏 manifest 也在 JS `test/patch/store/manifests.test.mjs:52-68` 和 Python `tests/test_store_contract.py:204-259` 被拒绝；缺口不是“完全没有负测试”，而是 Python 未以相同 frozen schema／known-bad corpus 驱动。
- **平台 vector 已修复为双侧实际生产依赖**：JS `lib/patch/transaction/transaction.mjs:13` 与 Python `src/cc_patch/lineage.py:46-79` 均加载 `platform-writes-v1.json`，且对应测试验证禁用平台不改写 binary。这一项不属于单侧摆设。
- **契约漂移历史无法被现有 Git 证伪**：所有 `contract/**` 均只在初始导入 commit `77a0f8a` 添加，随后只有 review 文档 commit `bd0f233`。没有独立的 contract 更新提交，也没有 Git／CI gate 能强制“契约 payload／schema 改动必须同时触发 Bun 与 pytest 契约 suite”。在修复上述消费缺口后，建议添加该路径触发规则与 fresh-checkout 验证。
- **报告未修改被审查代码或既有文档**；本审计唯一写入文件为 `/home/xp/src/unbun/docs/review/L2-contract-consumption.md`。
