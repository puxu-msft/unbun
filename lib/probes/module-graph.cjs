// lib/probes/module-graph.cjs — 跑在**真 Bun 运行时**里（经 loader-hook 注入的 CC_EXT 加载）。
//
// 前置：目标二进制已被 `unbun cc patch-loader-hook` 等长打桩，模块顶层、main 之前 require 本文件。
//
// 职责：instrument `require`（wrap `Module._load`）记录**运行时**模块加载顺序 → JSON（写
//       `process.env.GRAPH_OUT` 或 stderr，并向 stdout 打 `UNBUN_PROBE_JSON {...}`）。
//
// ── 重要局限（诚实，评审要求）────────────────────────────────────────────────
//   Bun `--compile` SFX 把**整个 app 的模块图预打包/内联**进 bundle：app 内部模块**不经**运行时
//   `require`/`Module._load` 加载（它们在 bundle 里就是内联的函数闭包）。因此 wrap `Module._load`
//   **只能**捕获**运行时惰性加载**的东西——node/bun 内建模块、`.node` 原生插件、以及外部
//   （非嵌入）文件的 require。它**无法**还原 app 的静态内部模块图（那要走静态 `unbun split`/
//   `module-graph.mjs` 解 StandaloneModuleGraph）。故本 probe 的产物是「运行时惰性加载序 +
//   Bun.embeddedFiles 快照」，不是 app 完整内部依赖图；后者是**静态**命令的职责。
//
// 退出策略：安装 hook 后**不立即** process.exit——让 app 自然跑（如 `--version` 很快自退），
//   `process.on('exit')` 时 dump（捕获 main 期间的惰性 require）。另设一个 **unref 的安全超时**：
//   仅当事件循环因 app 仍在跑而存活时才触发（app 挂住/交互时兜底 dump+exit），不拖慢快退的 app。
'use strict'
const fs = require('node:fs')
const Module = require('node:module')

const order = [] // 运行时惰性加载序：{ request, seq }
let seq = 0
const orig = Module._load
Module._load = function (request, parent, isMain) {
  order.push({ request, seq: seq++ })
  return orig.apply(this, arguments)
}

const files = typeof Bun !== 'undefined' && Bun.embeddedFiles ? Bun.embeddedFiles : []
const strip = (n) => (n ? String(n).replace(/^\/?\$bunfs\/root\//, '') : n)

let dumped = false
function dump() {
  if (dumped) return
  dumped = true
  const result = {
    probe: 'graph',
    note:
      'runtime require() instrumentation only; --compile inlines app modules (not require-loaded), ' +
      'so this captures lazy builtin/native/external requires + embeddedFiles, NOT the app internal graph ' +
      '(use static `unbun split` for that).',
    bunVersion: typeof Bun !== 'undefined' ? Bun.version : null,
    runtimeLoads: order.slice(),
    embeddedFiles: files.map((f, i) => ({
      name: f && f.name ? strip(f.name) : `blob-${i}`,
      size: f && typeof f.size === 'number' ? f.size : null,
    })),
  }
  const json = JSON.stringify(result, null, 2)
  if (process.env.GRAPH_OUT) {
    try {
      fs.writeFileSync(process.env.GRAPH_OUT, json + '\n')
      console.error('[graph] wrote', process.env.GRAPH_OUT)
    } catch (e) {
      console.error('[graph] write failed:', e && e.message)
    }
  } else {
    console.error('[graph]', json)
  }
  process.stdout.write('UNBUN_PROBE_JSON ' + JSON.stringify(result) + '\n')
}

process.on('exit', dump)
// unref 安全超时：只在 app 仍占着事件循环（跑/挂）时兜底，不拖慢自然快退的 app。
const t = setTimeout(() => {
  dump()
  process.exit(0)
}, 3000)
if (t && typeof t.unref === 'function') t.unref()
