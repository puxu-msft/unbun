# unbun 代码评审（分层次 · 文档驱动 · 可接续）

> 本目录是对 unbun 独立仓库首次系统性 review 的**主索引 + 计划 + 状态跟踪**。评审采用「先宏观后微观」分层推进，每层结论落成独立文档；主会话负责协调与汇总，分派出去的 agent 也把发现写回对应层文档，任何人可据此接续或再分派。
>
> 评审对象快照（起点）：首次建档中途的独立仓库（`git` 尚无 commit），源码约 10k 行（JS 4072 + JSX 116 + Python 4423），双语言并行补丁管理器 + 通用 Bun SFX 静态分析工具。
> **本轮已完成**：五层评审全部结束，5 Blocker + 21 Major 已修并验证，仓库现有 23 个语义 commit。总结论见文末[总报告](#全仓库-review-总报告)。

## 一、评审分层与推进节奏

「先宏观后微观、依次执行」：每完成一层，回到主会话汇总并向用户复盘，再进入下一层。上层结论（尤其是被否证的架构假设）会约束下层的评审重点。

| 层 | 主题 | 关注点 | 产出文档 | 状态 |
|---|---|---|---|---|
| **L0** | 结构与仓库卫生 | 目录布置、git 状态、记忆失效、命名一致性 | [L0-structure-hygiene.md](L0-structure-hygiene.md) | ✅ 已完成 |
| **L1** | 宏观架构评审 | 架构自洽性、文档间一致性（doc↔doc）、文档-代码对账（doc↔code） | [L1-macro-architecture.md](L1-macro-architecture.md) | ✅ 已完成 |
| **L2** | 契约与互操作 | contract schemas/vectors/golden 是否名副其实、双实现是否**真等价**（假绿检测） | [L2-contract-interop.md](L2-contract-interop.md) | ✅ 已完成 |
| **L3** | 微观代码 | JS 解析层 / JS 补丁器 / Python 实现 逐模块正确性 + 测试有效性 | [L3-micro-js.md](L3-micro-js.md) · [L3-micro-python.md](L3-micro-python.md) | ✅ 已完成 |
| **L4** | 合并态与安全边界 | static/runtime/mutate 三分是否守住、原子写/lock/codesign、集成缝、总汇总 | [L4-merged-safety.md](L4-merged-safety.md) | ✅ 已完成 |
| **L5** | 探测性能与窗口化正确性 | `cc` 加载慢的根因排查；单站点守卫掩盖的两个正确性缺陷 | [L5-probe-performance.md](L5-probe-performance.md) | ✅ 已完成 |

推进原则：
- **宏观先行**：L1 先确认架构与文档自洽，避免在错误的心智模型上做微观评审。
- **假绿优先**：L2 用 `catching-false-green-tests` / `verifying-authoritative-claims` 视角，独立判定「双实现等价」「测试有效」等权威声明，绝不轻信自报或同源 roundtrip。
- **跨模型对抗**：微观层（L3）优先用异构 reviewer（GPT soul 评 Claude 侧、或反之），规避同模型盲区。
- **发现回写**：每个分派出去的 agent 都把结构化发现写进对应层文档的「发现清单」表格，主会话只做汇总与裁决。

## 二、发现严重度分级

| 级别 | 含义 | 处置 |
|---|---|---|
| 🔴 Blocker | 正确性/数据安全/架构自洽性受损，或会导致破坏性误操作 | 必须修复后才能推进对应发布 gate |
| 🟠 Major | 明显缺陷、契约不一致、测试假绿、文档与代码矛盾 | 应在收尾前修复 |
| 🟡 Minor | 卫生问题、可读性、非阻塞的一致性瑕疵 | 记录，择机修复 |
| 🔵 Note | 观察/建议/待确认项，非缺陷 | 供参考或后续讨论 |

每层文档维护一张「发现清单」表：`ID | 级别 | 位置 | 问题 | 建议 | 状态`。ID 用层号前缀（如 `L1-03`）。

## 三、汇总状态（滚动更新）

主会话在每层完成后更新此处计数，作为全局体检表。

| 层 | 🔴 | 🟠 | 🟡 | 🔵 | 小结 |
|---|---|---|---|---|---|
| L0 | 1 | 1 | 1 | 0 | ✅ **全部已解决**：git 首提交状态残缺（Blocker，已建 2 个语义提交）；记忆双失效（Major，已重写并显式作废旧模型） |
| L1 | 1 | 3 | 4 | 3 | ✅ Blocker（平台假 gate）双实现已修并独立验证；L1B-04(cc run 透参)已修；A 档文档漂移 9 项已修。架构心智模型判定可信 |
| L2 | 1 | 5 | 3 | 5 | ✅ **全部已修**：Blocker（golden 未入库）+ Python 契约对齐（schema 全量/catalog 完整冻结/known-bad/SHA/receiver identity）+ runtime-oracle 环境探测 + 计数。等价证据链框架经正向对照证实可信。JS 408/0、Python 404 全绿 |
| L3 | 3 | 16 | 9 | 3 | ✅ 全部已修：裸非 TTY 写盘、unknown variant 误判写盘、fsync 后残留 active baseline、symlink 路径漂移（JS）等 |
| L4 | 1 | 5 | 4 | 4 | ✅ Blocker 与 3 Major 已修；L4-02/06/07 立档为 backlog（需契约层决策） |

## 四、接续与分派约定

- **接续点**：读本 README 的状态表 → 找到第一个未完成层 → 打开该层文档看「发现清单」与「TODO」→ 继续。
- **分派 agent 时**：在派活提示里注明「评审范围 + 目标层文档路径 + 严重度分级 + 要求把发现写进该文档的发现清单表」，并按 `align-values-with-agent` 显式给定用户的评审价值观（长期主义、反 YAGNI 式砍需求、假绿检测、根因优先）。
- **每层收尾**：主会话回写本 README 汇总表，并向用户复盘该层结论后再进入下一层。

---

# 全仓库 Review 总报告

> 单次分层评审，覆盖 L0 结构卫生 → L1 宏观架构 → L2 契约互操作 → L3 微观代码 → L4 合并态与安全边界。
> 全部发现均经主会话**独立复现或验证**后才采信，不以 agent 自报为准。

## 一、总体结论

**这个仓库的架构是可信的，工程纪律扎实；但首轮系统性评审仍挖出 5 个 Blocker，其中 3 个会导致真实的数据丢失或误写。** 这个反差本身是最有价值的结论：一个测试 800+、文档完备、双实现互证的项目，仍然在「本机全绿」的表象下藏着永久性数据丢失路径。

架构层面（L1 双线独立确认）：六条核心不变量自洽——clean baseline 唯一恢复真相源、绝不就地改写 live、baseline 不放 launcher 扫描区、channels 不可逆时拒绝猜造、双实现只经磁盘协议互操作、平台 gate 分层。等价性证据链框架也经正向对照证实可信（翻转 golden 字节→测试立即失败、interop 真 spawn 双语言 CLI、exact-replay 跨语言互证而非同源 roundtrip）。

## 二、五个 Blocker

| # | 缺陷 | 真实后果 | 发现层 |
|---|---|---|---|
| 1 | 平台写 gate 是「假 gate」——disabled 状态只被读成字段、从不拒绝 | Windows/macOS 未证明 codesign 等价却照常写盘，可产出跑不起来的二进制 | L1 |
| 2 | golden/fixture(21) 被 `*.bin` 忽略、从未入库 | 干净 clone 缺契约输入，双侧「全绿」实为依赖开发机残留 | L2 |
| 3 | `ccpatch --binary X`（无子命令、非 TTY）静默 patch 全部 feature | 违反「裸非 TTY 只读」不变量，自动化脚本会意外改写 live 二进制 | L3 |
| 4 | unknown variant 检测只认 `enum([`，未知 schema 在已知之前时误判为 clean | 对 unsupported build 写盘，绕过 audited-variant fail-closed | L3 |
| 5 | 写目标用未解析路径、身份键用 realpath（**JS 与 Python 各犯一次**） | symlink 布局下 patch 打错对象且报 success；pathKey 漂移使 baseline 不可达 → **不可逆的 channels 永久无法回退** | L3(JS) / L4(Python) |

第 5 条最严重，也最能说明分层评审的价值：它在 L3 被发现并修复于 JS 侧，但因 L3 按实现分线，Python 侧原样存活，直到 L4 合并态评审才被抓出。

## 三、三条方法论教训

1. **一侧的 Blocker 默认是两侧的 Blocker，直到另一侧被证否。** 双实现项目里按实现分线评审，会让修复也只落在被评的那一侧。这是 L4-01/03/05 的共同根因。
2. **只有干净 checkout 能证明全绿。** 本机绿只说明「工作树 + 本机残留」可用。本轮两次踩中：golden 未入库、以及精确 pathspec 提交漏掉仓库根的 `cli.mjs`（91 行修复只在工作树）——两次都是本机 450/0、干净副本却失败。
3. **测试名会撒谎，测试会把缺陷固化成契约。** 名为「exactly freezes」的错误码测试改 exit/meaning 仍绿；三处测试分别把「成功事务因释放锁失败而整体失败」「非 TTY 多目标默认全选」「部分 replay 向量合法」固化为期望——修复时必须翻转它们，而不是绕开。

## 四、修复与验证

- **修复**：5 Blocker + 21 Major + 若干 Minor，全部落地并提交（22 个语义 commit）。
- **测试**：JS 408→450、Python 404→455（净增 93），新增测试全部针对具体缺陷的可观察后果，并带反向对照（如防漂移测试经「篡改即失败」验证、absent 占位不得谎报真实站点）。
- **最终验证**：干净 checkout（`git archive HEAD` + `bun install`）下 `sha256sum --check` 全 OK、Python 455 pass、JS 450 pass。
- **诚实边界**：`Ink real PTY proof` 在全量并发下偶发失败（单独连跑 5/5 通过），已立档；L4-02/06/07 需契约层决策，未在收尾阶段单方面拍板。

## 五、发布就绪度

**Linux 写路径**：五个 Blocker 全部闭合，安全边界经实测确认（strace 证实静态命令族从不 execve 目标；三处破坏性写守卫生效；无 shell 注入面）。具备就绪度。

**Windows/macOS**：保持 gate 禁用是正确的——真实 runtime 与 codesign 等价性仍未证明，本轮也未验证。gate 现已 fail-closed 且保护范围写入契约。

**遗留**：L4-02（边界输入的跨实现语义分歧，6/7 组发散）是下一轮最该做的事——它暴露的是差分测试输入空间只覆盖 happy binary，而这些恰是路径打错、目标是目录这类日常输入。
