# L1 — 宏观架构评审

> 层目标：在下钻代码前，确认**架构是否自洽**、**文档之间是否矛盾（doc↔doc）**、**文档声称是否与代码一致（doc↔code）**。避免在错误心智模型上做微观评审。
> 上级索引：[README.md](README.md)。

## 分派线

| 线 | 范围 | 执行者 | 子文档 | 状态 |
|---|---|---|---|---|
| L1-A | doc↔doc 一致性 + 架构自洽性 | reviewer（Claude opus） | [L1-doc-consistency.md](L1-doc-consistency.md) | ✅ |
| L1-B | doc↔code 对账 | gpt-souls:reviewer（GPT，跨模型） | [L1-doc-code.md](L1-doc-code.md) | ✅ |

## 汇总发现清单（主会话归并两条子线）

| ID | 级别 | 位置 | 问题 | 处置 |
|---|---|---|---|---|
| L1B-01 | 🔴 Blocker | JS `transaction.mjs` / Py `orchestrate.py` + `lineage` 两侧 | 平台 gate 是「假 gate」：`production_write_gate` disabled 状态只被读成字段、从不拒绝写；win32/darwin 照常放行。主会话已独立确认。 | ✅ **双实现均已修并独立验证闭合**。意图查明（acceptance:11/63-67：未证明前禁止写 Windows/macOS）。JS：`assertPlatformWriteEnabled`（新码 `platform_write_disabled` exit 1，可注入 matrix seam）接入 `runPatchTransaction`+`restoreSnapshot`，176 pass。Python：镜像 `assert_platform_write_enabled` + `_resolve_write_gate()` 接入 `write_features`+`restore_snapshot`（orchestrate.py:448/512），全量 382 pass。主会话独立探针（非 agent 测试）确认两侧 win32/darwin 写与 restore 均被拒且字节不变、linux 越过 gate。不动冻结契约/golden。 |
| L1B-02 | 🟠 Major | README:3 | 「零 Bun 格式硬编码、版本无关」不成立，格式常量集中在 module-graph.mjs:19-31。 | A 档文档修：改为「集中式 + fail-loud 自证」 |
| L1B-03 | 🟠 Major | ARCHITECTURE:32/38/43 | 依赖 DAG 漏 `layout→extract`、`bun-binary→patch/io/raw-reader`，误画 `split→extract`。 | A 档文档修：拆「静态 import 图 / 命令数据流图」+ 补依赖列 |
| L1B-04 | 🟠 Major | cli.mjs:463-504 | `cc run ... [args...]` 无法透传 `--` 开头参数，无分隔符。 | ✅ **已修**：引入 `--` 分隔符（cli.mjs parseCcFlags 收集 passthrough），回归测试 `test/cc-run-passthrough.test.mjs`（4 单元 + 1 E2E，含无 shell 求值断言）全绿 |
| L1B-05 | 🟡 Minor | README:32-34 | 命令表漏 `cc revert --snapshot`、`cc patch --all`。 | A 档文档修：补命令表 |
| L1A-01 | 🟡 Minor | spec.md:52/85-87 | sourcemap.json 被误列为静态 asset，与 FINDINGS 实测相反。 | A 档文档修：spec 就地删除线/注解 |
| L1A-02 | 🟡 Minor | plan.md:3 | 状态仍「待实施」，实际已完成。 | A 档文档修：更新状态 |
| L1A-03 | 🟡 Minor | generation-one-retirement.md | 通篇未来时，实际退役已完成。 | A 档文档修：改完成时 |
| L1A-04 | 🟡 Minor | acceptance.md:34 | 「live文档同步 PASS」过强，掩盖 L1A-01/02/03。 | A 档文档修：降级措辞或先修三处 |
| L1A-05/06/07 | 🔵 Note | spec/plan/shared-store §14 | helper 计数口径、§14 补全、结构图缺 naming.mjs。 | A 档文档修：随批订正 |
| L1B-06/07/08 | 🔵 已确认无偏差 | — | 接口富字段、feature 依赖可逆性、入口 bin、主命令名 doc↔code 一致。 | 无需处置 |

## 主会话裁决与进入 L2 的前置结论

- **架构心智模型可信**：两条独立线（含跨模型）一致认定六条核心不变量自洽；可在此基础上安全推进微观评审。
- **唯一 Blocker 是实现缺口而非架构缺陷**：L1B-01 平台 gate 未强制。原始意图已查明为「禁止未证明平台写入」，故是代码补 fail-closed，不动架构。
- **L2/L3 重点复核**（承接两线线索）：① 假绿链条——acceptance/progress 的「PASS/proven」是否有真跑非空测试支撑（L2）；② `bun-binary → patch/io/raw-reader` 反向依赖是否把补丁运行时约束漏进通用解析层（L3）；③ 两实现字节变换与 transaction 语义真等价（L3）；④ `unbun assets` 测试未断言 sourcemap.json 可反证 spec 过时（L2）。
- **本轮修复分档**：A 档（纯文档漂移，改法唯一）合并成一个 doc-fix 批次直接改；B 档 L1B-04（`--` 分隔符）用户已授权改代码；B 档 L1B-01（fail-closed gate）待用户定时机。
