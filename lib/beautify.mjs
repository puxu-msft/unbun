// lib/beautify.mjs — 用仓库根的 esbuild 反 minify（transformSync, minify:false）→ 可读多行。
//
// 纯 CPU 变换、不执行目标代码。esbuild 走 createRequire 从仓库根 node_modules 解析
// （unbun 无独立依赖，刻意复用根依赖）。legalComments:'none' 抹掉 `// @bun @source__` 头注释；
// loader:'js' 让 esbuild 按 JS 解析这份 CJS wrapper。
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

export function beautify(app) {
  const esbuild = require('esbuild')
  return esbuild.transformSync(app, { minify: false, legalComments: 'none', loader: 'js' }).code
}
