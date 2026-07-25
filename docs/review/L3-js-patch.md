# L3-B — JS 补丁器（production 写路径）

> 执行者：reviewer（Claude，双视角：机械对账 + 第一人称执行模拟）。范围 `lib/patch/**`。
> 上级：[README.md](README.md)。

## 总体判断

**写路径安全性：7.5/10（修复前）。** 核心 transaction 骨架——baseline-before-binary 顺序、exact-replay 校验、原子写 publish、回读后验、失败回滚、`rollback_failed` 升级、平台 gate fail-closed——**设计正确且有实证支撑**，`bun test` 非假绿。评审确认**没有会静默写坏 live 二进制内容的缺陷**：等长替换、`assertResult` 后验、`concurrent_binary_change` 双检都真实生效。另确认**写目标二进制的入口只有 2 个**（`runPatchTransaction`、`restoreSnapshot`），两者都已被平台 gate 覆盖，无遗漏的第三入口。

扣分来自三类实证确认的问题，均已修复。

## 发现清单

| ID | 级别 | 位置 | 问题 | 处置 |
|---|---|---|---|---|
| L3B-01 | 🔴 Blocker | `cli/context.mjs:8-9` + `transaction/atomic-write.mjs:119` | symlink 安装布局（`bin/claude -> versions/<ver>`，即 `which claude` 的真实形态）下：写目标用 `path.resolve`（不解 symlink）而 pathKey 用 realpath。① 原子 rename 把 symlink 替换成普通文件，真实二进制原封未动却报 success；② 同一路径算出两个 pathKey，baseline 不可达 → 打上不可逆的 channels 后**永久无法回退**。 | ✅ 已修（`da5c513`）：写目标与身份键统一用 canonical 路径；status 也探测实际写入对象。主会话**独立复现了完整数据丢失链条**，修复后验证 symlink 存活、真实文件被改、pathKey 唯一、channels 可逐字节回退。新增 `test/patch/symlink-target.test.mjs`（5 用例）。 |
| L3B-02 | 🟠 Major | `transaction/snapshots.mjs:52-59`；`transaction/transaction.mjs:296-306` | lock release 失败覆盖主体错误：二进制已损坏且回滚失败（`rollback_failed`/exit 2）叠加 release 抛 `target_locked` 后，用户只看到 `target_locked`/exit 1，损坏事实丢失。另一侧，成功事务因 release 失败被整体报失败，调用方误以为没写。 | ✅ 已修：提取共享 `withTargetLock`，失败时 release 错误降为 `releaseError` 诊断、主体错误照常抛；成功时降为结果上的告警。把固化错误行为的旧测试翻转为正确契约，并补主体错误可见性的反向测试。 |
| L3B-03 | 🟠 Major | `targets/claude/channels.mjs:171-180` vs `:261` | `observe_substates` 含 absent 占位、`replay_substates` 不含 → 长度不等必抛 `substate_unreplayable`。缺 optional 站点的 build 会被 `baseline_stale_build` 拒绝，**连无关的 agent-model 都写不进去**；Python 无此限制，属跨实现分歧（L2 未捕获）。 | ✅ 已修：replay 与 observe 同源并支持 absent（对齐 Python `allow_absent`），补 replay **自反性**回归 + 「absent 不得谎报真实站点」反向守卫（`test/patch/channels-absent-sites.test.mjs`）。 |
| L3B-04..10 | 🟡 Minor | atomic-write temp 泄漏、跨设备 quarantine EXDEV、TUI 退出码清零、TUI 取消依赖无反馈、status 缺 `probe_error`、gate 前已写 store、测试固化错误期望 | 详见评审原文。 | 部分随 L3B-02 修复（测试期望翻转）；其余记入 L4 待办与 backlog。 |
| L3B-11 | 🔵 Note | 写路径峰值内存 ≈ 二进制体积 13 倍（250MB 目标实测 31s / 峰值 3.48GB RSS） | spec §9 只约束读路径，写路径未约束；低内存机器/容器有 OOM 风险。 | 非阻断，记入 backlog（附实测基线数据）。 |

## 遗留给 L4 的线索

1. L3B-01 的传导面：status 显示路径、TUI entryDigest、snapshot path_key 在 symlink 布局下的自洽性（已修，L4 复核）；Python `store.py` 用 `path.resolve()`（realpath 语义）与 JS 原 `path.resolve` 不同，是又一处需对账的跨实现差异。
2. L3B-03/L3B-08 是 L2 漏网的跨实现分歧 → L4 应审视 L2 差分测试的**输入空间覆盖度**：现有 interop fixture 都是「站点齐全 + 路径有效」的 happy binary，边界形态未参与差分。
3. 平台 gate 的「提前程度」两侧不一致：JS 在 `runPatchTransaction` 内（store 已写），Python 在 `_get_store()` 之前。需对账「gate 前不落盘」不变式的实际边界。
4. 性能基线（供判断是否升级 L3B-11）：live 257MB 只读探测 2.78s/1.02GB RSS；完整写事务（250MB）31.0s/峰值 3.48GB。
