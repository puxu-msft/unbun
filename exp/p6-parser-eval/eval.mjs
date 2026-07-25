// exp/p6-parser-eval/eval.mjs — P6 spike：评估更快解析器替代 acorn 做 split 的模块识别。
//
// 前置：先 `bun dump-app.mjs`（抽 app 到 /tmp/unbun-app.js）。跑 oxc 对比要在**隔离临时目录**装
// oxc-parser（别在项目内 `bun add`，会污染 package.json/bun.lock——结论是保 acorn，故意不加 deps；
// 见 README 复现节）。未装 oxc 时本脚本优雅只跑 acorn 基线。
//
// 复刻 split.mjs 的识别层（findOuter / discover / 切模块），在同一 app 上分别跑 acorn 与 oxc，验：
//   ① 正确性：两解析器给出**逐模块字节区间 + helper 集合完全一致**（byte-identical）；
//   ② 性能：端到端「解析 + 消费 AST 拿到全部模块」的墙钟耗时。
// 结论（见 README）：oxc AST 与 acorn byte-identical，但默认 eager 路更慢——访问 `.program` 一次性
// eager 物化整棵 ESTree ~3.3s（parseSync 返回本身只 ~1s）。唯一绕开它的 lazy/raw-transfer 剪枝路在
// Bun 上直接抛错不可用（rawTransferSupported()===false），node 上则暴露 native 非 ESTree AST。故保 acorn。
import { readFileSync } from 'node:fs'
import { Parser } from 'acorn'

const app = readFileSync('/tmp/unbun-app.js', 'utf8')

// —— split.mjs 识别层的忠实复刻（oxc 默认 preserveParens:true，故 unwrap 多认 ParenthesizedExpression）——
function unwrap(n) {
  if (!n) return null
  if (n.type === 'FunctionExpression') return n
  if (n.type === 'ParenthesizedExpression') return unwrap(n.expression)
  if (n.type === 'CallExpression') return unwrap(n.callee)
  return null
}
function findOuter(ast) {
  for (const s of ast.body) {
    if (s.type !== 'ExpressionStatement') continue
    const fn = unwrap(s.expression)
    if (fn && fn.params[0]?.type === 'Identifier' && fn.params[0].name === 'exports') return fn
  }
  throw new Error('no outer IIFE')
}
function discover(body) {
  const stats = new Map()
  for (const s of body) {
    if (s.type !== 'VariableDeclaration') continue
    for (const d of s.declarations) {
      const c = d.init
      if (c?.type !== 'CallExpression' || c.callee.type !== 'Identifier' || c.arguments.length !== 1) continue
      const cb = c.arguments[0]
      if (cb.type !== 'ArrowFunctionExpression' && cb.type !== 'FunctionExpression') continue
      const n = c.callee.name
      const x = stats.get(n) ?? { count: 0, zero: 0, nonzero: 0 }
      x.count++
      cb.params.length === 0 ? x.zero++ : x.nonzero++
      stats.set(n, x)
    }
  }
  const esm = new Set()
  const cjs = new Set()
  for (const [n, x] of stats) {
    if (x.count <= 1) continue
    x.zero >= x.nonzero ? esm.add(n) : cjs.add(n)
  }
  return { esm, cjs }
}
function split(ast) {
  const body = findOuter(ast).body.body
  const h = discover(body)
  const mods = []
  let seq = 0
  for (const s of body) {
    if (s.type !== 'VariableDeclaration') continue
    for (const d of s.declarations) {
      const c = d.init
      if (c?.type !== 'CallExpression' || c.callee.type !== 'Identifier') continue
      const kind = h.esm.has(c.callee.name) ? 'esm' : h.cjs.has(c.callee.name) ? 'cjs' : null
      if (!kind) continue
      mods.push({ seq: seq++, handle: d.id.name, kind, start: d.start, end: d.end })
    }
  }
  return { mods, h }
}

// —— 候选装载（oxc 可选：未 `bun add oxc-parser` 时优雅跳过）——
let oxc = null
try {
  oxc = await import('oxc-parser')
} catch {
  console.log('(oxc-parser 未安装；只跑 acorn 基线。`bun add oxc-parser` 后再跑可比对。)\n')
}

function bench(label, parse, iters = 3) {
  const times = []
  let last
  for (let i = 0; i < iters; i++) {
    const t = performance.now()
    last = split(parse())
    times.push(performance.now() - t)
  }
  const min = Math.min(...times).toFixed(0)
  const max = Math.max(...times).toFixed(0)
  console.log(`${label}: ${min}-${max}ms (parse+consume+split) | modules=${last.mods.length} esm=[${[...last.h.esm]}] cjs=[${[...last.h.cjs]}]`)
  return last
}

console.log(`app=${(app.length / 1e6).toFixed(1)}MB non-ASCII=${/[^\x00-\x7f]/.test(app) ? 'YES' : 'none'}\n`)
const a = bench('acorn      ', () => Parser.parse(app, { ecmaVersion: 'latest', ranges: true }))
if (oxc) {
  const o = bench('oxc(r:false)', () => oxc.parseSync('app.js', app, { sourceType: 'script', range: false }).program)
  // 正确性：逐模块 byte-identical？
  let mism = 0
  const n = Math.max(a.mods.length, o.mods.length)
  for (let i = 0; i < n; i++) {
    const am = a.mods[i]
    const om = o.mods[i]
    if (!am || !om || am.start !== om.start || am.end !== om.end || am.kind !== om.kind || am.handle !== om.handle) mism++
  }
  console.log(`\nbyte-identical check: ${mism} mismatches / ${n} modules (0 = oxc AST 与 acorn 逐模块字节一致)`)
}
