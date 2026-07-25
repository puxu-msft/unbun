# unbun — deferred backlog

本文追踪 `unbun` 里已知但尚未做的改进项。它们不影响当前正确性与验收，但长期值得做（正确性韧性 / 性能 / 可观测性 / 可维护性）。每条给「现状」+「方向」，实现前回读 [`FINDINGS-phase0.md`](FINDINGS-phase0.md) 与 [`ARCHITECTURE.md`](ARCHITECTURE.md) 对齐字节级事实。

> 归档策略：这些是 durable 追踪项，故落常驻文档而非 gitignored ledger。做掉一条即从本表移除并回写对应活文档（ARCHITECTURE / CHANGELOG / 该 lib 注释）。
>
> **进度**：原表 A1–A9（E1–E8 增强批次：单读贯穿 / ELF·strtab 守卫 / outdir 命名统一 / asset 去重 / 内容哈希身份 / 并发写 + layout 烟测 / strings·beautify 并行 / fixture 缓存共享；A9：fixture 缓存 mtime 淘汰）**已全部实现合入**，机制已回写 [`ARCHITECTURE.md`](ARCHITECTURE.md)、从本表移除。两条 perf spike 也已收口：**P4（按需读）已实现**（mmap 主 + pread 回落），**P6（换解析器）已评估**（保 acorn），二者作现状记录保留在下方（含实测结论与未决可选项）。

## CC-P1 — Windows 真实 runtime 与写路径验收

- **现状**：PE32+结构解析、exact replay与JS/Python交叉fixture已通过；production代码已存在，但没有真实Windows Bun/Claude runtime、binary-in-use和文件替换行为证据。
- **完成条件**：在Windows主机上运行公开CLI双向baseline/snapshot/lock矩阵、真实clean Claude临时副本agent-model oracle、revert-all逐字节恢复和binary-in-use quarantine；通过后才把platform gate从`disabled-pending-runtime`改为`enabled`。

## CC-P2 — macOS真实codesign equivalence

- **现状**：thin Mach-O parser与合成signature normalization跨实现一致；Linux环境无法执行真实`codesign --remove-signature`与`codesign -s -`。
- **完成条件**：在macOS上对同一clean Claude临时副本建立原始签名/ad-hoc重签名归一化等价、patch/revert、codesign failure rollback与双实现交替证据；通过前production gate保持`disabled-not-proven`。

## CC-P3 — channels与source-exec独立行为证据

- **现状**：真实Claude临时副本已经证明`agent-model`不依赖`source-exec`。`channels -> source-exec`仍按保守contract保留，但其必要性尚无同等级真实channel注册行为oracle。
- **方向**：使用隔离的channel endpoint与clean Claude临时副本，分别比较channels-only与channels+source-exec的能力注册和消息流；不得连接或重启当前正在使用的服务实例。

## CC-P4 — 真实大小binary的完整交替smoke

- **现状**：windowed probe在clean 2.1.214与patched 2.1.217上做了双实现只读差分；真实2.1.214临时副本完成agent-model patch/runtime/revert。完整channels→agent-model→移除channels→revert-all交替矩阵使用独立frozen synthetic fixture。
- **方向**：获得可安全复制的当前clean Claude build后，在临时副本与临时store上运行完整公开CLI交替矩阵，同时记录墙钟、RSS与原件hash不变。该项是更强的真实体量smoke，不替代现有deterministic vectors。

## P4 — 定点/按需读替代 257MB 全量常驻（perf spike）— **已实现：mmap 主 + pread 回落**

- **现状（已解决）**：`readBinary` 曾用 `readFileSync` 把整块 257MB 全读进 Buffer 常驻整个进程。现已改成 **on-demand `BinaryReader`**（commit `dc87011` pread → `4293e0c` mmap 混合）：默认 `Bun.mmap` 零拷贝 Buffer 视图（惰性分页、OS 按需换页），映射运行中可执行文件失败（`ETXTBSY`）时回落到 `pread`（`openSync` + 定点读）。两后端同接口、下游零改。fail-loud 自证全保（ELF magic/ELFCLASS64、strtab 越界、pread 越界硬 throw、close 后用抛 used-after-close）。
- **实测结论（订正早前乐观估计）**：常驻内存 **~86MB**（`layout` 86 / `extract` 233MB，后者峰值由 esbuild beautify 18MB app 主导）vs 原始全读 **293MB**。**早前「→18/5/~0MB」是误读**：`layout` 仍需 pread `.bun` 尾窗 + 记录 + version 锚需 pread 整个 18MB 入口 blob（位置不定、无法只读头），故落在 ~86MB 而非 ~0。mmap 与 pread 内存**持平**——「不常驻 257MB」的大头收益 pread 与 mmap 都拿到了；mmap 相对 pread 的增量价值是**代码更简**（零拷贝视图、无短读 syscall 循环、无双缓冲），非进一步省内存。
- **剩余可选项（backlog）**：`extract` 峰值仍由 esbuild beautify 全量物化 18MB app 主导，若要再压需流式/惰性 beautify（独立项，超出 reader 范畴）。

## P6 — 换 acorn → 更快解析器（split 的不可约 CPU，perf spike）— **已评估：保 acorn**

- **现状**：`splitModules` 用 acorn 解析 19MB app 源耗 ~3s，是 `split` 命令绝对主导耗时，也是整个测试套件 ~29s 的真凶（E8=A8 已证：全解析不可约、非 I/O）。acorn 是纯 JS 解析器，对这种体量的单文件解析先天慢。
- **评估结论（2026-07-10 spike，完整过程 + 复现 → [`../exp/p6-parser-eval/`](../exp/p6-parser-eval/README.md)）：没有更快的可行候选，保 acorn。** 真正理由（非「纯 JS 永胜 Rust」）是两条对本工具的硬约束：
  - `oxc-parser` 0.139（默认 eager 路）：AST 与 acorn **逐模块字节完全一致**（0 mismatch / 6183 模块、同两族 helper、切片可重解析），但端到端 **~4.5s > acorn ~3s**。逐段插桩定位：`parseSync` 返回 ~0.8–1.1s（Rust 解析快），成本全在**访问 `.program` 这一步 ~3.3s——它一次性 eager 反序列化整棵 ESTree**（含数百万深层 module body 节点），之后触碰顶层数组 + 读 split 需要的浅层字段仅 ~23–45ms。正确但更慢，**不采纳**。
  - `oxc-parser`（lazy/raw-transfer 剪枝路）：split **只需顶层骨架、从不消费 module body**，理论上剪枝 lazy 走查能只碰顶层、绕开 eager 物化——但 ① 实测 Bun 1.3.14 `rawTransferSupported()===false`，`experimentalLazy`/`experimentalRawTransfer`/`experimentalGetLazyVisitor` **一调即抛**（"…or other runtimes"），unbun 是 **Bun 工具**故此路不可用；② 即便在 node v24（`rawTransferSupported()===true`、lazy 顶层遍历 ~4–47ms）也暴露 oxc **native AST（非 ESTree）**（顶层函数 `params.type==='FormalParameters'`、首参在 `.items[0].pattern.name`、语句容器键也不同），采用 = 把 split 识别层整个按另一套 schema 重写。**双重不可行。**
  - `Bun.Transpiler.scan`：~1s 但只吐 imports/exports，**无 AST、无字节区间**——能力不足，**不可行**。
  - `@swc/core` 1.15：19MB 文件 Rust 端 **panic** + serde-JSON 全量 AST 更重——**不可行**。
  - 未决风险（若将来仍想换）：真 claude app 零非 ASCII 字节 → oxc 偏移的 **UTF-16 语义未被检验**（本输入上平凡成立）；换前须用合成非 ASCII 输入验证 oxc 偏移是码元语义（`app.slice` 是 UTF-16）。且 acorn 在测试中兼任独立重解析 oracle，换 split 解析器时这些 oracle 应保留一个不同解析器（self-consistent-needs-independent-oracle）。
