#!/usr/bin/env bun
// ARCHIVED — PoC/实验 provenance，勿运行。见 tools/unbun/
//
// 找到一个 loader.js 模块并 require 它。真正加载 app.js + 资源重定向的逻辑都在外部 loader.js 里。
//
// 解析顺序：
//   ① process.env.CC_EXT                          — 显式覆盖（相对 cwd 解析）
//   ② <shim 所在目录>/claude-resources/loader.js  — 默认发行布局
//   ③ <shim 所在目录>/loader.js                   — 扁平布局回退
//
// 注意：必须用 bun 跑！claude 用了 Bun-only API：Bun.stringWidth / Bun.wrapAnsi / Bun.embeddedFiles…)
//
const fs = require('node:fs')
const path = require('node:path')

const here = __dirname
const cc = process.env.CC_EXT
const cands = [
  cc ? path.resolve(cc) : null,
  path.join(here, 'claude-resources', 'loader.js'),
  path.join(here, 'loader.js'),
].filter(Boolean)

const loader = cands.find((c) => fs.existsSync(c))
if (!loader) {
  console.error('[claude-shim] loader.js not found. tried:\n  ' + cands.join('\n  '))
  process.exit(1)
}
require(loader)
