#!/usr/bin/env bun
// ARCHIVED — PoC/实验 provenance，勿运行。见 tools/unbun/
//
// claude 加载器
//
// 解析顺序：
//   ① process.env.CC_EXT                       — 显式覆盖（相对 cwd 解析）
//   ② <shim 所在目录>/claude-resources/app.js  — 默认发行布局
//   ③ <shim 所在目录>/app.js                   — 扁平布局回退
//
// 资源目录假定为 app.js 所在目录
//
// 注意：必须用 bun 跑！claude 用了 Bun-only API：Bun.stringWidth / Bun.wrapAnsi / Bun.embeddedFiles…)
//
const fs = require('node:fs')
const path = require('node:path')

const here = __dirname
const exeDir = path.dirname(process.execPath) // 编译态=二进制所在目录（脚本态=bun 程序目录，故仅作兜底）
const cc = process.env.CC_EXT
const cands = [
  cc ? path.resolve(cc) : null,
  path.join(here, 'claude-resources', 'app.js'),
  path.join(here, 'app.js'),
  path.join(exeDir, 'claude-resources', 'app.js'),
  path.join(exeDir, 'app.js'),
].filter(Boolean)

const APP = cands.find((c) => fs.existsSync(c))
if (!APP) {
  console.error('[claude-shim] app.js not found. tried:\n  ' + cands.join('\n  '))
  process.exit(1)
}
const RES = path.dirname(APP)

// 把嵌入资产的虚拟路径前缀重定向到提取出来的资源目录，使 require("/$bunfs/root/X.node") 解析到 RES/X.node。
const src = fs.readFileSync(APP, 'utf8').split('/$bunfs/root/').join(RES + '/')

// 取出工厂函数。app.js 是二进制文件中从 `// @bun-cjs` 到 `Sfm();})` 包的函数表达式，靠 trailer 调用、不自调。
const factory = (0, eval)(src)
// app 自检 Bun.embeddedFiles 决定 argv 切法：编译态走 slice(1),脚本态走 slice(2)，两种都对，故不必动 process.argv。
factory(module.exports, require, module, APP, RES)
