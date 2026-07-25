# JavaScript TUI 基础库选择

> 决策日期：2026-07-24。
>
> 范围：Phase 3 Task 3.8 的有界兼容性 PoC；不接 production transaction，不修改 CLI 或公共 TUI 合同。

## 选择

Task 3.9 采用 Ink `7.1.1` + React `19.2.8` 实现 JavaScript 全功能 TUI。两个版本由 `bun add ink@7.1.1 react@19.2.8` 安装，并锁定在 `exp/js-tui-poc/bun.lock`。PoC 使用 Bun `1.3.14`，局部依赖闭包共 38 个 package。

不选择 `@clack/prompts`：它的一次性 prompt 模型不能承载持久可过滤列表、异步执行状态、提交后重新探测并停留，以及持续 resize。没有转测 `neo-blessed`，因为优先候选 Ink 已通过真实 PTY 闸门；若后续 Bun 或 Ink 升级使同一 PTY suite 回归，再以 `neo-blessed` 等成熟候选进行同口径比较，不退回一次性 prompt，也不手写 ANSI 引擎。

## 已证明行为

PoC 位于 `exp/js-tui-poc/`。测试通过 Python 标准库 `pty` 建立 controlling terminal，以 pyte `0.8.2` 解释真实 ANSI 输出为 screen grid，不使用组件 snapshot，也不只检查 ANSI bytes。

- Ink 在 Bun 下取得 focus 并启用 raw input，稳定帧显示 `FOCUS:ON RAW:ON`。
- `/` 进入过滤模式；path 与 feature 共用动态过滤，含快捷键字符的 `canary source` 仍可完整输入。
- `space` 切换当前可选行；`unsupported` 行保持 disabled。
- `a` 只批量切换当前可见且可选的行，不影响隐藏项或 `unsupported` 项。
- `Enter` 先显示 `APPLYING`，随后异步进入 `DONE`、递增 refresh generation，并以刷新后的 feature state 重绘。
- 真实 `SIGWINCH` 在 80、100、120 列下更新 viewport，首行右侧 sentinel 始终保留且行宽稳定。
- `q` 与 `Esc` 均以退出码 0 结束；`ICANON`、`ECHO`、`ISIG`、`IEXTEN`、`IXON`、`ICRNL`、`VMIN` 与 `VTIME` 恢复到进入前状态。

screen-grid oracle 先以 `POC_BAD_LAYOUT=1` 把首行宽度故意扩到 viewport 外，80 列下 `RIGHT-EDGE` 消失并产生预期失败；该正样本已固化为持续测试，不能静默退化。恢复受约束宽度后，完整六场景 suite转绿。两项包装测试均连续运行三次，总计 6 pass、0 fail。

## 风险与约束

- Ink 是 React renderer，运行时闭包显著大于一次性 prompt。Task 3.9 应让 Ink/React 成为根 production dependency，并由根 lockfile锁定；PoC 的局部 lockfile只证明候选版本，不是最终发布接线。
- Bun 不是 Ink 文档的主要运行时。当前版本组合已由真实 controlling PTY 验证，但升级 Bun、Ink、React、`react-reconciler` 或 `yoga-layout` 时必须重跑 PTY suite，不能只跑组件测试。
- Ink 首帧可能早于 focus/raw-mode effect 完成。测试和 production loading UI 应以稳定状态或可操作状态为边界，不能把首帧标题出现等同于输入已就绪。
- 过滤文本与快捷键必须分模态处理。PoC 使用 `/` 进入过滤模式、`Enter` 返回命令模式；`Esc` 始终退出，避免 `a`、`q` 等字符无法出现在过滤词中。
- PoC 的异步 action 是内存模拟，不证明 transaction、dependency closure、锁、错误 envelope 或重新 probe。那些行为仍由现有 production transaction/CLI tests 负责，Task 3.9 只能调用正式接口，不能复制其规则。

## Task 3.9 接口

production TUI 应把 Ink view 与正式操作拆开。建议入口接受以下 adapter，而不是从组件内 import transaction/store 细节：

```js
runJsTui({
  loadRows: async () => Array<TuiBinaryRow>,
  applyTargets: async ({binary, targetFeatures, entryDigest}) => WriteEnvelope,
})
```

`TuiBinaryRow` 应保留完整 binary 状态对象，并派生稳定行 identity、path、version、feature slug、state、target、selectable 与 details。`loadRows()` 负责首次及提交后的正式 probe；`applyTargets()` 接收 UI 的目标集合并返回正式 write envelope。组件只管理 filter、focus、selection、busy/progress 与 presentation，不重算 dependency closure，不直接修改 binary/store。

Task 3.9 的测试必须复用与 Python TUI 相同的交互 scenario vectors，并补齐本 PoC 尚未声称完成的计划摘要、进度、多 binary 写结果、提交后重新 probe 并停留、再次提交、防双提交、正式错误展示和 mixed target 语义。真实 PTY回归继续覆盖 80、100、120 列及 `q`/`Esc` 恢复。

## 验证命令

```bash
cd /home/xp/src/unbun
POC_BAD_LAYOUT=1 uv run --with pyte==0.8.2 python exp/js-tui-poc/tests/test_pty.py
bun test exp/js-tui-poc/pty.test.mjs --timeout 30000
bun test exp/js-tui-poc/pty.test.mjs --timeout 30000 --rerun-each 3
```