# L4 — 合并态与安全边界

> 层目标：审「**逐项已修 ≠ 合并态正确**」——多处独立修复叠加后的集成缝，以及安全边界是否真的守住。
> 执行者：reviewer（Claude，双视角：机械核对 + 第一人称执行模拟）。上级索引：[README.md](README.md)。前置：L0-L3 结论。

## 总体判断

**存在 Blocker。当前不具备发布就绪度。**

- 🔴 Blocker **1**（L4-01）：L3B-01 那条已在 JS 侧修复的数据丢失链条，**在 Python 侧原样存在且未被任何测试覆盖**。我用与 L3B-01 相同的 symlink 布局在 Python 侧完整复现了全链条：symlink 被普通文件替换 → 真实二进制原封未动 → pathKey 漂移 → 打上不可逆 channels 后**永久无法回退**（实测 revert 抛 `channels_patched_no_baseline`）。
- 🟠 Major **5**、🟡 Minor **4**、🔵 Note **4**。

**这一层的核心结论，也是本轮评审最重要的教训**：L3 是**按实现分线**评审的（L3-A/L3-B 评 JS、L3-Python 评 Python），Blocker 的**修复也只落在被评的那一侧**。L3B-01 的修复提交 `da5c513` 改了 9 个 JS 文件并新增 JS-only 回归测试 `test/patch/symlink-target.test.mjs`，但 `python/cc-patch/` 一行未动。双实现项目里，**「一侧发现的 Blocker」默认应视为「两侧的 Blocker」直到另一侧被证否**——这个反射当前不存在，是 L4-01/L4-03/L4-05 三条发现的共同根因。

**第二个结论：JS 450 pass / Python 449 pass 的全绿，对边界输入毫无约束力。** 我用 7 组边界形态跑双侧公开 CLI 差分，**6 组行为发散**（见 L4-02），其中 4 组 JS 直接抛未捕获异常。L2 差分测试的输入空间确实如 L3 所预判——只覆盖了 happy binary。

值得肯定的（实证确认，非采信自报）：静态命令族的「绝不执行目标」用 strace 逐命令证实；三处破坏性写守卫（versions/ 拒写、锚点零命中报错、baseline-before-binary）实测生效；JS 侧 canonical 路径修复真实有效；commit message 与内容相符且诚实（含自曝「本地绿而干净 checkout 失败」）。

### 双视角覆盖证据

**机械核对做的扫描/对账/查证**：
- 全量枚举两侧进程创建点（`execFileSync`/`spawnSync`/`spawn`/`execSync`/`subprocess`），逐个核对是否数组参数。
- 对账 `contract/vectors/platform-writes-v1.json` 的 `aggregation_rule.scope` 文字承诺 vs JS/Python 两侧 gate 的实际调用位置。
- 对账 `contract/schemas/status.schema.json` 的 `probe_error` 定义 vs JS `status.mjs:41` 与 Python `report.py:43` 的实际产出。
- 对账 16 个 commit 的 message 与 `git log --stat` 实际改动面。
- 对账 README / ARCHITECTURE / shared-store-format 的 canonical 路径承诺 vs 两侧代码。
- 清点 symlink 相关测试在两侧的分布（发现 JS-only）。
- 复跑两侧全量测试：JS 450 pass / Python 449 pass（**确认数字属实**，但见 L4-02 对其证明力的限定）。

**第一人称执行模拟走的流程/分支**：
- 扮演「用 `which claude` 得到的路径（symlink）去 patch」的用户，在 Python 侧走完 patch → 尝试 revert 的完整路径，复现永久失效。
- 扮演「在 Windows/macOS 上误触发写」的用户，走 gate 拒绝路径并 `find` 检查 store 落盘残留。
- 扮演「目标路径写错 / 给了目录 / 给了坏二进制」的用户，在两侧各走一遍 status。
- 扮演「非 TTY 自动化脚本」，在两侧各走裸调用、显式 patch、snapshot save 三条路径并 sha256 前后比对。
- 扮演「攻击者控制 PATH 目录名」，构造含 `$(...)` 的目录名走 `defaultBinary()`。
- 扮演「目标二进制内含恶意 blob name」，走 assets 落盘路径试遍历。

---

## A 合并态集成缝

| ID | 级别 | 位置 | 问题 | 建议 |
|---|---|---|---|---|
| **L4-01** | 🔴 **Blocker** | `python/cc-patch/src/cc_patch/orchestrate.py:544-546,468-469`；`transaction.py:26`；对照已修的 `lib/patch/cli/context.mjs:13-15` | **L3B-01 的数据丢失 Blocker 在 Python 侧原样存在。** `write_features` 用 `identity.path_key`（`store.py:338` 的 `path.resolve()`，解 symlink）做身份键，却把**未解析的 `binary`** 传给 `transaction.commit` → `atomicio.atomic_write_if_unchanged` → `os.replace(tmp, binary)`。在 `bin/claude -> versions/<ver>` 布局下后果与 L3B-01 逐条一致。**实测复现**：① `link.is_symlink()` patch 后变 `False`，真实二进制字节未变（`real changed: False`），却返回 `WriteOutcome(..., edits=1)` 报成功；② pathKey 从 `33007daf…`（real）漂移到 `2b6b25e7…`（link），baseline 留在旧 key 下不可达；③ 打上 channels 后 `write_features(link, [])` 抛 `NoBaselineRejected: channels_patched_no_baseline`——**永久无法回退**。JS 侧同场景正向对照通过（symlink 存活、real 被改）。`restore_snapshot`（`orchestrate.py:470,516`）有同一缺陷。 | 与 JS 对齐：解析出 canonical 路径后，**写入目标一律用 `identity.canonical_path`**，而非调用方传入的原始 `binary`。同时把 `test/patch/symlink-target.test.mjs` 的等价用例移植到 Python（或提升为跨实现 interop 用例），否则修复无回归保护。 |
| **L4-02** | 🟠 Major | `test/interop/differential.test.mjs:59-124`（输入空间） | **L2/L3 差分测试的输入空间缺口是真实的，且已暴露 6 组跨实现发散。** 我构造 7 组边界形态跑双侧公开 CLI（JS `cc status --json` vs PY `--check --json`）：**不存在的路径 / 目录当目标 / 空文件 / 断链 symlink / 全 0xff 垃圾字节 / 无 version 锚**——6 组 **exit 码不一致**（JS=1、PY=0）。其中 4 组 JS 抛**未捕获异常**并打印 stack trace（`ENOENT ... lstat`、`EISDIR`、以及 `TypeError: The "paths[2]" property must be of type string, got object` at `assets.mjs:150`）。仅「symlink 指向合法 golden」一组 exit 一致，但 `path` 字段仍发散（见 L4-03）。这些都是**普通用户极易触发**的输入（路径打错、目标是目录、旧/坏二进制），不是刻意攻击。 | ① 把边界形态纳入 `differential.test.mjs` 的差分矩阵（至少上述 7 组），冻结两侧一致的 exit 码与 `probe_error` 语义；② 决定统一语义（建议对齐 Python 的「结构化 `probe_error` + exit 0」，因为 schema 已为此留位，见 L4-07）；③ JS 侧把 `readStatus` 的 IO/解析异常转成结构化错误而非裸抛。 |
| **L4-03** | 🟠 Major | `lib/patch/cli/status.mjs:25-37` vs `python/cc-patch/src/cc_patch/cli.py:144-146`、`report.py:43` | **L3B-01 的传导面只做了一半：JS `status.path` 报 canonical 路径，Python 报用户传入的原始路径。** 实测同一 symlink 目标：JS 输出 `"path":"/tmp/…/real"`，Python 输出 `"path":"/tmp/…/link"`。这不只是显示差异——`status.path` 是公开契约字段，TUI 的 `group.path` 由它填充（`model.mjs:24`）并作为 `planTargets` 的 `plan.binary` 回流到写入路径（`model.mjs:86`、`controller.mjs:85` → `adapters.mjs:48` → `applyFeatureTargets`）。JS 侧因为 `targetContext` 会再解析一次而自洽；Python 侧则与 L4-01 同源。**TUI entryDigest 自洽性单独确认为 OK**：`adapters.mjs:29-33` 的 before/after 双读与 digest 都走同一个 `status.path`，且 `applyFeatureTargets` 内会重新 canonical 化，故 digest 与写入对象最终一致。 | Python `probe_binary` 用 `identity.canonical_path` 填 `path`（随 L4-01 一并修）；在 `differential.test.mjs` 里加一条 symlink 布局的 `status.path` 相等断言，把这条不变式钉死在跨实现层。 |
| **L4-04** | 🟠 Major | `lib/patch/cli/actions.mjs:59,69`（`publish:true`）vs `lib/patch/transaction/transaction.mjs:185`；对照 `python/…/orchestrate.py:542-560` | **「gate 前不落盘」不变式两侧边界不一致，且 JS 侧确实会落盘。** 实测：JS 走 `applyFeatureTargets` 时 `targetContext(..., {publish:true})` **先**写出 `store/v1/targets/<key>/target.json`，之后 `runPatchTransaction` 才执行 `assertPlatformWriteEnabled`；gate 拒绝后该文件**保留**。Python `_resolve_write_gate()` 在 `_get_store()` 之前，被拒时 store 根目录完全不存在。**风险评估**：`target.json` 只含路径元数据、不含二进制字节，不构成数据损坏，故非 Blocker；但它让「未启用平台上目标与 store 均不被触碰」这句对外承诺（README、ARCHITECTURE 均已如此措辞）在 JS 侧**字面不成立**，也让 gate 的可观察边界两侧不可互换。 | 把 `assertPlatformWriteEnabled` 提到 `actions.mjs` 的 `targetContext(publish:true)` **之前**（或让 `publish` 延迟到 gate 通过后），与 Python 对齐；补一条两侧共用的断言：gate 拒绝后 store root 不存在。 |
| **L4-05** | 🟠 Major | `python/cc-patch/src/cc_patch/interactive.py:107-112` vs `lib/patch/cli/binaries.mjs:5-9` | **非 TTY 下的静默批量写：Python 会对检测到的全部 live 二进制执行 patch，JS 结构上不可能。** `select_binaries` 在 `interactive=False` 且未给 `--binary/--all` 时打印一行提示后 `return binaries`（全部）。实测 3 个检测结果 + 显式 `patch` 子命令 → 三个全选中。JS 侧 `defaultClaudeBinary()` 只返回 `Bun.which('claude')` 的单个 realpath，无「默认全选」路径。这正是派活单里点名的「拒绝静默批量改多个 live」守卫——**Python 侧不成立**。注：L3C-01 修的是「无子命令不得写」，与本条正交（本条在**有**显式 `patch` 子命令时触发）。 | 非 TTY + 多目标 + mutating 子命令 + 未显式 `--all` ⇒ 应**拒绝并退出**（要求显式 `--all` 或 `--binary`），而不是「defaulting to all」。当前措辞把一个危险默认写成了提示信息。 |
| **L4-06** | 🟡 Minor | `lib/patch/store/root.mjs:12,30-32` | **`resolveStoreRoot` 在 `platform:'win32'` 下接受 POSIX 绝对路径，产出字面反斜杠的相对目录。** `path.win32.isAbsolute('/tmp/x/store')` 为 `true`，故校验放行，随后 `storeV1Root` 用 `path.win32.join` 拼出 `"\tmp\x\store\v1"`——在 POSIX 上这是**当前目录下一个名字里含反斜杠的目录**。我在跑 L4-04 的 gate 实验时**意外在仓库根创建了 `\tmp\l4gate-…\store\v1\` 目录**（已删除，工作树已复原）。生产路径上要同时满足「win32 平台」与「POSIX 风格 UNBUN_CC_STORE」才触发，故定为 Minor；但它是测试/交叉平台场景里的真实脚枪。 | `validateOverride` 在 win32 分支额外要求 drive-letter 或 UNC 形态（如 `/^[A-Za-z]:[\\/]/` 或 `^\\\\`），拒绝纯 POSIX 路径。 |
| **L4-07** | 🟡 Minor | `lib/patch/cli/status.mjs:41`；`contract/schemas/status.schema.json:18`；`test/contract/schema.test.mjs:309` | **JS 的 `probe_error` 是硬编码 `null` 的死字段。** schema 明确允许 `["object","null"]`，schema 测试第 309 行还专门冻结了一个 `probe_error:{code:"version_probe_failed"}` 的正样本，Python `report.py:43` 也真的会填充它——但 JS 的 `readStatus` 里它**永远**是 `null`，探测失败时改为抛异常（即 L4-02 的 4 个 crash）。这是 L3B 记为「status 缺 `probe_error`」的遗留项，合并态确认仍在，且与已冻结的 schema 正样本直接矛盾。 | 随 L4-02 一并修：JS 捕获探测失败并填充结构化 `probe_error`，使已冻结的 schema 正样本在 JS 侧真正可达。 |
| **L4-08** | 🔵 Note | 多修复叠加交互 | **正向确认，未发现相互干扰。** 逐条走过：平台 gate + 只读子命令 gate + canonical 路径 + lock 错误保留 + absent 站点。gate 与只读 gate 在两侧串联无冲突（只读路径根本不到 gate）；canonical 路径与 lock 路径同源于 `identity.pathKey`，未见二次漂移；`withTargetLock` 的 releaseError 降级在成功/失败两条路径上都不吞主体错误（`transaction.mjs:299-310` 逻辑正确：primaryError 优先、成功挂告警、无处挂载才抛）；store-only 操作（snapshot save/rm）两侧均**未**被平台 gate 拦截，与 `aggregation_rule.scope` 的文字承诺一致（实测两侧 snapshot save 均 exit 0）。 | 无需改动。 |

---

## B 安全边界

| ID | 级别 | 位置 | 问题 | 建议 |
|---|---|---|---|---|
| **L4-09** | 🟡 Minor | `lib/bun-binary.mjs:2,94` | **唯一残存的 shell 拼接点：`defaultBinary()` 用 `execSync('readlink -f "$(command -v claude)"')`。** 与 ARCHITECTURE「无 shell 拼接」的措辞（其列举范围是 strings / bun build / spawn 副本）存在字面缺口。**实测判定为不可注入**：构造名为 `q"$(id>/tmp/…/PWNED)"x` 的 PATH 目录，`command -v` 的输出作为命令替换结果**不再二次求值**，PWNED 未生成，路径原样返回。故非漏洞，是「文档全称断言 vs 代码有一处例外」的不一致。它同时是所有静态命令的默认入口（`cli.mjs:62,137,245,280`），值得消灭最后一处 shell。 | 换成无 shell 的等价实现（`Bun.which('claude')` + `realpathSync`，与 `lib/patch/cli/binaries.mjs:5-9` 已有实现统一），顺带消除对外部 `readlink` 的依赖。 |
| **L4-10** | 🟡 Minor | `lib/naming.mjs:46-57`；`cli.mjs:266` | **`uniqueAssetName` 对 blob name 只做 `basename`，未拒绝 `.` / `..`。** 实测 `basename('..')==='..'`、`basename('.')==='.'` 原样返回，`join(outdir,'..')` 指向父目录。**端到端不可利用**：`writeFileSync` 对目录路径抛 `EISDIR`，实测未写出 outdir 之外（父目录内容未变），且遍历序列（`../../../etc/passwd`→`passwd`、`a/../../b`→`b`）已被 `basename` 有效收敛。定为 Minor 是因为它属于「靠下游 IO 报错兜底」而非「输入层显式拒绝」，与 L3A-07 建立的「目标二进制是不可信输入、在源头净化」原则不一致。 | `uniqueAssetName` 显式把 `.` / `..` / 空串归入 `blob-<offset>.bin` 回落分支，使净化在源头完成。 |
| **L4-11** | 🔵 Note | static/runtime/mutate 三分 | **正向确认，边界守住。** 用 `strace -f -e trace=execve` 逐命令实测：`layout`、`assets` 只 execve `bun` 自身；`extract` 额外 execve `esbuild` 与 `/usr/bin/strings`——**三者均从未 execve 目标二进制**。`cc run/introspect` 读 live、只对 `mkdtemp` 临时副本打桩并 spawn 副本（`cli.mjs:431-452`），`finally` 只删自建临时目录。写目标的入口经代码枚举仍只有 4 个：JS `runPatchTransaction` / `restoreSnapshot`，Python `write_features` / `restore_snapshot`——无第五入口。 | 无需改动。建议把 strace 式的 execve 断言沉淀成一条自动化测试，让「静态命令绝不执行目标」从人工核查升级为回归防线。 |
| **L4-12** | 🔵 Note | 破坏性写守卫 | **正向确认，3/4 守卫实测生效。** ① `versions/` live 区拒写：`cc patch-loader-hook` 对 `…/versions/2.1.1/claude` 不带 `--force` 时 exit 1 且不落盘（实测目录内无新文件）；② 锚点零命中：无锚二进制 exit 1 且不写 `--out`；③ baseline-before-binary：`transaction.mjs:198-218` 先 `baselineResolver` 再 `atomicWrite.publish`，Python `orchestrate.py:393-426` 先 `publish_baseline` 再 `transaction.commit`，两侧顺序一致；④「拒绝静默批量改多个 live」——**Python 侧不成立，见 L4-05**。 | 见 L4-05。 |
| **L4-13** | 🔵 Note | 不可信输入 root containment | **正向确认，L3A-07 的修复在端到端层面成立。** `outdirName`（`naming.mjs:13-27`）在源头强校验 semver 并显式拒 `..`；`refsOutdir`（:29-37）做 resolve/relative 的 root containment 复核，双保险。version 派生路径已封堵。handle 派生（`cli.mjs:168` 的 `replace(/[^A-Za-z0-9._$-]/g,'_')`）不含分隔符故安全。blob name 派生见 L4-10（不可利用但净化不彻底）。 | 无需改动。 |

---

## C 历史与文档一致性

| ID | 级别 | 位置 | 问题 | 建议 |
|---|---|---|---|---|
| **L4-14** | 🟠 Major | `README.md:73`；`docs/ARCHITECTURE.md:125` | **文档把只在 JS 侧成立的不变式写成了双实现全称承诺。** README:73「目标由 canonical（realpath）路径寻址……patch 作用于真实二进制、symlink 保持不变、同一目标恒得同一 store 命名空间」与 ARCHITECTURE:125 同义表述，均无实现限定词。按 L4-01 实测，这在 Python 侧**全部三句都不成立**。ARCHITECTURE:124 的「两实现都在取 target lock、建 baseline、写盘之前强制它」对平台 gate 也是全称句，按 L4-04 在 JS 侧的 `target.json` 落盘上字面不成立。文档比代码走在了前面，会让读者据此认为两侧可互换。 | L4-01 / L4-04 修复前，给这两句加实现限定（或标注 Python 侧待修）；修复后恢复全称并补跨实现测试作为该断言的承重结构。 |
| **L4-15** | 🟡 Minor | `docs/review/README.md:16-17,44-47`、`:5` | **评审索引的状态表已严重滞后。** L3 仍标「⬜ 未开始」、L4 标「⬜ 未开始」，而 L3 四份子文档均已完成并有修复提交；第三节汇总表里 L2 重复出现两行（一行有数据、一行「待执行」），L3/L4 行仍是空占位。README:5 的「`git` 尚无 commit / 源码约 10k 行」快照描述也已过时（现 16 commit、JS 17.8k + Python 15.8k 行）。 | 更新状态表（L3 标完成、L4 标完成并填本文件计数）、删除重复的 L2 行、刷新 README:5 的快照描述。 |
| **L4-16** | 🔵 Note | 16 个 commit | **正向确认，commit message 与内容相符，无夸大。** 逐条比对 `git log --stat`：`da5c513` 的 message 列举的三件事（canonical 写入、保留主体错误、允许 absent 站点）与其 32 个改动文件一一对应；`cbc4e93` 详细列出 L3C-01/07/08 三项并给出实测 SHA 变化证据；`29bb9e7` **主动自曝**「早先提交用 `lib/ test/` pathspec 静默漏掉了根目录的 cli.mjs，本地绿而干净 checkout 挂 8 个测试」——这是诚实且高价值的记录。未发现「message 声称做了但实际没做」的情况。**注意**：派活单说「14 个 commit、工作树干净」，实测评审开始时为 13 commit + `cli.mjs` 未提交；评审期间仓库被并发推进到 16 commit（多出 `2ede52b` / `f368baf` / `29bb9e7`）。本报告结论基于 `29bb9e7`。 | 无需改动。 |

---

## 已验证清单

以下项经**实测**（非采信文档或自报）确认成立，可供总报告引用：

1. **静态命令绝不执行目标**：`layout` / `assets` / `extract` 经 strace execve 全量追踪，只出现 `bun`、`esbuild`、`/usr/bin/strings`，目标二进制从未被 execve。
2. **`cc run/introspect` 只对副本打桩**：读 live → `mkdtemp` 临时副本 → spawn 副本 → `finally` 删自建目录，代码路径确认（`cli.mjs:428-453`）。
3. **写目标的入口仅 4 个**（两侧各 2 个），代码枚举确认无第五入口。
4. **裸非 TTY 两侧均只读**：同一 clean golden，Python `ccpatch --binary X </dev/null` 与 JS 同形调用前后 sha256 均不变（L3C-01 修复复验通过）。
5. **无 shell 注入**：两侧全部 spawn 点为数组参数；唯一 shell 点 `defaultBinary()` 经恶意 PATH 目录名实测不可注入（见 L4-09）。
6. **versions/ live 区拒写守卫**生效（exit 1 + 零落盘）。
7. **锚点零命中即报错**生效（exit 1 + 不写 `--out`）。
8. **baseline-before-binary 顺序**两侧一致。
9. **store-only 操作不被平台 gate 拦截**，与 `aggregation_rule.scope` 承诺一致（两侧 snapshot save 实测 exit 0）。
10. **JS 侧 canonical 路径修复真实有效**：symlink 布局下 symlink 存活、真实二进制被改、pathKey 唯一。
11. **TUI entryDigest 在 symlink 布局下自洽**（JS 侧）：digest 与最终写入对象一致。
12. **lock releaseError 降级不吞主体错误**：代码路径三分支（primaryError 优先 / 成功挂告警 / 无处挂载才抛）逻辑正确。
13. **root containment**：version 派生路径经 semver 强校验 + `refsOutdir` 复核双保险；handle 派生不含分隔符。
14. **测试计数属实**：JS 450 pass / 0 fail（66 文件，35819 assertions）；Python 449 passed。
15. **commit message 与内容相符**，16 个全部核对。

## 未验证区（诚实标注）

- **非 Linux 平台的真实行为**：Windows / macOS 的写路径、codesign、PE / Mach-O normalization 全部未在真实平台运行过（平台 gate 本身就因此禁用）。本层所有平台相关结论均来自 Linux 上的 `platform` 参数注入模拟。
- **真实 live 二进制的写事务**：live 2.1.217 三 feature 均 patched 且无 clean baseline，按设计只能只读探测；本层所有写路径实测均基于 synthetic golden 与 conftest 合成 bundle，未在 257MB 真实二进制上跑过完整写事务。
- **runtime-oracle 发布 gate**：需已登录 claude 会话，本次环境未认证，该测试确定性 skip（非失败，但也**未**提供正向证据）。
- **并发 / 竞态**：未做多进程同时 patch 同一目标的压力测试；lock 协议的正确性仅经单进程路径与既有测试覆盖。
- **L3A-03/04 的多版本 corpus**（L3-A 遗留线索 1）：未用异版本、异 minifier handle 的真实二进制做端到端 split→diff 验证，本层沿用 L3-A 结论未复核。
- **性能 / 内存**：未复测 L3B-11 的写路径峰值内存（3.48GB RSS）基线。
- **Python 侧边界输入的更深行为**：L4-02 只比对了 exit 码与顶层字段；Python 在垃圾字节输入下报告 `probe_error:null` 且给出 feature 状态，其状态判定是否合理未单独审查。
