# L2 — 契约与互操作评审

> 层目标：判定 `contract/`（schemas / vectors / golden）是否**名副其实**，以及 JS 与 Python 双实现是否**真等价**——用假绿检测视角，不轻信「已通过/已对齐」的自报。
> 上级索引：[README.md](README.md)。前置：L1 宏观结论（架构心智模型是否可信）。

## 分派线

| 线 | 范围 | 执行者 | 子文档 | 状态 |
|---|---|---|---|---|
| L2-A | 假绿检测：独立推导 oracle 证伪「双实现等价」「测试有效」；golden/vectors 是否同源自证、interop 是否真双向 | verifier（Claude，独立证伪） | [L2-false-green.md](L2-false-green.md) | ⏳ |
| L2-B | 契约真消费：10 schemas + 22 vectors + 4 golden 是否 JS 与 Python 都真加载并断言；有无摆设；known-bad 负样本覆盖 | gpt-souls:reviewer（GPT，跨模型） | [L2-contract-consumption.md](L2-contract-consumption.md) | ✅ |


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

> L2-A（假绿检测）与 L2-B（契约真消费）的完整发现分别在 [L2-false-green.md](L2-false-green.md)、[L2-contract-consumption.md](L2-contract-consumption.md)。下表为主会话归并的 L2 汇总。

### L2 总体裁决

- **双实现等价的证据链框架可信**（L2-A 正向对照证实：翻转 golden 字节→5 失败即真消费；interop 真 spawn 双语言 CLI、真双向；exact-replay 跨语言互证非同源 roundtrip）。
- **但两类实质问题**：① 一条被 acceptance 标 PASS 的发布 gate（runtime-oracle）实测不可复现（隐式依赖「已登录 claude」）；② **Python 侧对共享契约的消费系统性弱于 JS 侧**——多处「双实现一致」其实只有 JS 在把关（schema/known-bad/SHA256SUMS/receiver identity）。这是本层核心：等价性在「未被两侧同等强度验证」的地方存在假绿风险。

| ID | 级别 | 位置 | 问题 | 处置 |
|---|---|---|---|---|
| L2B-01 | 🔴 Blocker | `.gitignore` | golden/fixture(21) 被 `*.bin` 忽略未入库，干净 clone 缺文件、双侧假绿依赖本机残留。 | ✅ **已修并验证**（commit `e35bb3b`，精确 negation + `git archive` fresh-checkout `sha256sum` 全 OK） |
| L2A-01 | 🟠 Major → ✅ 已修 | runtime-oracle.test.mjs:142 + acceptance.md:30 | acceptance 标 PASS 的 runtime wire-oracle gate 实测失败，根因真实 claude `Not logged in`（authentication_failed）——gate 隐式依赖未声明的「已登录」前置。发布 gate 可信度问题，非代码等价缺陷。 | ✅ 已修：runtime-oracle.test.mjs 加显式 precondition 探测——fixture 缺失 `test.skipIf` 跳过；未认证（stdout 命中 `authentication_failed`/`Not logged in`）时 warn+skip 而非 fail，但「clean 真跑通却不 advertise」的真实回归仍 fail（不掩盖）。3/3 确定性跳过。acceptance:30 补前置条件声明。 |
| L2B-02 | 🟠 Major → ✅ 已修 | manifests.mjs vs store.py | Python 只 jsonschema 加载 3/10 schema，其余靠手写 validator 或无消费 → schema 加约束时两实现漂移。 | ✅ 已修（Python agent）：`test_contract_consumption.py` 用 Draft202012Validator 加载全部 10 schema 验证 Python 产物 + 每 schema 一个 malformed 负样本。 |
| L2B-03 | 🟠 Major → ✅ 已修 | schema.test.mjs / test_models.py | 「exactly freezes」名不副实：JS 只锁 code 顺序+exit∈[1,2,3]+meaning 非空；Python 只比 code→exit。 | ✅ 已修：JS `schema.test.mjs` 与 Python `test_models.py` 均改为对全部 19 条 `{code,exit_code,meaning}` 完整 deepEqual/==，任何字段改动都 fail。 |
| L2A-02 | 🟡 Minor（确认）→ ✅ 已修 | agent_model.py:202 vs agent-model.mjs:140 | Python `replay_substates` 无 receiver identity 校验、`FeatureSubstate` 无 receiver 字段。 | ✅ 已修（Python agent）：`FeatureSubstate` 加 receiver 字段、observe 采集、replay 校验 receiver mismatch + forged-swap 负测试。主会话独立探针确认三处生效。 |
| L2B-04 | 🟠 Major → ✅ 已修 | vector-integrity vs Python | known-bad 5 语料+manifest 仅 JS 消费。 | ✅ 已修（Python agent）：Python known-bad runner 校验 size/SHA 并证不复现历史缺陷；JS-gen-one 无 Python 类比项已注释来源。 |
| L2B-05 | 🟠 Major → ✅ 已修 | vector-integrity vs test_golden.py | SHA256SUMS 仅 JS 校验；Python 用私有副本不校验共享冻结 hash。 | ✅ 已修（Python agent）：Python 读共享 `SHA256SUMS` 逐项重算校验，并确认私有 `tests/golden/` 与共享 golden 逐字节一致。 |
| L2B-06 | 🟡 Minor → ✅ 已修 | Python 各 vector 测试 | Python 不消费 vector manifest（fixture size/hash 仅 JS 验）。 | ✅ 已修（Python agent）：Python 对 4 个 manifest 逐 fixture 校验 size/SHA256。 |
| L2B-07 | 🟡 Minor → ✅ 已修 | L0 doc | vector 计数口径「22」不清。 | ✅ 已修：L0 doc 改精确口径（4 顶层+14 fixtures+4 manifests）；`contract/README.md` 加机器可核对 Inventory 表 + Python 校验命令。 |
| L2-seed-01 | 🔵 → 并入 L2A-01 | runtime-oracle.test.mjs:8 | 硬编码绝对 fixture 路径 + live 依赖。 | 见 L2A-01。 |
| L2A-03/04/05 | 🔵 Note | golden/interop/known-bad | 正向确认：golden 真消费且来自审计历史、interop 真双向、known-bad JS-only 但历史合理。 | 无需改动，供 L4 引用。 |

