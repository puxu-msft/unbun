// exp/p6-parser-eval/dump-app.mjs — 把真 claude SFX 的入口 app bundle 抽到 /tmp/unbun-app.js，
// 供 eval.mjs 反复解析测时（免每次重读 257MB 二进制）。跑一次即可。
import { extractApp } from '../../lib/extract.mjs'
import { defaultBinary } from '../../lib/bun-binary.mjs'
import { writeFileSync } from 'node:fs'

const t0 = performance.now()
const { app, version } = extractApp(defaultBinary())
writeFileSync('/tmp/unbun-app.js', app)
console.log(
  `extractApp: ${(performance.now() - t0).toFixed(0)}ms | app=${(app.length / 1e6).toFixed(1)}MB` +
    ` | version=${version} | non-ASCII=${/[^\x00-\x7f]/.test(app) ? 'YES' : 'none (UTF-16 offset test vacuous!)'}`,
)
console.log('wrote /tmp/unbun-app.js')
