# cc 探测性能与窗口化正确性（2026-07-26）

起因：`bun cli.mjs cc` 在 268MB 的 `claude` 二进制上耗时约 2.5s。排查后发现这不是单纯的性能问题——**一个性能缺陷同时掩盖着两个正确性缺陷**，且修复顺序是硬约束。

## 根因

用内置 `cc status --profile` 实测（2.1.217）：`channels` ~2000ms、`agent-model` ~300-430ms、`source-exec` ~15ms、模块导入 ~200ms。

### 缺陷一（性能）：单站点守卫让窗口化快路径从未被走到

`agent-model` / `channels` / `source-exec` 的 `detect_windows` 都有「站点数为 1 就返回 `null`」的守卫，返回 `null` 会让 `probe.mjs` 回落到整读 268MB 的 full detect（`detect` 与 `observe_substates` 各做一次 `toString('latin1')`，每次约 200ms）。

而真机上这些锚点**恰好各只出现一次**——`describe` 前缀 ×1、`return{action:"register"}` ×1、`tengu_harbor",!` ×1、`tengu_harbor_permissions",!` ×1、`["claude/channel"]&&(` ×1——所以守卫**每次必然触发**，窗口化快路径从未被真正走到。

### 缺陷二（正确性，被缺陷一掩盖）：直接删守卫会把 cap-strip 误报为 absent

守卫其实同时补偿着两个 bug：

1. `probe.mjs` 的 `normalizeSubstates` 在某 kind 只有一个站点时**丢掉序号**：windowed 得 `agent-model:schema`，full 得 `agent-model:schema:0`。
2. `channels.mjs` 的 `records()` 在窗口内没有 decision 时**早退返回 `[]`**，而 `normalizeSubstates` 是**逐窗**调用它的。cap-strip 站点距 decision 约 12MB、独占一个候选窗，该窗返回 `[]`，含 decision 的窗则补出一个**假的** `cap-strip:absent`。

实测复刻完整管线（2.1.217）：

```
windowed（若直接删守卫）: decision=patched feature-flag=patched permissions=patched cap-strip:absent=absent
full-detect            : decision:0=patched feature-flag:0=patched permissions:0=patched cap-strip:0=patched
```

即**把实际已 patched 的 cap-strip 误报成不存在**。substate id 与站点集合会喂给 `validateReplay`，因此这会经 `substate_unreplayable` 阻断**所有** feature 的写入。

### 缺陷三（正确性）：中段站点覆盖盲区

`source-exec` 只扫首尾各 32MB，中段的 `// @bun` 标记被静默漏掉；而 `candidatesComplete` 只检查「候选是否跨越 discovery 边界」、不检查「有没有从未扫过的区域」，所以**连 fail-closed 回落都不触发**，直接违反 spec 的「不允许返回较少站点的快速近似」。

合成 200MB（标记在 1000 / 100M / 199M）实测：两个实现都报 2 个站点，full 报 3 个。这是 JS 与 Python **共有**的漏洞。

### 附带发现：`absent` 占位 offset 无语义却参与严格相等校验

`channels.mjs` 用 `offset: bytes.length`、Python 用 `observed_end`，二者都随输入/窗口长度漂移；而 `validateReplay` 严格比较 offset。实测 full(小输入) `@222` vs full(+1MB) `@1000222`；拿窗口观测当 desired 去 replay 整体字节即抛 `substate_unreplayable`。

## 修复（严格按序）

1. **序号归一化**：无条件保留 `:index`（与 Python 一致），并豁免 `absent` 占位——`substateKind` 的 `/:\d+$/` 剥不掉 `:absent` 后缀，照常补序号会得到 `...:absent:0`。同时删掉零调用者的 `ordinalId`。
2. **`absent` 占位跳过 offset/length 校验**：只校验 identity 与「双方都 absent」。这是根因修法；把占位 offset 统一成某个确定值只是消症状。Python 因为在校验前就过滤掉 absent，不受影响。
3. **channels 跨窗聚合**：拆出逐窗**原始站点**（`observe_raw_sites`）与**一次性**的跨窗聚合（`aggregate_raw_sites`，按 `kind:offset:length` 去重后统一定序号与占位），对齐 `channels.py`。聚合正确后删掉 channels 守卫。
4. **删 agent-model 守卫**。
5. **source-exec 全文件锚点 census**：每个 `// @bun` 命中开 ±8,000 小窗，JS 与 Python 同步改；`candidatesComplete` 里已失效的跨边界规则随之移除（真正的覆盖检查保留）。按 spec 5.2 的要求修订冻结契约条款，并**新增** `mid-file-blind-spot` vector 而非改写既有边界 vector。

## 结果

`cc status` 从 ~2300ms 降到 ~420ms，且**净增**正确性。JS 453 pass / Python 456 pass 全绿；两个真机二进制（2.1.214 clean、2.1.217 patched）上 JS 与 Python 的 state/sites/substates 逐字段一致。

## 教训

- **性能缺陷可能掩盖正确性缺陷**。这里「慢」是因为每次都回落 full detect，而回落恰好掩盖了窗口化路径的两个 bug。看到「有个 fallback 总是被触发」时，先问「快路径为什么从没被走到」，再问「快路径本身对不对」——直接删 fallback 会让潜藏的错误暴露成线上错误。
- **守卫要能说出自己防的是什么**。这三个 `=== 1` 守卫没有任何注释或文档说明理由，实际防的是一个 id 归一化 bug，而非它看起来像的「窗口截断」。无法解释的防御性代码会同时隐藏成本与缺陷。
- **测试可能因为错误的原因变绿**。`probe.test.mjs` 的「aggregates distant channels candidate windows」只因为 `detect_windows` 返回 `null` 走了整读才通过，从未证明它名字里声称的窗口化路径。给它补上「不许整读」的断言后立刻变红。
- **无语义的值不该参与相等校验**。`absent` 占位的 offset 不对应任何字节，让它参与 `validateReplay` 只会制造伪失败。
- **性能预算别按单锚点外推**：单个 `Buffer.indexOf` 全文件扫描约 35ms，但 `locate()` 实际需要 8 个锚点，合计 335-396ms。
