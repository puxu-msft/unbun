// lib/patch-tui.mjs — `cc patch` 的目标选择策略（纯决策）+ 交互式 TUI（@clack/prompts）。
//
// 设计（重新思考，非照搬 Python 的手搓菜单）：把「选哪些二进制」拆成两层——
//   1) resolveSelectionPlan(...)：**纯函数**决策，只看输入（explicit/flags/tty/op 类型/候选数），
//      产出一个 plan：{ mode, targets?, reason? }。mode ∈ direct | interactive | refuse | batch。
//      纯逻辑便于单测，不碰 stdin/stdout、不需要真 TTY。
//   2) runInteractiveSelect(...)：只有 mode==='interactive' 时才调，用 @clack/prompts 的 multiselect
//      （逐个只读探测出 version/status/.bak 作标签）+ 破坏性写的 confirm 二次确认。
//
// 关键取舍：
//   - `--check` 是只读安全操作 → 永远 batch（全部探测），不弹菜单（用户明确要求）。
//   - 破坏性写（patch/revert）+ 多候选 + TTY + 未 --all/未显式 bin → interactive（multiselect + confirm）。
//   - 破坏性写 + 多候选 + **非 TTY** + 未 --all → refuse（CI/管道下不能静默批量，也无法交互）。
//   - `--all` → direct 全部（跳过菜单）。direct 破坏性写在 TTY 下经 confirmDirectWrite 弹一次 confirm
//     （除非 --yes）；非 TTY 视显式 --all 意图为已确认、直接执行。
//   - 显式 `<bin>` / 单候选 → direct（破坏性写同样经 confirmDirectWrite 二次确认，规则同上）。

import { isCancel, multiselect, confirm, cancel, note } from '@clack/prompts'
import { quickProbe, FEATURES } from './patch-binary.mjs'

// selectFeaturesInteractive — 裸 `cc patch`（未给特性）时的引导入口：弹 multiselect 让用户选要施加的特性。
//   返回选中的特性名数组（顺序无关，调用方再规范化）；取消（Esc/Ctrl-C）→ null；空选 → []。
export async function selectFeaturesInteractive({ op } = {}) {
  const actionZh = op === 'revert' ? '还原' : op === 'check' ? '检查' : '打补丁'
  const picked = await multiselect({
    message: `选择要${actionZh}的特性（空格勾选，回车确认）：`,
    options: Object.entries(FEATURES).map(([k, f]) => ({ value: k, label: k, hint: f.label })),
    required: false,
  })
  if (isCancel(picked)) { cancel('已取消。'); return null }
  if (!picked.length) { note('未选择任何特性。', '跳过'); return [] }
  return picked
}

// resolveSelectionPlan — 纯决策，无副作用。
//   入参：{ explicit?, candidates: string[], isWrite: boolean, isTTY: boolean, all: boolean }
//   返回：{ mode, targets?, reason? }
//     - direct      : 直接对 targets 操作（无需交互）
//     - interactive : 需要弹 multiselect（candidates 交给 TUI 层）
//     - batch        : 只读全量探测（--check 多候选）
//     - refuse      : 拒绝（附 reason：无候选 / 非交互破坏性多候选）
export function resolveSelectionPlan({ explicit, candidates, isWrite, isTTY, all }) {
  if (explicit) return { mode: 'direct', targets: [explicit] }
  if (!candidates.length) return { mode: 'refuse', reason: 'no-binary' }
  if (candidates.length === 1) return { mode: 'direct', targets: candidates }
  if (all) return { mode: 'direct', targets: candidates }
  // 多候选、未 --all、未显式：
  if (!isWrite) return { mode: 'batch', targets: candidates } // --check 只读 → 全量探测
  if (isTTY) return { mode: 'interactive' } // 破坏性写 + 可交互 → 菜单多选
  return { mode: 'refuse', reason: 'non-interactive-write' } // 破坏性写 + 非交互 → 拒绝
}

// probeLabel — 逐个只读快速探测（quickProbe：mmap 尾窗），产出菜单标签。探测失败不致命，标 error。
function probeLabel(bin, feature) {
  try {
    const { status, version } = quickProbe(bin, feature)
    return { status, version }
  } catch (err) {
    return { status: 'error', version: null, err: err?.message }
  }
}

// runInteractiveSelect — TTY 下弹 @clack multiselect 选子集，破坏性写再 confirm 二次确认。
//   features 是要施加的特性列表（一次可多个）；菜单标签逐个二进制探测**每个特性**的状态（如
//   `2.1.207  channels:patched agent-model:clean`），便于一眼看清该二进制各特性现状。
//   返回选中的 bin 列表；用户取消（Esc/Ctrl-C）→ 返回 null（调用方据此优雅退出，不改任何文件）。
//   opts.assumeYes 跳过 confirm（-y/--yes，用于半自动脚本仍想看菜单的场景）。
export async function runInteractiveSelect({ candidates, features, op, assumeYes = false } = {}) {
  const actionZh = op === 'revert' ? '还原' : '打补丁'
  const options = candidates.map((bin) => {
    const per = features.map((f) => `${f}:${probeLabel(bin, f).status}`).join(' ')
    const version = probeLabel(bin, features[0]).version
    return { value: bin, label: `${version || '?'}  ${per}`, hint: bin }
  })
  const picked = await multiselect({
    message: `选择要${actionZh}的 claude 二进制（特性 ${features.join(',')}；空格勾选，回车确认）：`,
    options,
    required: false,
  })
  if (isCancel(picked)) { cancel('已取消，未改动任何文件。'); return null }
  if (!picked.length) { note('未选择任何二进制。', '跳过'); return [] }

  if (!assumeYes) {
    const ok = await confirm({
      message: `将就地${actionZh} ${picked.length} 个 live 二进制的 [${features.join(',')}]（channels 会先建/刷新 .bak）。继续？`,
      initialValue: false,
    })
    if (isCancel(ok) || !ok) { cancel('已取消，未改动任何文件。'); return null }
  }
  return picked
}

// confirmDirectWrite — direct 模式（显式 bin / 单候选 / --all）的破坏性写二次确认。
//   TTY 且未 assumeYes 时弹一次 confirm；非 TTY（无法交互）或 --yes → 直接放行（视显式意图为已确认）。
//   features 仅用于确认消息展示要施加哪些特性。返回 true=继续、false=用户否决/取消（不改任何文件）。
export async function confirmDirectWrite({ targets, features, op, isTTY, assumeYes = false } = {}) {
  if (assumeYes || !isTTY) return true
  const actionZh = op === 'revert' ? '还原' : '打补丁'
  const featStr = features && features.length ? ` 的 [${features.join(',')}]` : ''
  const ok = await confirm({
    message: `将就地${actionZh} ${targets.length} 个 live 二进制${featStr}（channels 会先建/刷新 .bak）。继续？`,
    initialValue: false,
  })
  if (isCancel(ok) || !ok) { cancel('已取消，未改动任何文件。'); return false }
  return true
}
