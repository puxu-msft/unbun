# unbun Claude Code 补丁器双实现规格

> 状态：JavaScript/Bun 与 Python 两套 production 实现、shared store、公开 CLI 互操作和双 TUI 已完成；Linux 写路径已通过发布矩阵，Windows/macOS平台 gate仍待真实 runtime/codesign证据。
>
> 日期：2026-07-23（规格冻结）／2026-07-25（实现验收）。
>
> 本文定义 `unbun` 中 Claude Code 补丁能力的产品边界、双实现关系、共同可观察行为与验收标准。共享磁盘格式见 [`shared-store-format.md`](shared-store-format.md)。既有 [`spec.md`](spec.md) 继续描述 Bun SFX 提取、分析与运行时内省能力；本文只覆盖 `cc patch` 能力重构。

## 1. 已决定事项

1. `unbun` 从原仓库独立出来，成为 `~/src/unbun` 下的独立工具与独立 Git 仓库。
2. JavaScript/Bun 与 Python 两套补丁管理器长期并行维护，都是完整、第一等、可独立运行的实现。
3. 两套实现分别拥有自己的 feature、探测、依赖解析、baseline、snapshot、事务写盘、CLI、JSON 输出和全功能 TUI 代码，不通过 RPC、FFI、subprocess 或源码导入复用对方的核心实现。
4. 两套实现完全互操作，共享行为规格、共享 store 格式、共享测试向量，并能交替操作同一台 Claude Code 二进制。
5. `unbun cc` 是 JavaScript/Bun 实现的公开入口；`ccpatch` 是 Python 实现的公开入口。
6. JavaScript 与 Python 两套 TUI 都长期保留。JavaScript TUI 必须达到现有 Textual TUI 的功能契约，而不是降级成仅能回答一次问题的提示器。
7. 旧 `.ccbak`、`.agentbak` 与 `.channels.bak` 已删除，不设计 legacy backup discovery、旧 store 兼容、symlink 或自动迁移。
8. 第一代 JavaScript patch 实现不再被 production入口引用；其测试意图已迁入contract与新suite，旧文件只待最终删除或归档。当前实现采用clean baseline + 目标feature集合重放。

## 2. 权威来源

两套实现之间没有“主实现”和“备用实现”。权威顺序是：

1. 本规格与共享 store 协议。
2. 独立维护的 conformance vectors、frozen golden 与互操作测试。
3. JavaScript 和 Python 各自的实现与单元测试。

若两套实现结果不一致，不能任意选择其中一套作为真相。应由规格、独立 fixture、真实二进制只读事实或运行时行为 oracle 裁决；若规格未覆盖，该差异是待决设计问题，不能静默固化为某一实现的既有行为。

## 3. 目标与非目标

### 3.1 目标

- 两套实现对同一输入产生相同的 feature 状态、依赖闭包、目标字节和错误分类。
- 任一实现建立的 baseline、snapshot 与 lock，另一实现可以验证、消费和延续操作。
- 两套实现都保留 `source-exec`、`agent-model` 与 `channels` 三个 feature，以及 `clean`、`patched`、`mixed`、`unsupported` 四态检测。
- 两套实现都保留只读快速探测、完整 JSON、命名 snapshot、原子写、macOS ad-hoc codesign、写后验证和失败回滚。
- 两套 TUI 对相同 probe 显示相同状态和计划，并提交相同的目标 feature 集合。
- 通用 Bun SFX 解析与 Claude 特有补丁代码保持边界清晰。

### 3.2 非目标

- 不把 Python 降级为 JavaScript 的 sidecar，也不把 JavaScript 降级为 Python 的 UI wrapper。
- 不要求两套实现拥有相同的内部类、函数、模块组织或算法，只要求可观察行为与磁盘协议一致。
- 不兼容已删除的 legacy backups。
- 不恢复仅支持旧 Node SEA 版本的 historical channels legacy strategy，除非未来针对相应版本重新立项并加入共同规格。
- 不引入 durable journal、跨平台原子交换或服务化并发状态机。当前威胁模型仍是本机单用户工具，但两套实现必须通过共享 cooperative lock 避免彼此同时写入。

## 4. 建议项目结构

```text
unbun/
  cli.mjs
  lib/
    bun-binary.mjs
    module-graph.mjs
    patch/
      core/
      io/
      store/
      transaction/
      targets/claude/
      tui/

  python/cc-patch/
    pyproject.toml
    src/cc_patch/
      features/
      tui/
      atomicio.py
      binaries.py
      cli.py
      codesign.py
      models.py
      orchestrate.py
      probe.py
      report.py
    tests/

  contract/
    schemas/
    vectors/
    golden/

  test/
    interop/

  docs/
    dual-implementation-spec.md
    shared-store-format.md
```

Python 包名与现有 `cc_patch` import namespace 保持不变。JavaScript 可重组当前 `patch-binary.mjs`、`patch-agent-model.mjs`、`patch-channels.mjs` 和 `patch-tui.mjs`，但第一代 `.bak + 逐 feature 写盘` 编排必须被完整替换。

## 5. 分层边界

### 5.1 Raw file reader 与 ELF parser 分离

补丁探测只需要跨平台 raw file reader，不应先解析 ELF。现有 `readBinary()` 同时建立 reader 并执行 `parseElfSections()`，会让 macOS Mach-O 与 Windows PE 在进入补丁逻辑前失败。

目标边界：

- `openFileReader(path)`：跨平台 raw reader，提供 `size`、`slice`、`toString`、`lastIndexOf` 和 `close`。
- `readElfBinary(path)`：在 raw reader 上增加 ELF section metadata，仅供 `extract`、`assets`、`layout` 与 `module-graph`。
- JavaScript patch probe 只依赖 `openFileReader`。
- Python patch probe 保持 `mmap` + 小窗读取，但其窗口选择和状态结果必须与 JavaScript 一致。

### 5.2 Feature core

每套实现独立实现以下协议：

```text
Feature:
  name
  title
  description
  requires[]
  reversible
  detect(full_bytes) -> FeatureStatus
  probe_windows(raw_reader) -> windows[]
  detect_windows(windows[]) -> FeatureStatus
  observe_substates(bytes) -> SubstateVector
  replay_substates(clean_bytes, SubstateVector) -> bytes
  apply(mutable_bytes) -> edit_count
  reverse(mutable_bytes) -> edit_count
```

`reverse` 只允许 `reversible=true` 的 feature 实现，并且只用于无 baseline 时重建 clean candidate；常规 revert 始终从 clean baseline 重放目标集合。

`observe_substates` 返回 feature 每个 owned site 的稳定 identity、offset、length 与 clean/patched 状态；`replay_substates` 从 clean baseline 精确重建该向量对应的 bytes。普通 clean/patched feature 是它的简化投影，mixed 只有在所有子站点都能精确识别和重放时才可接受。无法完整推导时，transaction 必须拒绝需要 build lineage 证明的写入。

共享 store 不通过“把所有 patch 区间归零”来证明 build lineage，因为这种 masking 会丢掉同版本 build 恰好发生在 patch-owned 区域内的真实差异。lineage 采用 [`shared-store-format.md`](shared-store-format.md) 定义的 exact replay proof。

#### Windowed probe contract

`claude-v1` 固定以下参数，避免两套实现对同一 binary 报出不同 `sites`：

- 通用 feature 小窗半径为 8,000 bytes。
- `source-exec` 的 candidate discovery 对**整个文件**做 `// @bun` 锚点 census，对每个有效 tag 建小窗并汇总全部站点，重叠时合并。（旧口径为「扫首 32,000,000 bytes 与末 32,000,000 bytes」，已于 2026-07-26 修订：中段标记会被静默漏掉，而 candidate 完整性检查只看「是否跨越 discovery 边界」、不看「是否存在从未扫过的区域」，故连 fail-closed 回落都不触发。）
- `agent-model` 从尾向前查找全部有效 describe suffix，不能只保留最后一个站点。
- `channels` 从尾向前跳过无关 register decoy，并分别定位 decision、feature flag、permissions 与 capability-strip 的全部有效站点。
- windowed probe 输出的 `state`、`sites` 与结构化 detail codes 必须和 full detect 一致。若 candidate discovery 不能证明完整，允许回退 full detect，不允许返回较少站点的快速近似。

这些参数属于 `claude-v1` contract。未来若 Bun 标记分布事实变化，应先增加 compatibility vector 并共同修订 contract，不能让两套实现各自扩大窗口后产生分歧。

### 5.3 Store 与事务

两套实现独立编写 store 和 transaction 代码，但共同遵守 [`shared-store-format.md`](shared-store-format.md)。CLI 与 TUI 不能直接读写 baseline，也不能自行逐 feature 写盘。

### 5.4 CLI 与 TUI

CLI 与 TUI 只负责：

- 采集目标 binary 与用户选择。
- 展示 probe、计划、进度与结果。
- 把“最终希望启用的 feature 集合”交给 transaction 层。

依赖闭包、baseline 选择、feature 重放、原子替换、codesign 与回滚全部属于 transaction 层。

## 6. Feature 行为契约

### 6.1 `source-exec`

- 将所有受支持 Bun 标记从 `// @bun @bytecode` 等长替换为 `// @bun @source__`。
- 可精确逆向。
- 无依赖。
- Bun 标记可能出现在文件的任意位置（实测既有 ~6% 处的，也有 ~90-98% 处的），探测不得只扫 bundle 尾部，也不得只扫首尾两端。

### 6.2 `agent-model`

- 将 Agent/Task model schema 的 `enum([...])` 等长替换为同一 schema receiver 的 `string()` 与填充注释。
- 可精确逆向。
- 无依赖。决定性运行时 PoC 证明只修改 Agent model schema 且保留全部 `@bytecode` marker 时，schema 与后续子请求均已生效。
- 定位不得硬编码 minifier receiver 名，例如 `E`、`S` 或 `A`；必须依赖稳定的 model 字段与 describe suffix 上下文。
- model enum 内容本身也是版本相关结构。`claude-v1` 使用 audited variant registry：先按稳定 describe suffix 找到 schema，再只接受 contract vectors 中登记的 exact clean core，并为每个 variant 定义等长 replacement 与 reverse bytes。新版本增删 model 名时，两套实现都返回 `unsupported`，直到共同加入新 variant 和 frozen vector；不得由单方模糊匹配任意 enum 后失去可逆性。

### 6.3 `channels`

- 保留 `claude/channel` capability check。
- 塌缩 provider、policy、session、marketplace 与 allowlist 等下游门禁，使决策进入 register。
- 配套处理 `tengu_harbor`、permissions 与 capability strip。
- 不可逆，因为决策体原字节被空格覆盖。
- 依赖 `source-exec`。
- decision 与 `tengu_harbor` 是 essential；permissions 与 capability strip 是 best-effort。两套实现必须使用相同分类。

### 6.4 依赖与目标集合

`claude-v1` 依赖图：

```text
source-exec
  <- channels

agent-model
```

- apply 时自动加入依赖并按确定性拓扑序重放。
- 用户请求移除仍被启用 feature 依赖的基础 feature 时，拒绝操作，不隐式级联删除。
- 正常写盘不会产生 `mixed`；`mixed` 仅是外部修改、旧工具或部分损坏的入站诊断态。
- 有匹配 clean baseline 时，只有 `observe_substates` 能完整描述并由 baseline 精确重建当前 mixed bytes，才能通过目标集合重放自愈；不能精确证明 lineage 的 mixed 必须拒绝。

## 7. 公开 CLI 契约

### 7.1 JavaScript/Bun

```text
unbun cc
unbun cc status [--binary PATH] [--json] [--profile]
unbun cc patch [--binary PATH] [--all] [--feature NAME]
unbun cc revert [--binary PATH] [--feature NAME]
unbun cc revert --snapshot NAME [--snapshot-version VERSION]
unbun cc snapshot save NAME [--binary PATH] [--force]
unbun cc snapshot list [--binary PATH]
unbun cc snapshot rm NAME [--binary PATH] [--snapshot-version VERSION]
```

### 7.2 Python

```text
ccpatch
ccpatch --check [--binary PATH] [--json]
ccpatch --profile
ccpatch patch [--binary PATH] [--all] [--feature NAME]
ccpatch revert [--binary PATH] [--feature NAME]
ccpatch revert --snapshot NAME [--snapshot-version VERSION]
ccpatch snapshot save NAME [--binary PATH] [--force]
ccpatch snapshot list [--binary PATH]
ccpatch snapshot rm NAME [--binary PATH] [--snapshot-version VERSION]
```

命令表面允许保留各自既有风格，但语义必须一一映射。互操作测试应直接调用两个公开入口，不绕过 CLI 调内部函数。

显式 `unbun cc status` 与 `ccpatch --check` 都始终输出一个或全部自动发现 binary 的状态，不进入 TUI。只有各自的裸入口在 TTY 中进入 TUI。

### 7.3 TTY 规则

- 裸 `unbun cc` 与裸 `ccpatch` 在 TTY 中分别进入各自全功能 TUI。
- 裸调用在非 TTY 中只输出状态，不写盘。
- 显式 `patch`、`revert` 与 `snapshot` 在非 TTY 中正常执行。
- TUI 中 `unsupported` 不可选择，`mixed` 默认表示需要重放修复，勾选状态表示目标态。
- 两套 TUI 都要支持按 binary path 或 feature 名过滤、逐行切换、可见项批量切换、提交后重新探测并停留。

## 8. JSON 与退出码

### 8.1 状态对象

两套实现的 JSON 至少包含：

```json
{
  "path": "/absolute/path/to/claude",
  "version": "2.1.217",
  "size_bytes": 268573680,
  "has_baseline": true,
  "probe_error": null,
  "features": {
    "source-exec": {
      "slug": "source-exec",
      "state": "patched",
      "details": [],
      "sites": 5
    }
  }
}
```

`details` 文案可以因语言而不同，不作为跨实现逐字相等字段；`slug`、`state`、`sites`、version、path、baseline 状态必须一致。正式 JSON schema 在实施 Phase 1 写入 `contract/schemas/`。

### 8.2 写动作 envelope

```json
{
  "success": true,
  "exit_code": 0,
  "action": "patch",
  "results": [
    {
      "binary": "/absolute/path/to/claude",
      "applied": ["source-exec", "agent-model"],
      "edits": 6,
      "resigned": false
    }
  ],
  "errors": []
}
```

错误对象必须有稳定 `code`，不能要求调用方解析自然语言：

```json
{
  "code": "channels_patched_no_baseline",
  "message": "human-readable text",
  "binary": "/absolute/path/to/claude",
  "feature": "channels",
  "details": {}
}
```

### 8.3 退出码

- `0`：成功。
- `1`：用法、环境、目标不存在、无 baseline、版本漂移、依赖拒绝、共享 lock 已占用或并发变化。
- `2`：store 内容不一致、写后字节不一致、feature 后验失败或回滚后验失败。
- `3`：feature apply、codesign 或具体动作执行失败。

多 binary 批处理取最严重退出码，并保留每台 binary 的结构化错误。

## 9. 性能与可观测性

- 状态探测不得为每个 feature 各自整读 250MB 二进制。
- JavaScript 与 Python 都应一次打开 reader，合并重叠 probe windows，再生成全部 feature 状态。
- candidate discovery 与小窗参数遵守 §5.2；业务锚点使用从尾向前的 `rfind` 与小窗。
- `--profile` 报告每台 binary 的 version、status、总耗时以及实现标识。
- 完整 probe 与 windowed probe 对同一 fixture 必须产生相同的 `state`、`sites` 与结构化 detail codes。
- TUI 不应为每行重复启动 probe 或重复打开同一 binary。

## 10. 跨实现互操作验收

以下矩阵全部是发布门槛：

| 建立或修改方 | 消费方 | 必须验证 |
|---|---|---|
| JavaScript | Python | detect、feature revert、revert all |
| Python | JavaScript | detect、feature revert、revert all |
| JavaScript | Python | baseline 校验与目标集合重放 |
| Python | JavaScript | baseline 校验与目标集合重放 |
| JavaScript | Python | snapshot list、restore、rm |
| Python | JavaScript | snapshot list、restore、rm |
| JavaScript | Python | 在已有 channels 上追加 agent-model，并从同一 baseline 重放合并后的目标集合 |
| Python | JavaScript | 在已有 channels 上追加 agent-model，并从同一 baseline 重放合并后的目标集合 |

关键交替场景：

```text
clean binary
  -> JavaScript patch channels
  -> Python patch agent-model
  -> JavaScript revert channels
  -> final state = agent-model
  -> Python revert all
  -> bytes = original clean baseline
```

反向场景交换 JavaScript 与 Python 角色后必须同样通过。

## 11. 防止 false green

不能仅依赖“两边自己的单元测试都绿”或“同一实现生成再读取自己的格式”。验收必须包含：

1. **已知坏实现正样本**：保留第一代 JavaScript 与旧 contract 的缺陷 fixture，证明测试能抓住硬编码 `E`、错误的 `agent-model -> source-exec` 依赖、channels revert 抹掉其他 feature、相邻 `.bak` 与错误退出码问题。
2. **独立 frozen golden**：初始 golden 由已审计历史输出与人工字节差异共同冻结；生成器不参与日常测试期望计算。
3. **差分测试**：同一 corpus 同时喂给 JavaScript 与 Python，比较状态、sites、闭包、最终字节、store manifests、错误 code 与退出码。
4. **跨实现 E2E**：一边写、另一边读和还原，不能只测同实现 round-trip。
5. **真实二进制只读探测**：两边独立 probe 当前安装的真实 binary 并比较结构化结果。
6. **临时副本运行时 oracle**：只在独立副本上 patch 并启动，证明源码级修改实际由 Bun 执行；不得修改当前正在使用的 live binary 做测试。
7. **TUI PTY 测试**：两套 TUI 都要验证真实屏幕布局、过滤、选择、执行后刷新与退出恢复，而不只断言输出字节流。

## 12. 迁移计划与闸门

### Phase 0：独立仓库基线

- 完成 `unbun` 独立仓库首个基线提交。
- 清理首个提交前的缓存、`node_modules`、测试产物和本机 memory 路径，补齐根 `.gitignore`。
- 记录旧仓库 provenance，但不伪造原 Git history。

### Phase 1：冻结共同 contract

- 提交本文、shared store 协议、JSON schemas、feature vectors 与 error codes。
- 先完成 build lineage PoC：用两个独立原型验证 ELF、PE 与 Mach-O 的 exact replay proof；Mach-O 原始签名与 ad-hoc 重签名后的同一 replay 结果必须在签名归一化后逐字节一致。PoC 可以先使用从现有实现提取的固定 substate vectors，不要求提前完成两套正式 feature 实现；Phase 2/3 再替换为正式 `observe_substates` 做端到端验证。PoC 失败则对应平台的所有 patch/revert/snapshot restore 写路径保持禁用并明确报错，不得退回仅按 version 匹配，也不得建立不互操作的私有 store。
- 为当前第一代 JavaScript 的已知缺陷添加预期失败或隔离正样本。
- 在任何写路径重构前先建立 interop test harness。

### Phase 2：迁入 Python 完整实现

- 将当前 Python `cc-patch` 移入 `python/cc-patch/`。
- 改用共享 store v1，删除 legacy migrate 模块、`orchestrate` 中所有 migrate import/call site 和旧备份路径假设。
- 保留 Python CLI、JSON、Textual TUI、golden 与 PTY 测试。
- 先只在 clean fixture 与临时副本上写盘。

### Phase 3：重建 JavaScript 完整实现

- 拆出跨平台 raw reader。
- 移植稳定的三 feature 语义和多窗口探测。
- 用共享 store + 目标集合重放替换第一代 `.bak + 逐 feature` 编排。
- 补齐 snapshot、JSON、退出码、事务故障注入和 JS 全功能 TUI。

### Phase 4：双向互操作

- 跑完整交叉矩阵与故障注入。
- 同一 store 上交替运行两个公开 CLI。
- 修复差异时以 contract 和独立 oracle 裁决，不让一方实现自动成为规范。

### Phase 5：旧入口退役

- `~/.claude/scripts/ccpatch` 暂留一个发布周期，转发到独立仓库中的 Python `ccpatch`。
- `agent-patch` 与 `channels-patch` 不再保留入口。
- 迁移验收后删除 `.claude/scripts/cc-patch` 源码副本，但保留原仓库 Git history 与必要历史文档。
- 删除 `unbun` 第一代 JavaScript patch 模块前，先确认其所有有效测试意图已进入 contract 或新测试。

## 13. 当前迁移前置条件

2026-07-23 的只读探测结果：

- `~/.local/share/claude/versions/2.1.217`：`source-exec`、`agent-model`、`channels` 全部 patched，且旧 baseline 已删除。
- `~/.local/share/claude/versions/2.1.214`：全部 clean。
- 多个 VS Code 扩展内置 `2.1.205` 至 `2.1.210` binary：全部 clean。

版本不同的 clean binary 不能作为 `2.1.217` baseline。两套新实现必须拒绝从 patched `2.1.217` 猜造 clean baseline。实施 live 写路径验收前，需要安装一份目标版本的 clean binary，或等待新的 clean 版本成为测试目标，再由共享 store 正常建立 baseline。

## 14. 完成定义

只有同时满足以下条件，双实现迁移才算完成：

- 两个公开 CLI 与两个 TUI 都可独立运行。
- 两套实现不调用对方核心代码。
- 共享 store 与所有交叉矩阵通过。
- 三 feature 的最终字节在两套实现间一致。
- JSON schema、error codes 与退出码一致。
- 真实 binary 只读探测一致。
- 临时副本上的运行时行为和完整 revert 成功。
- live 文档已从旧 `tools/unbun` 与旧共享仓库叙述更新为独立工具现状。
- 旧代码删除前已完成 merged-state review，且不存在仅由旧测试覆盖的行为。
