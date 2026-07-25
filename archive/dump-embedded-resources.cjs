// ARCHIVED — 已迁入 tools/unbun/lib/probes/dump-assets.cjs + cli.mjs cc introspect。勿运行。
// dump-embedded-resources.cjs —  让 claude 自己吐出内置原生资产。
//
// 前置条件：claude binary 经 patch-loader-hook 注入，支持用 CC_EXT 指向外部入口
//
// 本文件跑在 claude **真实 bun 运行时**里，此时 Bun.embeddedFiles 已填充。遍历写盘即得那些 `with { type: "file" }` 嵌入的原生件。
//
// 用法：
//   CC_EXT=/abs/dump-embedded-resources.cjs DUMP_DIR=/abs/out \
//     refs/claude-<ver>-loaderhook --version
//
// 2.1.191 实测吐出 2 个：
//   audio-capture.node(0.5MB)
//   image-processor.node(1.5MB)
// 注：整个 app 是纯 JS，可以用 extract-bundle.mjs 提取，不在 embeddedFiles 里。
//
;(async () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const out = process.env.DUMP_DIR || '/tmp/dumped'
  const files = typeof Bun !== 'undefined' && Bun.embeddedFiles ? Bun.embeddedFiles : []
  console.error('[dump] Bun.embeddedFiles count =', files.length)
  let n = 0
  let total = 0
  for (const f of files) {
    const name = f && f.name ? f.name.replace(/^\/?\$bunfs\/root\//, '') : 'blob-' + n
    const dest = path.join(out, name)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    const buf = Buffer.from(await f.arrayBuffer())
    fs.writeFileSync(dest, buf)
    console.error('[dump]', String(buf.length).padStart(10), name)
    n++
    total += buf.length
  }
  console.error('[dump] wrote', n, 'files,', (total / 1e6).toFixed(1), 'MB ->', out)
  process.exit(0)
})()
