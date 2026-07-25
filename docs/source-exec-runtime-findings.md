# `source-exec` 运行时事实核验

> 状态：已裁决并迁移 contract；`agent-model` 无需 `source-exec`，`channels -> source-exec` 保持不变。
>
> 日期：2026-07-23。

## 背景

双实现初始规格把 `source-exec` 定义为 `agent-model` 与 `channels` 的共同必要依赖，依据是历史经验：`// @bun @bytecode` 执行预编译字节码，源码 byte edits 不生效；翻为等长 `@source__` 后才执行被修改源码。

Phase 1 runtime oracle 必须用真实行为证明这一前提，不能只检查 marker。

## 证据一：普通 Bun SFX 反例

环境：Bun 1.3.14。

构建：

```text
bun build --compile --bytecode entry.js
```

源码表达式从等长 `6 * 7` 改为 `6 * 8`：

```text
original=42
edited-bytecode=48
edited-source=48
```

保留 3 个 `@bytecode` marker 的副本已经执行修改后的源码行为。该 fixture 无法证明翻 marker 是源码修改生效的必要条件，ELF runtime gate 因而保持 `not-proven`。

回归测试：`test/contract/exact-replay-elf.test.mjs`。

## 证据二：真实 Claude Code entry blob 反例

目标：clean Claude Code 2.1.214 的临时副本。没有修改 live binary。

步骤：

1. 由 `parseModuleGraph()` 定位唯一 entry `cli.js` blob：offset `238535944`，length `20157336`。
2. 只在 entry 源码 blob 内，把全部 217 个 `2.1.214` 等长替换为 `9.9.999`。
3. 一份副本保留全部 5 个 `@bytecode` marker；另一份把 5 个 marker 全部翻为 `@source__`。
4. 实际执行三个副本的 `--version`。

结果：

```text
original:                       2.1.214 (Claude Code)
entry edited, bytecode marker: 9.9.999 (Claude Code)
entry edited, source marker:   9.9.999 (Claude Code)
```

这证明至少对该 entry 顶层版本行为，源码修改在保留 `@bytecode` 时已经生效。它没有直接证明嵌套的 Agent schema 行为，因此还不能单独删除 `agent-model -> source-exec` 依赖。

## 不合格的早期探针

仅修改最后一个 `overview",VERSION:"2.1.214"` 锚点时，两个副本都仍输出 `2.1.214`。该锚点不是 `--version` 实际读取的唯一常量，不能作为 bytecode/source 判别证据。完整 entry 实验替代了它。

## 决定性 Agent 探针

用独立 localhost Anthropic Messages mock 驱动真实 Claude 临时副本收到：

```json
{
  "name": "Agent",
  "input": {
    "description": "probe",
    "prompt": "return probe result",
    "subagent_type": "general-purpose",
    "model": "gpt-5.5"
  }
}
```

比较三份副本：

1. clean；
2. 只应用 `agent-model`，保留 `@bytecode`；
3. 应用 `agent-model` 并翻 `@source__`。

探针已经完成。mock 运行在独立随机 localhost 端口，没有连接或操作当前 LiteLLM。源 2.1.214 SHA-256 在实验前后均为 `3c029136f7c81f54ed4a38e9d52e655aad536433dbbde50519c8c31bb646ad14`。

| 副本 | Agent `model` schema | `gpt-5.5` 子请求 |
|---|---|---|
| clean | enum | 否，客户端得到 `InputValidationError` |
| `agent-model` only，保留 5 个 `@bytecode` | string | 是 |
| `agent-model` + 5 个 `@source__` | string | 是 |

运行时 schema 与后续子请求两个独立 oracle 一致：`agent-model -> source-exec` 依赖被证伪。

可复现资产：`exp/agent-model-runtime/runtime_probe.py` 与 `test_runtime_probe.py`。

## 当前实施约束

据此修订实施约束：

- 新的 JS/Python production feature registry 不得声明 `agent-model` 依赖 `source-exec`。
- exact replay/store/format 工作可继续，因为它们不依赖这个运行时因果结论。
- `channels -> source-exec` 尚无同等级行为 oracle，暂不改动该边。
- `source-exec` 仍作为独立 feature 保留，直到 channels 与跨版本兼容性得到单独裁决。
- 旧实现与 live binary 保持不变。
