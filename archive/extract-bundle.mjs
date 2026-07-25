#!/usr/bin/env node
// ARCHIVED — 逻辑已迁入 tools/unbun/lib/{extract,module-graph,beautify}.mjs + cli.mjs extract。勿运行。见 tools/unbun/docs/spec.md
// extract-bundle.mjs — faithfully extract + beautify the Claude Code app bundle.
//
// Supersedes the printable-run-scatter approach in ../../cc-internals/tools/extract.mjs.
//
// Insight: `claude` is a Bun single-file executable (`bun build --compile`). The ENTIRE app is
// embedded as ONE CommonJS module — a single contiguous UTF-8 run near the end of the binary,
// wrapped as `// @bun @bun-cjs\n(function(exports,require,module,__filename,__dirname){ ... })`.
// It is valid JavaScript that `node --check` parses as-is. So instead of scanning the whole binary
// for hundreds of printable fragments (which interleave the app with bytecode/docs/assets and force
// fragile byte-offset windowing), we just grab that single largest contiguous printable run and
// re-emit it from an AST with esbuild — giving a single, complete, re-parseable, line-numbered file.
//
// Usage: node extract-bundle.mjs [/path/to/binary] [outdir]
//   defaults: binary = $(readlink -f $(command -v claude)),
//             outdir = <repo-root>/refs/claude-code-<version>  (shared, gitignored reference store)
//
// Outputs (all proprietary-derived — keep gitignored):
//   app.js          the raw contiguous bundle (faithful, minified, re-parseable)
//   app.pretty.js   esbuild-beautified (one stmt/line, indented; stable line numbers for grep/Read)
//   strings-n6.txt  `strings -a -n 6` of the whole binary (broad grep corpus)

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

// Walk up from this script to the repo root (the dir containing `.git`) so the default output
// lands in the shared, gitignored `<repo-root>/refs/` store regardless of cwd.
function repoRoot() {
  let d = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(d, '.git'))) return d
    const up = dirname(d)
    if (up === d) break
    d = up
  }
  return process.cwd()
}

function isPrintable(b) {
  return b === 9 || b === 10 || b === 13 || (b >= 0x20 && b <= 0x7e)
}

function defaultBinary() {
  const p = execSync('readlink -f "$(command -v claude)"', { encoding: 'utf8' }).trim()
  if (!p) throw new Error('could not locate claude binary; pass it as argv[2]')
  return p
}

// Find the single largest contiguous printable run — empirically the app's CJS bundle.
function largestPrintableRun(buf) {
  let best = { off: -1, len: 0 }
  let start = -1
  for (let i = 0; i <= buf.length; i++) {
    const printable = i < buf.length && isPrintable(buf[i])
    if (printable) {
      if (start === -1) start = i
    } else if (start !== -1) {
      const len = i - start
      if (len > best.len) best = { off: start, len }
      start = -1
    }
  }
  return best
}

const binPath = process.argv[2] || defaultBinary()
const version = binPath.split('/').pop()
const outDir = (process.argv[3] || join(repoRoot(), 'refs', `claude-code-${version}`)).replace(/\/$/, '')
mkdirSync(outDir, { recursive: true })

console.error(`[extract] reading ${binPath}`)
const buf = readFileSync(binPath)
console.error(`[extract] ${(buf.length / 1e6).toFixed(1)} MB binary`)

const run = largestPrintableRun(buf)
const app = buf.toString('latin1', run.off, run.off + run.len)
console.error(`[extract] app bundle: byte ${run.off}, ${(run.len / 1e6).toFixed(2)} MB`)

// Sanity-check it really is the Bun CJS app wrapper, not some other big blob.
if (!/@bun|\(function\s*\(exports,\s*require,\s*module/.test(app.slice(0, 200))) {
  console.error('[extract] WARNING: largest run does not look like the Bun CJS app wrapper:')
  console.error('          ' + JSON.stringify(app.slice(0, 120)))
}

writeFileSync(`${outDir}/app.js`, app)
console.error(`[extract] wrote ${outDir}/app.js`)

// Beautify from AST (esbuild re-prints minified input as readable, stable, line-numbered code).
const esbuild = require('esbuild')
const t0 = Date.now()
const { code } = esbuild.transformSync(app, { minify: false, legalComments: 'none', loader: 'js' })
writeFileSync(`${outDir}/app.pretty.js`, code)
console.error(
  `[extract] wrote ${outDir}/app.pretty.js  (${(code.length / 1e6).toFixed(1)} MB, ` +
    `${code.split('\n').length} lines, ${((Date.now() - t0) / 1000).toFixed(1)}s)`,
)

// Broad strings corpus for env-var / URL / event-name grep.
execSync(`strings -a -n 6 ${JSON.stringify(binPath)} > ${JSON.stringify(`${outDir}/strings-n6.txt`)}`)
console.error(`[extract] wrote ${outDir}/strings-n6.txt`)

console.error('[extract] done. Grep app.pretty.js by line number; both app*.js re-parse with `node --check`.')
