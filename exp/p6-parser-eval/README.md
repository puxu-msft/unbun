# P6 spike — 换 acorn → 更快解析器？评估结论：**保 acorn**

`split` 的绝对主导耗时是 `splitModules` 用 acorn 全解析 19MB app 源（~3s），也是测试套件 ~29s 的真凶。本 spike 评估用更快的解析器（`Bun.Transpiler` / `oxc-parser` / `@swc/core`）替代 acorn 拿模块边界。

**结论：没有可行候选更快——保 acorn。** 真正理由不是「纯 JS 永胜 Rust」，而是两条对本工具的硬约束：oxc 默认 eager 路端到端比 acorn 更慢（访问 `.program` 触发整棵 ESTree 物化），而唯一能绕开它的 lazy/raw-transfer 剪枝路**在 Bun 上直接抛错不可用**、且即便在 node 上也暴露 native 非 ESTree AST（要重写整个识别层）。详见下。

## 复现

```bash
bun dump-app.mjs      # 抽真 claude SFX 的入口 app → /tmp/unbun-app.js（19.2MB）
bun eval.mjs          # 只跑 acorn 基线（oxc 未装则优雅跳过）
```

要跑 oxc 对比数字，**别在本目录直接 `bun add oxc-parser`**——那会把 oxc 写进项目 `package.json`/`bun.lock`（评估结论是不换、故意保持项目 deps 无 oxc）。在**隔离临时目录**装了再跑，或用 `bun --no-install` / `bun add --no-save`：

```bash
mkdir -p /tmp/oxc-eval && cd /tmp/oxc-eval && bun add oxc-parser
cp /home/xp/src/neighbors/tools/unbun/exp/p6-parser-eval/eval.mjs .   # acorn 经父级 node_modules 解析
bun eval.mjs
```


## 各候选评估（真 claude 2.1.205，app=19.2MB，Bun 1.3.14）

| 候选 | 能拿到 split 需要的 4 项？* | 端到端耗时（解析 + 消费 AST 拿全部模块） | 判定 |
|---|---|---|---|
| **acorn**（现状，纯 JS） | ✅ 全部 | **~2.6–3.1s** | 基线 |
| `Bun.Transpiler.scan` | ❌ 只给 imports/exports，无 AST、无顶层 var-decl 结构、**无字节区间** | ~1.0s（但拿不到模块边界） | **不可行**：能力不足 |
| `oxc-parser` 0.139（Rust napi） | ✅ ESTree AST、`start`/`end` 字节区间齐全 | **~4.3–4.8s** | **不采纳**：正确但更慢 |
| `@swc/core` 1.15（Rust napi） | AST 有，但 `parseSync` 对 19MB 文件 **Rust 端 panic**（miette 格式化崩），且返回全量 serde-JSON AST（物化更重） | —（崩溃） | **不可行**：崩溃 + 更重 |

\* split 需要的 4 项：① 定位外层 `(function(exports,…){…})` IIFE ② 遍历其 body 顶层 `var X=helper(…)` var-decl ③ 按 helper 签名 + callback arity 识别两族 helper ④ 拿每模块 declarator 的 `[start,end]` 字节区间。

## 关键发现

**1. oxc 的 AST 与 acorn 逐模块字节完全一致（0 mismatch / 6183 模块）。** 正确性无虞：同样识别到 6183 模块、同样两族 helper（esm=`b`/cjs=`K`），每个 declarator 的 `start`/`end` 逐字节相等，oxc 切出的模块能被 acorn 独立重解析。唯一 AST 差异是 oxc 默认 `preserveParens:true`（外层裸 `(function…)` 被包成 `ParenthesizedExpression` 节点，acorn 直接透明），`unwrap` 多认一层即可。

**2. oxc 默认（eager）路端到端更慢（~4.5s vs ~3s），根因是访问 `.program` 触发的整棵 ESTree eager 物化。** 逐段插桩测时（Bun 1.3.14）：

- `oxc.parseSync(...)` **返回**：~0.8–1.1s（Rust 解析真的快，此时 AST 尚未物化进 JS）。
- **访问 `result.program`**：**~3.3s**——这一步一次性 **eager 反序列化整棵 ESTree**（含数百万个深层 module body 节点，不是「触碰某个数组」），是全部成本所在。
- 之后触碰顶层 30204 元素语句数组 + 读 split 需要的浅层字段（`start`/`end`/`id.name`/callee/arity）：合计仅 **~23–45ms**（物化后极廉价）。
- 换 `range:false`（默认）省下 ~1s（不建 `range` 字段），仍 ~4.5s。
- 用标准（非 raw-transfer）`Visitor` 走查已 eager 物化的 `.program`：~4.1s（含那 ~3.3s eager 物化 + 全树走查；**这不是 raw-transfer**，见发现 3）。

**3. 唯一能绕开 eager 全量物化的 lazy/raw-transfer 剪枝路——`experimentalLazy`/`experimentalRawTransfer`/`experimentalGetLazyVisitor`——在 Bun 上根本不可用（直接抛错）。** 实测 Bun 1.3.14：`oxc.rawTransferSupported() === false`，上述三个入口一调即抛：

  > `experimentalRawTransfer` and `experimentalLazy` options are not supported on 32-bit or big-endian systems, versions of NodeJS prior to v22.0.0, versions of Deno prior to v2.0.0, or **other runtimes**

  Bun 属「other runtimes」。而 unbun 是 **Bun 运行时**的工具——这条路对它是死的。（注：split 其实**只需顶层骨架、从不消费 module body**，故「必须在 JS 侧消费整棵 AST」这个前提对 split 并不成立；理论上剪枝 lazy 走查能只碰顶层——但那条路在 Bun 上不可用，见下。）

**4. 即便在 node 上 lazy 路可用（快），它暴露的是 oxc 原生 AST（非 ESTree），采用 = 按另一套 schema 重写 split 整个识别层。** 实测 node v24.16.0（`rawTransferSupported() === true`）：`parseSync({experimentalLazy:true})` 返回 ~0.66s、lazy 顶层遍历 ~4–47ms（确实快）——但拿到的外层函数节点是 oxc **native** 形状而非 ESTree：`params.type === 'FormalParameters'`（不是数组）、首参在 `.items[0].pattern.name`（不是 `.params[0].name`）、body/语句容器键也与 ESTree 不同。split 的识别层（`unwrap`/`findOuter`/`discover`/切模块）全按 ESTree 形状写；改用 native lazy schema = 把整层按另一套 AST 重写，远超「换个解析器」的范畴，且徒增一条 Bun-不可用的运行时依赖。

## 未采纳选项及原因（record-not-adopted）

- **`Bun.Transpiler.scan`**：唯一「零加载成本、~1s」的候选，但只吐 imports/exports，拿不到顶层 var-decl 结构与字节区间——**能力不足**，无法切模块。
- **`oxc-parser`（默认 eager 路）**：AST 正确、byte-identical，但访问 `.program` 触发整棵 ESTree eager 物化 ~3.3s，端到端 ~4.5s > acorn ~3s——**换了会让 split 更慢**，违背 spike 目标。
- **`oxc-parser`（lazy/raw-transfer 剪枝路）**：本可只碰顶层、绕开 eager 物化，但 ① **在 Bun 上直接抛错不可用**（unbun 是 Bun 工具）；② 即便在 node 上也暴露 native 非 ESTree AST，采用要重写整个识别层——**双重不可行**。
- **`@swc/core`**：19MB 文件 Rust 端 panic + serde-JSON 全量 AST 物化更重——**不可行**。

## 顺带记录的未决风险（若将来仍想换）

- **oxc 字节偏移的 UTF-16 语义未被本 app 检验**：真 claude 2.1.205 的 app **零非 ASCII 字节**（byteLen == strLen），故「oxc 偏移 == acorn 的 UTF-16 码元偏移」这一相等在本输入上是**平凡成立**、未真正区分 UTF-8 vs UTF-16。若将来某 SFX 的 app 含非 ASCII（emoji/Unicode 串），换 oxc 前必须先用合成非 ASCII 输入显式验证 oxc 偏移的码元语义——`split.mjs` 的 `app.slice(start,end)` 是 UTF-16 码元语义。
- acorn 在测试中还兼任**独立重解析 oracle**（`split.test.mjs` / `cli-split.test.mjs` / `double-magic.test.mjs` / `module-graph.test.mjs`）。即便将来 split 换解析器，这些 oracle 应保留一个**不同**的解析器以守 self-consistent-needs-independent-oracle。
