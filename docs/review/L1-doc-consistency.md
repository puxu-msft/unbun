# L1-A — 文档间一致性 + 架构自洽性（doc↔doc）

> 执行者：Claude `reviewer`（双视角：机械对账 + 第一人称执行者模拟）。范围只做文档间一致性与架构自洽，不做 doc↔code（那是 L1-B）。
> 上级：[L1-macro-architecture.md](L1-macro-architecture.md)。

## 总体判断

**架构心智模型：可信。** 六条核心不变量在所有活文档间一致且自洽，未发现 Blocker/Major：

1. clean baseline 是唯一恢复真相源、绝不写 live、baseline 不放 `versions/`（README:56、shared-store §6.1/§10.1、ARCHITECTURE:24/96、spec:33 一致，且与「channels 不可逆 → channels patched 无 baseline 即拒绝」逻辑闭合）。
2. 三 feature 依赖与可逆性（source-exec 无依赖可逆 / agent-model 无依赖可逆 / channels 依赖 source-exec 不可逆）处处对齐；`agent-model→source-exec` 被 runtime oracle 否证、`channels→source-exec` 保守保留的措辞一致，**无文档残留未标注的被否证旧模型**。
3. 平台 gate（Linux enabled、Windows disabled-pending-runtime、macOS disabled-not-proven）五文档一致。
4. 双实现「不共享核心、只靠 shared store v1 互操作」五处叙述一致。
5. 发布数字（Bun 394 / Python 371 / 归档前 422）三处一致；helper 计数有口径差异但已被 FINDINGS 主动 acknowledge。
6. patch→revert 依赖闭包、channels-patched-无-baseline fail-closed 分支设计自洽。

**最严重问题均为 Minor**：几处历史文档的状态/时态未随实现完成更新，且被 acceptance 的「live 文档同步 PASS」一行掩盖。

## 发现清单

| ID | 级别 | 位置 | 问题 | 建议 | 状态 |
|---|---|---|---|---|---|
| L1A-01 | 🟡 Minor | spec.md §Phase0 P0-a(L52) + 交叉验证 oracle(L85-87) vs FINDINGS-phase0.md P0-e(L122-127) | 字节事实相反：spec 把 `sourcemap.json` 列为可切出的 blob 并列入 `unbun assets` 静态资产；FINDINGS 实测三版 module graph **均无** sourcemap.json 模块（该串落在 `.rodata` 引擎区）。ARCHITECTURE:90 与 FINDINGS 一致。spec L85-87 是命令契约大节内的现在时 oracle 断言，未就地订正，执行者会被误导。 | spec L52/L85-87 就地加删除线/注解，删 sourcemap 引用并指向 FINDINGS P0-e。 | ✅ 已修：在 P0-a、P0-e、assets 契约与交叉验证 oracle 就地加删除线和订正注解，均指向 FINDINGS P0-e。 |
| L1A-02 | 🟡 Minor | dual-implementation-plan.md L3 | 状态行仍「待实施」，但 progress（Phase 0-5 全完成）+ acceptance（PASS）证明已执行完毕。 | 更新为「已完成/已归档」并指向 progress/acceptance。 | ✅ 已修：状态改为「已完成并归档」，并链接 progress 与 acceptance。 |
| L1A-03 | 🟡 Minor | generation-one-retirement.md L3/45/48-52 | 通篇未来时（「删除/归档**前**」「归档时**应**改指向」），实际 `lib/patch-*.mjs` 已删、已移入 `archive/generation-one-patch/`（文件系统已核实）。 | 状态行与措辞改完成时，标注「退役已完成，留作历史核对」。 | ✅ 已修：状态与闸门均改为完成时，记录根级模块已删除、归档及 known-bad import 已完成。 |
| L1A-04 | 🟡 Minor | dual-implementation-acceptance.md L34 | 「live文档同步 PASS」证据仅命令 smoke + 链接检查，无法覆盖语义级过时；实际残留 L1A-01/02/03。属自报绿掩盖文档漂移。 | 降级为「链接与命令 smoke 通过；语义级同步待补订正上述三处」，或先修三处再维持 PASS。 | ✅ 已修：L1A-01/02/03 已在本批次订正，PASS 证据行补入该三项语义级订正。 |
| L1A-05 | 🔵 Note | spec.md/plan.md vs FINDINGS-phase0.md | helper 计数 spec/plan 用 4277/1583，FINDINGS 实测 4563/1620；plan:413 把估计写成「实测」。非硬矛盾（FINDINGS 已 acknowledge）。 | plan 措辞改「spec 阶段估计」或加脚注指向 FINDINGS 实测。 | ✅ 已修：plan 标明 4277/1583 为 spec 阶段估计，并链接 FINDINGS 中 4563/1620 的实测值。 |
| L1A-06 | 🔵 Note | shared-store-format.md §14 vs 他处 | §14 只说 live「channels=patched」，他处说三 feature 全 patched。非矛盾（channels patched 已是拒绝充分条件）。 | §14 补「三 feature 均 patched，channels 不可逆是主因」。 | ✅ 已修：§14 补明三 feature 均为 patched，channels 不可逆是 no-baseline 拒绝的主因。 |
| L1A-07 | 🔵 Note | spec.md lib 结构图 / ARCHITECTURE 分层表 | spec 结构图缺 `naming.mjs`；ARCHITECTURE 通用 SFX 表未覆盖 `lib/patch/io/raw-reader` 等 patch 子层。详略/过时示意，非矛盾。 | spec 补 naming.mjs 或标注以 ARCHITECTURE 为准；ARCHITECTURE 补一句指向 dual-spec §4。 | ✅ 已修：spec 结构图补入 `naming.mjs`，ARCHITECTURE 增加 `dual-implementation-spec.md` §4 的 patch 内部结构指针。 |

## 遗留给 L2/L3 的线索

1. **假绿链条延伸**：acceptance/progress 大量「PASS/proven」依赖自报测试数字，本线只核对文档间一致、未验证测试真跑真非空。L2 重点复核 acceptance L30（runtime-oracle 逐字节恢复）、L22（agent-model 无依赖 wire oracle）是否有真实测试与代码支撑。
2. **channels→source-exec 必要性**：多文档一致标注「保守保留、必要性未独立行为证明」——是已知且一致记录的证据缺口，非矛盾；L3 涉 channels 行为需知此边界未关闭。
3. **exact replay 平台证据分层**：注意 FINDINGS:59 的 `agent_model_dependency=refuted-on-linux-claude` 携带来源限定，不得跨平台放行。
4. **L1A-01 下游**：若 L2/L3 检查 `unbun assets` 实际测试断言，确认其**未**断言 sourcemap.json，可反向佐证 spec 才是过时方、代码已对。
