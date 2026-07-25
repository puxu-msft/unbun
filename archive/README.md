# patch-the-claude-binary

> **ARCHIVED**（2026-07-10 归档）— 本文是 `unbun` 工具的**前身探索文档**，已被 [`tools/unbun/`](../) 取代。**现状：部分沿用、部分被证伪。**
> ① 本文探索的能力（提取内嵌 bundle + 美化、二进制无完整性闸、等长 loader-hook 注入只读探针、标准 `bun` 直跑提取物、`bun build --compile` 重打包、dump 内嵌资产）已**升级为版本无关、可测、可组合**的正式实现，迁入 [`../lib/`](../lib) + [`../cli.mjs`](../cli.mjs)（Stage 0-5 全完成）——各归档脚本的具体去向见其头部 `ARCHIVED` banner。
> ② 但本文对**二进制尾部结构**的模型（「其后到 EOF 是 TOC」「最后 48 字节是自引用 footer 指针」）经实测**被证伪**：真 `StandaloneModuleGraph`（`Offsets` 头 + 52 字节定长记录）落在 `.bun` section 内、`---- Bun! ----` trailer **之前**（不到 EOF），那 48 字节实为 ELF section header table。权威事实见 [`../docs/FINDINGS-phase0.md`](../docs/FINDINGS-phase0.md)、当前设计见 [`../docs/spec.md`](../docs/spec.md)。
> **正文保留作历史，未重写**；被证伪句已加删除线并就地注解。

已知：
1. `extract-bundle.mjs` 能把 claude 二进制里的 js 逆向提取出来（见 `refs/claude-code-<ver>/app.js`）。
2. `tools/channels-patch/patch.py` 证明修改二进制不会被任何完整性闸拦下（没有哈希、没有签名、没有完整性校验），但它是不改变文件长度的。

**问题**：能不能修改二进制，注入逻辑、或让它直接执行一份外部提供的 bundle js?

**结论：能。**

## 二进制结构分析（claude 2.1.191）

`claude` 是 **Bun 单文件编译产物**（`bun build --compile`），229MB ELF x86-64, not stripped。ELF section 表里有 `.bun`、`.bun_err`、`__DATA,__jsc_opcodes`、`__DATA,__wtf_config`（JavaScriptCore = Bun 引擎）。整个 app 被打包成**一段连续的 CommonJS 模块**，落在二进制靠尾部，wrapper 形如：

```js
// @bun @source__ @bun-cjs
(function(exports, require, module, __filename, __dirname){ …整个 app… ; Sfm();})
```

注意末尾是 `})` 而非 `})()` —— 这只是个**函数表达式**，Bun 的 loader 通过尾部元数据找到并调用它，它自身不自调用（内部 `Sfm()` 是它的 main 引导）。

文件末尾有魔数 `---- Bun! ----`（2.1.191 在 byte 239390536 处），~~其后到 EOF 是一张**模块/资产表（TOC）**，每条记录是 `{ 绝对偏移 u64, 长度 u64, …flags }`，最后 48 字节是自引用 footer 指针~~。最后 48 字节实测：

> ❌ **实测证伪**（见 [`../docs/FINDINGS-phase0.md`](../docs/FINDINGS-phase0.md) B1/P0-a 核验）：那 48 字节是 ELF `.shstrtab` 的 `Elf64_Shdr`（ELF section header table）、**非 Bun footer**；真 module-graph（`Offsets` 头 + 52 字节定长记录）落在 `.bun` section 内、`---- Bun! ----` trailer magic **之前**，并不延伸到 EOF、也无「自指针 footer」。下方 hexdump 与「footer 自指针 / TOC 到 EOF」推断均属被证伪的旧模型，保留仅作历史。

```
0000 0000 0000 0000          # 0
197f 450e 0000 0000          # offset = 0x0e457f19 = 239435033
9901 0000 0000 0000          # length = 0x199      = 409
0000 0000 0000 0000          # 0
0100 0000 0000 0000          # 1
0000 0000 0000 0000          # 0
```

Bun 拿这些偏移去**切 blob**，而不是用于校验长度。偏移错 = 切到垃圾 = 读崩。所以改动二进制内容：
- **前后等长，in-place 改** → 所有偏移都没变，TOC 一字不用动。这就是 `claude-channels-patch/patch.py` 死守等长走的路。
- **长度有变** → 要同时改：① 被改模块的 `length`；② 插入点之后每一个模块/资产的 `offset` 全部要平移 Δ；③ TOC 自身和 footer 的自引用指针。

**问题：长度变化后是否还能运行？** `claude` 2.1.191 + `bun` 1.3.14 实测：能。（具体略）

## loader-hook

在原二进制的内置 bundle 顶部有一行纯注释（77 字节，二进制里出现多处）：

```js
// Claude Code is a Beta product per Anthropic's Commercial Terms of Service.
```

把它**等长**替换成一段 loader-hook：

```js
if(process.env.CC_EXT)try{require(process.env.CC_EXT)}catch(e){}
```

不足部分用空格填充，文件大小分毫不变。于是该代码会在模块顶层、main 之前执行。等长 → Bun 尾部 TOC 偏移全不变 → 无需改 TOC。

注意，这是在 main 之前*注入*，不是*替换*。

什么情况下 main 不再执行？
- 外部调用 `process.exit(0)` → 进程直接退出。实现完全接管/替换。
- 外部阻塞/死循环 → 卡住,到不了 main。

什么情况会继续执行 main？
- 外部代码抛异常 → `try..catch` 接住、继续执行 main。
- 外部代码是异步任务 → require 立即返回，main 执行。

loader-hook 使我们学习研究时只需迭代都在磁盘上那份提取的 app.js，最少改动 claude 二进制。

**问：能不能清掉内置 bundle js 节约空间？** 不能直接删：
- 删了它 loader-hook 放哪？
- 退一步讲，还得重写 TOC+footer；
- 再退一步，即使清了 bundle js 也还有 Bun 引擎本体 ~93MB，这是地板。

**问：能不能用标准 bun 直接运行提取的 app.js？** 可行。

| 验证项 | 结果 |
|---|---|
| `--version` / `--help` / `mcp list` | ✓ |
| 交互 TUI\(PTY\) | ✓ 完整渲染 onboarding 页面（主题选择、框线字符、语法高亮 diff 等），证明 yoga/Ink 内联在 app.js |
| **`doctor`(PTY)** | ✓ `Platform: linux-x64`、`Path: …/bun`、`Search: OK (/usr/bin/rg)` |

有一次意外调用 `doctor` 遇到 timeout 命令超时（exit code 124），纯属忘了是交互环境，没有使用 PTY。

## 嵌入资产与重建自包含二进制文件

事实上，claude binary 有两个嵌入资产（总共 2MB），ELF，分别用于录音/读剪贴板图，但都是惰性加载的：（示意）

```js
var dqo = Q((..) => { ..exports = require("/$bunfs/root/image-processor.node") });  // 用到才 require
```

预编译的字节码里是 `dlopen`，也不会因程序启动时动态链接加载报错。

提取嵌入资产有个优雅办法，用 loader-hook 让 claude 自己吐。外部 bundle 跑在 claude 真实 bun 运行时里，`Bun.embeddedFiles` 已填充，遍历写盘即得。参见 `dump-embedded-resources.cjs`。

app.js 中 audio-capture 自带回退策略，会找 `vendor/audio-capture/x64-linux/audio-capture.node`，image-processor 没有回退。只是观测，这不影响我们什么。

整个 claude binary 228MB = `bun` 74MB + `app.js` 17MB + `Bun.embeddedFiles` 2MB + JSC 字节码缓存 127MB + sourcemap.json 等。

参见分析脚本 `analyze-binary-layout.mjs`（读 ELF section + 扫 `.bun` 段内大可打印块）。

实测 `bun build --compile` 重新构建成自包含二进制（`bun` 94MB + `app.js` 17MB + 2x`.node` 2MB ≈ 114MB），可用，但启动慢（`--version` ~1.05s vs 原二进制 ~0.12s）。提示：`bun --compile --bytecode` 把 JS 预编译成 JavaScriptCore 字节码。

**JSC 字节码缓存是启动优化，不是额外功能**，删掉它不影响功能，但启动慢。

问：bun `--bytecode` 能否只装字节码不放源码？*bun 1.3.14 实测：不能。参见脚本 `exp-bytecode-source-protection.sh`。

| 实验 | 做法 | 结果 |
|---|---|---|
| ① 源码是否内嵌 | grep `--bytecode` 二进制 | **是**,源码明文在内(我们也确实提取出来跑了) |
| ② 运行用源码还是字节码 | 改源码 `a*1000`→`a*9999`、字节码不动 | 输出 `40002`→**`399962`**,**跟着源码变 ⇒ 运行时用源码** |
| ③ 源码 load-bearing? | 把源码改成非法 JS(同长)、字节码完好 | **二进制直接启动失败**(`Expected CommonJS module to have a function wrapper`)⇒ 源码**不可剥离** |
| 旁证 | `--minify --bytecode` | 标识符被改名,但**逻辑/常量仍是可读 JS** |

**根因(JSC 惰性编译)**:`--bytecode` 缓存只覆盖**顶层/急切编译**的代码;**嵌套函数体在首次调用时才从源码解析**。所以字节码无法独立运行,bun 必须保留源码——`--bytecode` 是把解析从运行期挪到构建期的**启动缓存**,**不是源码保护**。bun 文档亦明示 `--bytecode` 不混淆源码。

**对「源码保护」的实际含义**:bun 目前给不了真·字节码-only / 加密。唯一能减弱可读性的是 `--bytecode`(无效)与 `--minify`(改名,不改逻辑)。真要保护得靠外部手段(打包加密 + 运行时解密、native 化关键逻辑等),不在 bun 自带能力内。这也回头解释了为何 claude 二进制**必须**含那份 16.6MB 源码——正因字节码不能独立站立。

问：claude binary 有几份 bundle 拷贝？一份。

一度错误认为 bundle 在二进制里有**两份拷贝**。因为：
1. “两份拷贝”是老 Node.js SEA 时代的真实现象：那时 bundle 为主线程 + worker 各嵌一份 → 每锚点命中 2 处。
2. `claude-channels-patch` 的 README 记录“每个 patch 要打两遍”（早先用于 Node.js SEA 版本）。
3. 二进制中同时包含①源码②JSC 字节码。

## [claude-shim](./claude-shim/README.md)

## 入库归档

- claude 专有财产的衍生物**不入库**，只提交分析与原创脚本。
