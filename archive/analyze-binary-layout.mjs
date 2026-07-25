#!/usr/bin/env node
// ARCHIVED — 已迁入 tools/unbun/lib/layout.mjs + cli.mjs layout。勿运行。
// analyze-binary-layout.mjs — 拆解 claude(Bun standalone)二进制的体积构成,回答
// 「为什么 229MB 二进制 ≈ 114MB 裸 bun+资源 就功能等价」。
//
// 方法:
//   1) 读 ELF section 头(readelf -SW),量 .text/.rodata(引擎)与 .bun(嵌入 app 负载)大小。
//   2) 在 .bun 段内扫「大块可打印连续区」(>1MB)= JS 源码/JSON/sourcemap;统计其总量。
//   3) .bun 余下的非可打印量 ≈ JSC 字节码(--bytecode 预编译)+ 原生件 + 元数据。
//
// 用法: node analyze-binary-layout.mjs [/path/to/claude-binary]
//   默认 binary = $(readlink -f $(command -v claude)) 的 .bak(干净未打补丁副本)优先。

import { readFileSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'

function defaultBin() {
  const live = execSync('readlink -f "$(command -v claude)"', { encoding: 'utf8' }).trim()
  return existsSync(live + '.bak') ? live + '.bak' : live
}
const bin = process.argv[2] || defaultBin()
const MB = (n) => (n / 1048576).toFixed(1) + ' MB'

// --- 1) section 头 ---
const sec = {}
for (const line of execSync(`readelf -SW ${JSON.stringify(bin)}`, { encoding: 'utf8' }).split('\n')) {
  // [Nr] Name Type Addr Off Size ES Flg Lk Inf Al
  const m = line.match(/\]\s+(\.\S+)\s+\S+\s+[0-9a-f]+\s+([0-9a-f]+)\s+([0-9a-f]+)\s/i)
  if (m) sec[m[1]] = { off: parseInt(m[2], 16), size: parseInt(m[3], 16) }
}
const engine = (sec['.text']?.size || 0) + (sec['.rodata']?.size || 0)
const bun = sec['.bun']?.size || 0
console.log(`binary               : ${bin}`)
console.log(`file size            : ${MB(readFileSync(bin).length)}`)
console.log(`.text  (engine code) : ${MB(sec['.text']?.size || 0)}`)
console.log(`.rodata(engine ro)   : ${MB(sec['.rodata']?.size || 0)}`)
console.log(`engine subtotal      : ${MB(engine)}`)
console.log(`.bun   (embedded app): ${MB(bun)}   <-- 体积大头`)

// --- 2) .bun 段内的大可打印块(源码/JSON/sourcemap) ---
const buf = readFileSync(bin)
const start = sec['.bun'].off
const end = start + sec['.bun'].size
const isP = (b) => b === 9 || b === 10 || b === 13 || (b >= 0x20 && b <= 0x7e)
const runs = []
let s = -1
for (let i = start; i <= end; i++) {
  const p = i < end && isP(buf[i])
  if (p) { if (s === -1) s = i }
  else if (s !== -1) { if (i - s >= 1 << 20) runs.push({ off: s, len: i - s }); s = -1 }
}
runs.sort((a, b) => b.len - a.len)
let printableBig = 0
console.log(`\n.bun 内 >1MB 的可打印连续块(JS 源码 / JSON / sourcemap):`)
for (const r of runs) {
  printableBig += r.len
  const head = buf.toString('latin1', r.off, r.off + 50).replace(/\n/g, '\\n')
  console.log(`  @${r.off}  ${MB(r.len).padStart(9)}  ${JSON.stringify(head)}`)
}
console.log(`  big-printable subtotal: ${MB(printableBig)}  (${runs.length} 块)`)

// --- 3) 余下 ≈ 字节码 + 原生 + 元数据 ---
const rest = bun - printableBig
console.log(`\n.bun 余下(非大块可打印)≈ JSC 字节码 + 原生件 + 元数据 : ${MB(rest)}`)
console.log(`  其中 2 个 .node 原生件约 2.0 MB,其余主要是 --bytecode 预编译的 JSC 字节码。`)
