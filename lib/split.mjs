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
// 真正把它们与真 helper 分开的是**外层顶层定义体语义 + 调用 arity**：先在外层 body 顶层识别
// `__esm`/`__commonJS` 的稳定 AST 定义签名，再只接纳对应 callback arity 的顶层调用。体内 lookalike、
// 顶层无定义的同形调用、以及定义与调用 arity 不一致都会被排除或 fail-loud。
// 另保留**相对**安全网：候选须在外层顶层出现 **>1 次**（真 helper 每模块调一次 → 数千次；
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
      if (!kind) continue // 只有定义体匹配已知 helper 语义的 callee 才接纳
      const cb = call.arguments[0]
      const arity = cb?.type === 'ArrowFunctionExpression' || cb?.type === 'FunctionExpression' ? cb.params.length : -1
      if ((kind === 'esm' && arity !== 0) || (kind === 'cjs' && (arity < 1 || arity > 2))) {
        throw new Error(`splitModules: ${kind} helper ${name} called with incompatible callback arity ${arity}`)
      }
      // start/end = 该 declarator 的字节边界（d.start/d.end），多声明符 `var A=…,B=…` 下也精确到
      // 单个 declarator；切片是 `X=<helper>(…)`（不含前导 `var`、声明符间 `,`、末尾 `;`）。
      // hash 排除 declarator handle，只覆盖初始化表达式。这样 minifier 仅改 `a=...`→`x=...` 时内容身份稳定，
      // 而不同初始化内容仍有精确 hash，避免退回 (kind,bytes) 的误配。
      const normalized = app.slice(d.init.start, d.init.end)
      const hash = createHash('sha256').update(normalized).digest('hex').slice(0, 16)
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

// 在**外层 body 顶层**按稳定 AST 语义识别两类 helper 定义，并统计其顶层 callback 调用。
// 候选须定义签名匹配且顶层出现 > MIN_TOPLEVEL_HITS；调用处再独立校验 callback arity。
// 返回可能为空集（wrapper-less / 未来布局变动的 SFX）——这是 spec 规定的 best-effort 结果、非错误；
// claude 消费者的 helper 非空性由 test/split.test.mjs 正向断言兜底（非静默吞错）。
function discoverHelpers(body) {
  const esm = new Set()
  const cjs = new Set()
  const calls = new Map()
  for (const stmt of body) {
    if (stmt.type !== 'VariableDeclaration') continue
    for (const d of stmt.declarations) {
      if (d.id.type === 'Identifier') {
        const kind = classifyHelperDefinition(d.init)
        if (kind === 'esm') esm.add(d.id.name)
        else if (kind === 'cjs') cjs.add(d.id.name)
      }
      const call = d.init
      if (call?.type !== 'CallExpression' || call.callee.type !== 'Identifier' || call.arguments.length !== 1) continue
      const cb = call.arguments[0]
      if (cb.type !== 'ArrowFunctionExpression' && cb.type !== 'FunctionExpression') continue
      calls.set(call.callee.name, (calls.get(call.callee.name) ?? 0) + 1)
    }
  }
  for (const names of [esm, cjs]) {
    for (const name of names) if ((calls.get(name) ?? 0) <= MIN_TOPLEVEL_HITS) names.delete(name)
  }
  return { esm, cjs }
}

function classifyHelperDefinition(node) {
  if (node?.type !== 'ArrowFunctionExpression' || node.params.length !== 2 || node.body?.type !== 'ArrowFunctionExpression' || node.body.params.length !== 0) return null
  const [first, memo] = node.params
  if (first.type !== 'Identifier' || memo.type !== 'Identifier') return null
  const body = node.body.body
  if (body?.type !== 'SequenceExpression' || body.expressions.length !== 2) return null
  const [guard, result] = body.expressions
  if (guard?.type !== 'LogicalExpression') return null
  if (guard.operator === '&&' && isId(guard.left, first.name) && isId(result, memo.name) && isEsmAssignment(guard.right, first.name, memo.name)) return 'esm'
  if (guard.operator === '||' && isId(guard.left, memo.name) && isExportsMember(result, memo.name) && isCommonJsCall(guard.right, first.name, memo.name)) return 'cjs'
  return null
}

const isId = (node, name) => node?.type === 'Identifier' && node.name === name
const isExportsMember = (node, name) => node?.type === 'MemberExpression' && !node.computed && isId(node.object, name) && isId(node.property, 'exports')

function isEsmAssignment(node, first, memo) {
  const call = node?.type === 'AssignmentExpression' && node.operator === '=' && isId(node.left, memo) ? node.right : null
  const reset = call?.type === 'CallExpression' && isId(call.callee, first) && call.arguments.length === 1 ? call.arguments[0] : null
  return reset?.type === 'AssignmentExpression' && reset.operator === '=' && isId(reset.left, first) && reset.right?.type === 'Literal' && reset.right.value === 0
}

function isCommonJsCall(node, first, memo) {
  if (node?.type !== 'CallExpression' || !isId(node.callee, first) || node.arguments.length !== 2 || !isId(node.arguments[1], memo)) return false
  const exportsArg = node.arguments[0]
  if (exportsArg?.type !== 'MemberExpression' || exportsArg.computed || !isId(exportsArg.property, 'exports')) return false
  const assignment = exportsArg.object
  if (assignment?.type !== 'AssignmentExpression' || assignment.operator !== '=' || !isId(assignment.left, memo)) return false
  const properties = assignment.right?.type === 'ObjectExpression' ? assignment.right.properties : []
  return properties.length === 1 && isId(properties[0].key, 'exports') && properties[0].value?.type === 'ObjectExpression'
}
