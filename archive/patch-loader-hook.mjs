#!/usr/bin/env node
// ARCHIVED — 已迁入 tools/unbun/lib/hook.mjs + cli.mjs cc patch-loader-hook。勿运行。
// patch-loader-hook.mjs — 给 claude(Bun standalone)打一次「等长 loader-hook」,
// 之后它会在 main 之前 require 环境变量 CC_EXT 指向的外部 bundle。
//
// 思路(详见同目录 FINDINGS.md):
//   bundle 顶部有一行纯注释 `// Claude Code is a Beta product per Anthropic's
//   Commercial Terms of Service.`(77 字节,二进制里出现多处)。注释字节本不执行;
//   把它**等长**替换成一段可执行代码 + 空格填充,行尾 \n 原位保留,文件 size 分毫不变,
//   于是该代码在模块顶层、main 之前执行。等长 → Bun 尾部 TOC 偏移全不变 → 无需改 TOC。
//
// 用法:
//   node patch-loader-hook.mjs <target-binary-copy>     # 对副本打桩(推荐)
//   node patch-loader-hook.mjs <live-binary> --force     # 显式才允许碰 versions/ 下的 live 二进制
//
// 安全:默认从不改 live 二进制;若目标在 .../versions/ 下且未给 --force,直接拒绝。
//       打桩前若同目录有 <target>.bak,会校验目标与 .bak 大小一致以防误打到已变形的文件。

import { readFileSync, writeFileSync, statSync, existsSync } from 'node:fs'

const ANCHOR = "// Claude Code is a Beta product per Anthropic's Commercial Terms of Service."
const PAYLOAD = 'if(process.env.CC_EXT)try{require(process.env.CC_EXT)}catch(e){}'
const NL = 0x0a

const args = process.argv.slice(2)
const force = args.includes('--force')
const target = args.find((a) => !a.startsWith('--'))

if (!target) {
  console.error('usage: node patch-loader-hook.mjs <target-binary> [--force]')
  process.exit(2)
}
if (/[\\/]versions[\\/]/.test(target) && !force) {
  console.error(`[patch] refusing to touch a live binary under versions/: ${target}`)
  console.error('[patch] patch a COPY instead, or pass --force if you really mean it.')
  process.exit(1)
}
if (PAYLOAD.length > ANCHOR.length) {
  throw new Error(`payload (${PAYLOAD.length}) longer than anchor (${ANCHOR.length}); cannot keep equal length`)
}

const LEN = ANCHOR.length // 77
const payloadBuf = Buffer.from(PAYLOAD.padEnd(LEN, ' '), 'latin1')
const anchorBuf = Buffer.from(ANCHOR, 'latin1')

const buf = readFileSync(target)
const origSize = buf.length

// optional sanity: target should match its sibling .bak in size (unpatched length).
const bak = `${target}.bak`
if (existsSync(bak) && statSync(bak).size !== origSize) {
  console.error(`[patch] WARNING: ${target} size != ${bak} size; target may already be modified.`)
}

const sites = []
for (let i = 0; (i = buf.indexOf(anchorBuf, i)) !== -1; i++) sites.push(i)
if (sites.length === 0) {
  console.error('[patch] anchor not found — wrong binary or a build whose leading comment changed.')
  process.exit(1)
}

for (const off of sites) {
  if (buf[off + LEN] !== NL) {
    throw new Error(`no \\n right after anchor at ${off} (got ${buf[off + LEN]}); refusing to patch`)
  }
  payloadBuf.copy(buf, off)
}

writeFileSync(target, buf)
const newSize = statSync(target).size
console.error(`[patch] patched ${sites.length} site(s): ${sites.join(', ')}`)
console.error(`[patch] payload (len ${LEN}, padded): ${JSON.stringify(PAYLOAD.padEnd(LEN, ' '))}`)
console.error(`[patch] size ${origSize} -> ${newSize} ${origSize === newSize ? '(unchanged ✓)' : '(CHANGED ✗ — TOC now inconsistent!)'}`)
console.error('[patch] done. run with:  CC_EXT=/abs/path/to/external.cjs ' + target + ' --version')
