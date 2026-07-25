# cc-patch

统一的 Claude Code 二进制补丁管理器。它把原 `agent-patch` 与 `channels-patch` 的能力归并为三个可独立检测、按依赖组合的 feature，并提供 CLI、JSON 报告、只读性能探测、命名快照和 Textual TUI。

本目录是 unbun 仓库内独立维护的 Python 实现。它与仓库根目录的 JavaScript/Bun 实现共享 `contract/` 中的行为规格、schemas、vectors 与 golden fixtures，但不 import、执行或通过 subprocess 调用对方的 feature、store、lineage 或 transaction 核心；两套实现必须各自完成相同行为并通过公开进程边界互操作。

> 免责声明：本工具仅供学习与本机自用研究。请勿用于你不拥有或未获授权分析的软件或服务。修改官方闭源二进制可能违反其服务条款，并会被版本升级覆盖或失效，风险由使用者自行承担。

## 安装与入口

要求 Python 3.11+ 和 [uv](https://docs.astral.sh/uv/)。从 unbun 仓库根目录运行公开入口：

```bash
uv run --directory python/cc-patch ccpatch --check
```

也可以直接在项目目录运行：

```bash
uv run ccpatch --check
```

迁移期保留 `cc-patch` 命令作为兼容 alias；新文档与互操作测试使用 `ccpatch`。

补丁写入后需要新开 Claude Code 进程才能加载新二进制。

## Feature

| Feature | 作用 | 依赖 | 可逆性 |
|---|---|---|---|
| `source-exec` | 把 Bun 标记从 `@bytecode` 改为等长的 `@source__`，让运行时执行可补丁的 JavaScript 源码副本 | 无 | 可精确逆向 |
| `agent-model` | 把 Agent/Task 工具 model 参数的固定枚举 `enum([...])` 等长替换为 `string()`（保留其前的 minified 变量前缀不动），允许任意后端模型名 | 无 | 可精确逆向 |
| `channels` | 保留 channel capability 检查，同时绕过 provider、policy、session、marketplace、allowlist 等门禁，并启用 `plugin:` 与 `server:` 通道 | `source-exec` | 决策塌缩不可逆 |

`agent-model` 可独立启用；只有 `channels` 会自动加入 `source-exec`。`channels` 的决策函数塌缩会用空格覆盖原门禁字节，信息不可恢复，因此绝不尝试就地逆向；revert 必须从 clean 基线重放目标 feature 子集。

## 写盘模型与 shared store

clean 基线是唯一真相源。Python 与 JavaScript 实现共同使用 shared store v1；store root 由 `UNBUN_CC_STORE` 或平台数据目录解析，target 以规范化绝对路径完整 SHA-256 键控，baseline 与 snapshot 由 manifest 激活并引用 content-addressed blob。所有 patch 与 feature 级 revert 都从匹配版本的 clean 基线开始，在内存中按依赖顺序重放目标 feature，再经 cooperative directory lock 与 transaction 原子替换文件。

基线不是普通缓存，不应手工删除。尤其是 `channels` 已 patched 且匹配版本的 clean 基线丢失时，塌缩前字节已经不可恢复；工具会拒绝猜测或制造伪基线，只能重装干净的 Claude Code 后重新建立基线。版本不匹配、版本无法探测、基线内容自校验失败时也会拒绝写盘，以避免静默降级或覆盖错误构建。

### Launcher 备份隐患

备份或临时文件绝不能放进 Claude Code 的 `versions/` 目录。launcher 会对文件名做宽松 semver 识别，`2.1.206.bak`、`2.1.206.agentbak` 等名称也可能参与版本排序并被当成可执行文件启动，造成“补丁看似未生效”甚至运行错误二进制。cc-patch 因此把 baseline、snapshot 与 quarantine 放进平台 shared store；binary result temp 只在原子替换前短暂位于目标目录且使用 launcher 不会选中的隐藏 UUID 名称。

## 常用命令

### 只读检查

```bash
ccpatch --check
ccpatch --check --binary /path/to/claude
ccpatch --check --json
ccpatch --profile
```

`--check` 显示每台二进制的自报版本、体积、基线状态和三个 feature 的 `clean`、`patched`、`mixed`、`unsupported` 状态。`--json` 输出完整结构化数据；`--profile` 用只读 mmap 与小窗探测逐台报告 version/status/总耗时，不执行也不修改二进制。

### Store 与 lock 诊断

```bash
ccpatch store root
ccpatch lock inspect --binary /path/to/claude
ccpatch lock inspect --binary /path/to/claude --json
ccpatch lock cleanup --binary /path/to/claude --force
```

`store root` 和 `lock inspect` 只读；stale lock 不会自动抢占，只有显式 `lock cleanup --force` 才会删除只含合法 `owner.json` 或为空的 lock 目录，未知内容会拒绝清理。

### Patch

```bash
ccpatch patch --all
ccpatch patch --binary /path/to/claude
ccpatch patch --feature agent-model
ccpatch patch --feature channels
ccpatch patch --feature agent-model --feature channels
ccpatch patch --feature agent-model,channels --json
```

显式 `patch` 在非 TTY 中也会执行写盘。未指定 `--feature` 时应用全部 feature；`--feature` 可重复或使用逗号分隔，并自动加入依赖。

### Revert

```bash
ccpatch revert --binary /path/to/claude
ccpatch revert --feature agent-model --binary /path/to/claude
ccpatch revert --feature channels --binary /path/to/claude
ccpatch revert --snapshot before-change --binary /path/to/claude
```

不指定 `--feature` 的 `revert` 恢复 clean 基线。feature 级 revert 会从基线重放其余 feature；如果仍启用的 feature 依赖待移除项，例如先移除 `source-exec` 而 `channels` 仍启用，工具会拒绝操作，不做隐式级联。`agent-model` 不依赖 `source-exec`，因此不会阻止该操作。

### 命名快照

```bash
ccpatch snapshot save before-change --binary /path/to/claude
ccpatch snapshot save before-change --force --binary /path/to/claude
ccpatch snapshot list --binary /path/to/claude
ccpatch snapshot rm before-change --binary /path/to/claude
ccpatch snapshot rm before-change --snapshot-version 2.1.175 --binary /path/to/claude
ccpatch revert --snapshot before-change --binary /path/to/claude
ccpatch revert --snapshot before-change --snapshot-version 2.1.175 --binary /path/to/claude
```

快照保存整个当前二进制态。同一 target、同一版本内同名默认拒绝，只有显式 `--force` 才原子替换 active manifest；跨版本同名快照可以共存。恢复遇到多份同名快照时默认选择与当前二进制版本匹配的一份，没有当前版本匹配则要求 `--snapshot-version`；删除多份同名快照时也必须指定版本。跨版本恢复会告警并要求确认；`--yes` 可以跳过交互确认，但不会隐藏告警。命名快照不会被自动清理。

## TUI

在 TTY 中裸运行 `ccpatch` 会打开 Textual TUI。界面按二进制分组：标题行显示智能缩短后的路径、版本、体积和基线状态，其下 feature 行可导航与勾选；`UNSUPPORTED` 行会禁用并跳过导航和批量切换。界面使用英文 ASCII 文案和彩色背景徽章区分 `CLEAN`、`PATCHED`、`MIXED`、`UNSUPPORTED` 与 `[!] degraded`；分组标题实时显示即将执行的 patch、revert、revert all 或 replay mixed，底部常驻汇总明确 `checked=target`。

| 按键 | 动作 |
|---|---|
| `space` | 切换当前行 |
| `a` | 切换当前可见且可用的全部行，不影响过滤隐藏行 |
| `enter` | 过滤框中转到结果列表；feature 列表中直接应用当前选择，不弹二次确认 |
| `q` | 在结果列表中退出 |
| `esc` | 随时退出 |

输入框可以按二进制路径或 feature 名过滤；无匹配项或只有不可操作项时会显示反馈。执行期间底部逐台显示进度；执行完成后 TUI 不自动退出，而是重新探测并刷新状态，供继续选择下一批操作。裸调用位于非 TTY 时只输出只读状态，不写盘；脚本或 CI 若要写盘，必须显式使用 `patch`、`revert` 或 `snapshot` 子命令。

## 退出码

| 退出码 | 含义 |
|---|---|
| `0` | 成功 |
| `1` | 用法、未检测到二进制、环境访问、无基线、版本漂移、并发修改、依赖者仍启用或未确认跨版本恢复等拒绝 |
| `2` | 内容一致性或写盘后验失败 |
| `3` | binary in use 或 macOS 重签名等具体动作执行失败 |

`--json` 写动作返回共同 `write-envelope` schema；每个错误包含 frozen 19-code catalog 中的稳定 `code`，批处理 exit 取所有 binary 中最严重值。stdout 只包含 JSON，进度与自然语言诊断写入 stderr。

## 安全边界与兼容性

- 真机只读检查使用 mmap，不执行二进制；测试不会对检测到的真机做 patch、revert 或 snapshot。
- 写盘使用临时文件与 `os.replace()` 原子替换，并在 rename 前检查目标是否被并发更新。
- macOS 修改 Mach-O 后会尝试移除旧签名并做 ad-hoc `codesign`；失败会显式报错，不静默忽略。
- 锚点依赖 Claude Code 当前 bundle 结构。`unsupported` 表示结构无法安全识别，应先升级定位逻辑或重装匹配版本，不能强行写盘。
- `mixed` 是外部工具或遗留状态的诊断态；cc-patch 自身从 clean 基线重放，不会生成 mixed。

## 测试与 golden fixtures

```bash
uv run --directory python/cc-patch pytest -q
uv run --directory python/cc-patch python tests/golden/_generate.py
```

`tests/golden/` 保存合成 clean 与 all-patched 的固化字节。重新生成 golden 只应发生在审计 Claude Code 新版本并重新验证迁移兼容性之后，不能把生成脚本输出未经审查地当作新预期。
