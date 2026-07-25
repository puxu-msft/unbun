// lib/probes/dump-assets.cjs — 跑在**真 Bun 运行时**里（经 loader-hook 注入的 CC_EXT 加载）。
//
// 前置：目标二进制已被 `unbun cc patch-loader-hook` 等长打桩，模块顶层、main 之前
//       `require(process.env.CC_EXT)` 本文件。此时 `Bun.embeddedFiles` 已填充。
//
// 职责（并入 archive/dump-embedded-resources.cjs 的遍历写盘逻辑）：
//   遍历 `Bun.embeddedFiles`，把每个 `with { type: 'file' }` 嵌入的原生件写盘到
//   `process.env.DUMP_DIR`，并向 stdout 打一行机器可读的 `UNBUN_PROBE_JSON {...}`（名/尺寸清单），
//   然后 process.exit(0)（在 main 真正跑起来之前收口）。
//
// 用法：
//   DUMP_DIR=/abs/out  经 cc introspect --probe assets 注入；或手动
//   CC_EXT=/abs/lib/probes/dump-assets.cjs DUMP_DIR=/abs/out <patched-binary> --version
//
// 2.1.x 真 claude 实测吐出 2 个原生件：audio-capture.node、image-processor.node。
// 注：整个 app 是纯 JS，走 bundle（extract/split），**不在** embeddedFiles 里 —— 故 embeddedFiles
//     是「静态资产集」的**真子集**（app bundle / JS 模块只在静态里），这正是子集 oracle 的依据。
'use strict'
const fs = require('node:fs')
const path = require('node:path')

const files = typeof Bun !== 'undefined' && Bun.embeddedFiles ? Bun.embeddedFiles : []

// 先**同步**采名/尺寸并打 marker：即便随后 app main 抢跑，清单也已产出（Blob.name/.size 同步可得）。
// name 归一：去掉 `/$bunfs/root/` 前缀（真 claude 的 f.name 可能带该前缀；bun 1.3.x fixture 已是 basename）。
const strip = (n) => (n ? String(n).replace(/^\/?\$bunfs\/root\//, '') : n)
const meta = files.map((f, i) => ({
  name: f && f.name ? strip(f.name) : `blob-${i}`,
  size: f && typeof f.size === 'number' ? f.size : null,
}))
process.stdout.write('UNBUN_PROBE_JSON ' + JSON.stringify({ probe: 'assets', count: files.length, files: meta }) + '\n')

// 再异步写盘（原 dump-embedded-resources 逻辑），写完 exit(0)。DUMP_DIR 缺省则只打清单不落盘。
;(async () => {
  const out = process.env.DUMP_DIR
  if (out) {
    let total = 0
    for (let i = 0; i < files.length; i++) {
      const f = files[i]
      const name = meta[i].name
      const dest = path.join(out, name)
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      const buf = Buffer.from(await f.arrayBuffer())
      fs.writeFileSync(dest, buf)
      total += buf.length
      console.error('[dump]', String(buf.length).padStart(10), name)
    }
    console.error(`[dump] wrote ${files.length} file(s), ${(total / 1e6).toFixed(2)} MB -> ${out}`)
  }
  process.exit(0)
})().catch((e) => {
  console.error('[dump] error:', e && e.message)
  process.exit(1)
})
