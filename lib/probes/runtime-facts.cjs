// lib/probes/runtime-facts.cjs — 跑在**真 Bun 运行时**里（经 loader-hook 注入的 CC_EXT 加载）。
//
// 前置：目标二进制已被 `unbun cc patch-loader-hook` 等长打桩，模块顶层、main 之前 require 本文件。
//
// 职责：采集一份「运行时事实」快照 → JSON。写到 `process.env.FACTS_OUT`（若给），否则打到 stderr；
//       并向 stdout 打机器可读的 `UNBUN_PROBE_JSON {...}`，然后 process.exit(0)。
//   采集项（richest-context：尽量全带上，下游按需裁剪）：
//     - appVersion   目标 app 自身版本：**best-effort**。--compile SFX 里 app 版本不是运行时全局，
//                    这里探若干常见位置（globalThis.VERSION / 环境），拿不到就 null（诚实，不伪造）。
//     - bunVersion   Bun.version（引擎版本）
//     - processVersion / processVersions   node 兼容版本号 + 全量 versions 映射
//     - embeddedFiles   [{name,size}]（同 dump-assets 的归一名）
//     - env           选定的相关环境变量存在性（不外泄值，只记 true/false + CC_EXT 路径本身）
'use strict'
const fs = require('node:fs')

const files = typeof Bun !== 'undefined' && Bun.embeddedFiles ? Bun.embeddedFiles : []
const strip = (n) => (n ? String(n).replace(/^\/?\$bunfs\/root\//, '') : n)

// appVersion：探常见运行时暴露位；拿不到 → null（诚实）。绝不跑 app 逻辑去逼版本。
let appVersion = null
try {
  if (typeof globalThis.VERSION === 'string') appVersion = globalThis.VERSION
  else if (typeof globalThis.__APP_VERSION__ === 'string') appVersion = globalThis.__APP_VERSION__
} catch { /* best-effort, keep null */ }

const facts = {
  probe: 'facts',
  appVersion,
  bunVersion: typeof Bun !== 'undefined' ? Bun.version : null,
  processVersion: process.version,
  processVersions: { ...process.versions },
  embeddedFiles: files.map((f, i) => ({
    name: f && f.name ? strip(f.name) : `blob-${i}`,
    size: f && typeof f.size === 'number' ? f.size : null,
  })),
  env: {
    // 只记存在性/无害路径，不外泄任意 env 值。
    CC_EXT: process.env.CC_EXT || null,
    hasDumpDir: !!process.env.DUMP_DIR,
    hasFactsOut: !!process.env.FACTS_OUT,
    hasGraphOut: !!process.env.GRAPH_OUT,
  },
}

const json = JSON.stringify(facts, null, 2)
if (process.env.FACTS_OUT) {
  try {
    fs.writeFileSync(process.env.FACTS_OUT, json + '\n')
    console.error('[facts] wrote', process.env.FACTS_OUT)
  } catch (e) {
    console.error('[facts] write failed:', e && e.message)
  }
} else {
  console.error('[facts]', json)
}
// stdout 机器可读单行（下游 cc introspect 解析）。
process.stdout.write('UNBUN_PROBE_JSON ' + JSON.stringify(facts) + '\n')
process.exit(0)
