// lib/split.mjs — 把 app bundle 按模块 wrapper 切成 per-module 数组。
//
// Bun `--compile` 的入口 bundle 是一个 `@bun-cjs` 外层 IIFE，体内顶层用两族 minify 后的 helper
// 把每个原始模块包成懒初始化 wrapper（FINDINGS-phase0.md P0-c）：
//   - `__esm`（ESM 懒初始化，零参 thunk）：`var X=<esmHelper>(()=>…)`
//   - `__commonJS`（双参回调）：       `var X=<cjsHelper>((exports,module)=>…)`
// helper 局部名由 minifier 分配、**跨版本必漂移**（实测 esm=b/cjs=K@205、esm=E/cjs=J@201），绝不硬编码。
//
// 识别地基（评审 M2）：naive「arrow 返回 arrow」签名会误捞模块**体内**的 memoizer lookalike
// （实测 205 有 6 个满足该签名且高频：Se×749、Ve×189、ar×164…，频率远**高于**任何绝对阈值）。
// 真正把它们与真 helper 分开的**不是频率**，而是**外层 IIFE 顶层作用域 + callback arity** 两条：
//   1. 真族只在外层 body **顶层**以 `var X=name(callback)` 出现；lookalike 从不在外层顶层作
//      `var X=name(...)`（只在各模块体内被调）——故只扫「外层顶层 var-decl」即天然排除全部 lookalike，
//      与它们被调多少次无关。
//   2. 候选再按 callback arity 二分：零参 thunk `()=>…`→esm、含参 `(exports[,module])=>…`→cjs。
// 唯一保留的是**相对**安全网：候选须在外层顶层出现 **>1 次**（真 helper 每模块调一次 → 数千次；
// 一次性 stray `var x=f(()=>…)` 排除）。不设绝对下限——spec 定位工具服务任意 bun SFX、split 是
// 通用 best-effort 命令，一个 ~30 模块小 SFX 的 helper 只用 ~30 次也须成立。
import { Parser } from 'acorn'
import { createHash } from 'node:crypto'

const MIN_TOPLEVEL_HITS = 1 // 候选 helper 须在外层顶层出现 > 此值（相对安全网，排一次性 stray；非绝对频率）

export function splitModules(app) {
  const ast = Parser.parse(app, { ecmaVersion: 'latest', ranges: true })
  const outer = findOuterIife(ast)
  const body = outer.body.body // 外层函数体的顶层语句
  const helpers = discoverHelpers(body) // { esm:Set<string>, cjs:Set<string> }
  const modules = []
  let seq = 0
  for (const stmt of body) {
    if (stmt.type !== 'VariableDeclaration') continue
    for (const d of stmt.declarations) {
      const call = d.init
      if (call?.type !== 'CallExpression' || call.callee.type !== 'Identifier') continue
      const name = call.callee.name
      const kind = helpers.esm.has(name) ? 'esm' : helpers.cjs.has(name) ? 'cjs' : null
      if (!kind) continue // 've'/'Se' 等体内 memoizer lookalike 因非外层顶层 helper 自动排除
      // start/end = 该 declarator 的字节边界（d.start/d.end），多声明符 `var A=…,B=…` 下也精确到
      // 单个 declarator；切片是 `X=<helper>(…)`（不含前导 `var`、声明符间 `,`、末尾 `;`）。
      // hash = 该模块源字节 app.slice(start,end) 的 sha256 前 16 hex：作 diff 的**精确内容身份**，
      // 替代 (kind,bytes) 近似指纹——两个不同模块恰好同 (kind,bytes) 不会再撞（16 hex=64 bit 足够辨识
      // 6000+ 模块）。E5=A6：richest-context，split 侧算好放进 index，diff 侧直接消费做精确配对。
      const src = app.slice(d.start, d.end)
      const hash = createHash('sha256').update(src).digest('hex').slice(0, 16)
      modules.push({ seq: seq++, handle: d.id.name, kind, start: d.start, end: d.end, hash })
    }
  }
  return { modules, helpers: { esm: [...helpers.esm], cjs: [...helpers.cjs] } }
}

// 外层 IIFE：program 顶层的 `@bun-cjs` 模块 wrapper —— 一个 params 以 `exports` 打头的
// FunctionExpression（`(function(exports,require,module,__filename,__dirname){…})`）。
// 它可能被解析为裸表达式语句、或包在 CallExpression 里（loader 立即调用），两种都下钻。
function findOuterIife(ast) {
  for (const stmt of ast.body) {
    if (stmt.type !== 'ExpressionStatement') continue
    const fn = unwrapToFunction(stmt.expression)
    if (fn && fn.params[0]?.type === 'Identifier' && fn.params[0].name === 'exports') return fn
  }
  throw new Error('splitModules: no outer @bun-cjs (function(exports,…){…}) IIFE found')
}

// 剥到底层 FunctionExpression：直接的、或 CallExpression 的 callee（IIFE 调用形态）。
function unwrapToFunction(node) {
  if (!node) return null
  if (node.type === 'FunctionExpression') return node
  if (node.type === 'CallExpression') return unwrapToFunction(node.callee)
  return null
}

// 只统计**外层 body 顶层** `var X=<Ident>(<单个 callback>)` 的 callee 频率与 callback arity。
// 「只看顶层」这一步就排除了全部体内 memoizer lookalike（它们从不在此出现），与其调用次数无关。
// 候选须顶层出现 > MIN_TOPLEVEL_HITS（相对安全网，排一次性 stray）；按 arity 二分 esm/cjs。
// 返回可能为空集（wrapper-less / 未来布局变动的 SFX）——这是 spec 规定的 best-effort 结果、非错误；
// claude 消费者的 helper 非空性由 test/split.test.mjs 正向断言兜底（非静默吞错）。
function discoverHelpers(body) {
  const stats = new Map() // name -> { count, zero, nonzero }
  for (const stmt of body) {
    if (stmt.type !== 'VariableDeclaration') continue
    for (const d of stmt.declarations) {
      const call = d.init
      if (call?.type !== 'CallExpression' || call.callee.type !== 'Identifier') continue
      if (call.arguments.length !== 1) continue // 真族恒单参 callback
      const cb = call.arguments[0]
      if (cb.type !== 'ArrowFunctionExpression' && cb.type !== 'FunctionExpression') continue
      const name = call.callee.name
      const s = stats.get(name) ?? { count: 0, zero: 0, nonzero: 0 }
      s.count++
      if (cb.params.length === 0) s.zero++
      else s.nonzero++
      stats.set(name, s)
    }
  }
  const esm = new Set()
  const cjs = new Set()
  for (const [name, s] of stats) {
    if (s.count <= MIN_TOPLEVEL_HITS) continue // 一次性 stray 排除（相对，非绝对频率下限）
    if (s.zero >= s.nonzero) esm.add(name) // 零参 thunk 占多数 → __esm
    else cjs.add(name) // 含参回调 → __commonJS
  }
  return { esm, cjs }
}
