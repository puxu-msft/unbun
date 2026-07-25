// test/split.test.mjs — 动态 helper 识别 + 按模块 wrapper 切分 app bundle。
// 判据不是「非空」（评审 M2）：helper 集合规模有界（≤5，反过匹配护栏，防把 45 个体内 memoizer
// lookalike 全认成 helper）；esm/cjs 计数落量级带（跨小版本稳、不 pin 精确数）；总模块数不因
// 误捞 body-local memoizer（其调用点 ~600 量级）而暴涨；跨区间抽样模块可 acorn 独立重解析。
import { test, expect, beforeAll } from 'bun:test'
import { createHash } from 'node:crypto'
import { extractApp } from '../lib/extract.mjs'
import { splitModules } from '../lib/split.mjs'
import { defaultBinary } from '../lib/bun-binary.mjs'
import { Parser } from 'acorn'

// app 抽取要读 257MB binary + 权威切 ~19MB；splitModules 又 acorn 全解析 ~19MB（~3s/次）。二者都在
// beforeAll 缓存一次：extractApp 一次得 app；splitModules 一次得 split，供多用例复用（不改 lib 接口）。
// 复用红线：① M2 判别式的**独立 oracle**（自建 Parser.parse(app) 复刻识别池）绝不复用 split 的内部 AST；
// ② E5 的确定性判据仍**独立重算**一次 splitModules 做 b（缓存的 split 作 a）——两次独立运行同 hash 才算
// 确定性成立，绝不拿同一对象自比而空转。
let app, split
beforeAll(() => {
  app = extractApp(defaultBinary()).app
  split = splitModules(app)
})

test('discovers exactly the two real helper families; excludes body-local lookalikes', () => {
  const { modules, helpers } = split
  // 正向：两族均识别到，且 helper 集合规模有界（不该把 45 个 memoizer 全认成 helper）
  expect(helpers.esm.length).toBeGreaterThan(0)
  expect(helpers.cjs.length).toBeGreaterThan(0)
  expect(helpers.esm.length + helpers.cjs.length).toBeLessThanOrEqual(5) // 反过匹配护栏
  // 计数落在量级带内（余量足、跨小版本稳；不 pin 精确数）
  const esm = modules.filter((m) => m.kind === 'esm').length
  const cjs = modules.filter((m) => m.kind === 'cjs').length
  expect(esm).toBeGreaterThan(3000); expect(esm).toBeLessThan(6000)
  expect(cjs).toBeGreaterThan(1000); expect(cjs).toBeLessThan(2500)
  // 反向：body-local memoizer（其调用点数量级 ~600）不得被当模块——总模块数不该暴涨到含它们
  expect(modules.length).toBeLessThan(esm + cjs + 200)
  // 每个模块可被 acorn 独立重解析（跨区间抽样，非只前 5）
  for (const i of [0, (modules.length >> 1), modules.length - 1]) {
    const m = modules[i]
    expect(() => Parser.parse(app.slice(m.start, m.end), { ecmaVersion: 'latest' })).not.toThrow()
  }
})

// M2 判别式（评审 Important 1）：直接兜「高频 body-local memoizer lookalike 绝不被当 helper」，
// 独立于 helpers≤5 护栏（那道要两族全崩才红）、也**不依赖频率巧合**。用**独立 oracle** 从 AST
// 复刻识别池：找所有满足 naive「name(单个 fn callback)」签名、全深度**高频（>50）**被调、却**从不**
// 在外层顶层作 `var X=name(cb)` 的 identifier —— 这些正是「频率不排、唯有顶层作用域才排」的
// lookalike（205 实测 Se×749、Ve×189、ar×164…共 6 个，频率远高于任何绝对阈值）。断言：① 确有此类
// lookalike 存在（非空测，否则本用例空转）；② 它们无一落入 helpers。若把 split 的「只扫顶层」退化成
// 全深度扫，这些高频 lookalike 立刻被认成 helper → 本用例转红（revert-red 证其非空）。
test('M2 discriminant: high-frequency body-local memoizer lookalikes are never treated as helpers', () => {
  const { helpers } = split
  const helperNames = new Set([...helpers.esm, ...helpers.cjs])

  const ast = Parser.parse(app, { ecmaVersion: 'latest', ranges: true })
  // 独立找外层 IIFE（不复用 split 的内部函数）
  let outer
  for (const stmt of ast.body) {
    if (stmt.type !== 'ExpressionStatement') continue
    let n = stmt.expression
    while (n && n.type === 'CallExpression') n = n.callee
    if (n && n.type === 'FunctionExpression' && n.params[0]?.name === 'exports') { outer = n; break }
  }
  expect(outer).toBeDefined()

  // 外层顶层出现集（真 helper 只在此）
  const topLevel = new Set()
  for (const stmt of outer.body.body) {
    if (stmt.type !== 'VariableDeclaration') continue
    for (const d of stmt.declarations) {
      const c = d.init
      if (c?.type === 'CallExpression' && c.callee.type === 'Identifier' && c.arguments.length === 1) {
        const cb = c.arguments[0]
        if (cb.type === 'ArrowFunctionExpression' || cb.type === 'FunctionExpression') topLevel.add(c.callee.name)
      }
    }
  }
  // 全深度 `name(单个 fn callback)` 频率
  const freq = new Map()
  ;(function walk(node) {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { for (const x of node) walk(x); return }
    if (node.type === 'CallExpression' && node.callee?.type === 'Identifier' && node.arguments.length === 1) {
      const cb = node.arguments[0]
      if (cb.type === 'ArrowFunctionExpression' || cb.type === 'FunctionExpression') {
        freq.set(node.callee.name, (freq.get(node.callee.name) ?? 0) + 1)
      }
    }
    for (const k in node) { if (k === 'start' || k === 'end' || k === 'range' || k === 'loc') continue; walk(node[k]) }
  })(outer.body)

  const lookalikes = [...freq].filter(([name, f]) => f > 50 && !topLevel.has(name)).map(([n]) => n)
  expect(lookalikes.length).toBeGreaterThan(0) // 非空测：binary 里确有高频体内 memoizer，本判别式不空转
  for (const name of lookalikes) {
    expect(helperNames.has(name)).toBe(false) // 高频 ≠ helper：唯顶层作用域才是判别器
  }
}, 30000) // 二次解析 ~19MB app + 全深度 walk，放宽超时（默认 5s 不够）

// E5 = A6：每模块带**内容哈希**（sha256 前 16 hex），作 diff 的精确身份。断言：① 每模块 hash 是
// 16 位小写 hex；② 稳定（同输入同 hash）；③ 是真·内容哈希（独立 oracle 重算 sha256(app.slice) 一致）。
test('E5：每模块有稳定内容哈希（16 hex、同输入同 hash、== 独立 sha256 重算）', () => {
  const a = split // 缓存的首次运行结果
  const b = splitModules(app) // **独立**重算一次：与 a 比对才能非空地证「同输入同 hash」（确定性）
  expect(a.modules.length).toBe(b.modules.length)
  // 抽样跨区间若干模块（全量重算 sha256 慢；抽样足以证契约）。
  for (const i of [0, a.modules.length >> 1, a.modules.length - 1]) {
    const m = a.modules[i]
    expect(m.hash).toMatch(/^[0-9a-f]{16}$/) // 16 位小写 hex
    expect(m.hash).toBe(b.modules[i].hash) // 稳定：同输入同 hash
    // 独立 oracle：hash 确为模块源字节 app.slice(start,end) 的 sha256 前 16 hex（非某派生量）。
    const oracle = createHash('sha256').update(app.slice(m.start, m.end)).digest('hex').slice(0, 16)
    expect(m.hash).toBe(oracle)
  }
}, 30000)
