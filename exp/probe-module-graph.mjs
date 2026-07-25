// exp/probe-module-graph.mjs — 逆 Bun StandaloneModuleGraph（仅投研 / provenance）。
//
// 结论沉淀在 docs/FINDINGS-phase0.md，本脚本是复现证据的可执行探针：
//   cd tools/unbun && bun exp/probe-module-graph.mjs [binary]
//   bun exp/probe-module-graph.mjs /home/xp/.local/share/claude/versions/2.1.201  # 跨版本核验
//
// 纯读取，绝不执行目标 binary。已对 2.1.195 / 2.1.201 / 2.1.205 三版实测（格式一致）。
import { readBinary, defaultBinary } from '../lib/bun-binary.mjs'

const path = process.argv[2] || defaultBinary()
const { buf, sections } = readBinary(path)
const bun = sections['.bun']
if (!bun) throw new Error('no .bun section — not a bun --compile SFX?')
const winEnd = bun.off + bun.size
const u32 = (o) => buf.readUInt32LE(o)
const u64 = (o) => Number(buf.readBigUInt64LE(o))

// ── P0-a step 1: 定位 .bun 窗口内的真 trailer ────────────────────────────────
// trailer 字面量是 "\n---- Bun! ----\n"（前后各一个换行）。用无换行的 14 字节 magic
// 在 .bun 窗口内 lastIndexOf 定位，排除引擎区（.rodata）的 HMR 常量副本。
const MAGIC = Buffer.from('---- Bun! ----', 'latin1')
const magicPos = buf.lastIndexOf(MAGIC, winEnd)
if (magicPos < bun.off) throw new Error('trailer magic not found inside .bun window')
const trailerStart = magicPos - 1 // 指向 trailer 的前导 '\n'
console.log('file', buf.length, '| .bun', bun.off, '..', winEnd, '| trailer@', trailerStart,
  JSON.stringify(buf.toString('latin1', trailerStart, magicPos + 14)))
// 全二进制 magic 出现次数（引擎区副本数随版本，勿写死）：
{
  const all = []
  let p = buf.indexOf(MAGIC, 0)
  while (p !== -1) { all.push(p); p = buf.indexOf(MAGIC, p + 1) }
  console.log('MAGIC occurrences (whole file):', all, '-> real trailer is the one inside .bun')
}

// ── P0-a step 2: 解 Offsets 结构（trailer 前 32 字节）───────────────────────
// 实测布局（sizeof=32，8 字节对齐，跨 195/201/205 稳定）：
//   [-32] byte_count      : u64  = 整个 graph 序列化区字节数（graph_base..offsets_start）
//   [-24] modules_ptr.off : u32  = 模块记录数组相对 graph_base 的偏移
//   [-20] modules_ptr.len : u32  = 模块记录数组字节数（= N * 52）
//   [-16] entry_point_id  : u32  = 入口模块在数组中的下标（实测恒 0，但从此读取，勿写死）
//   [-12..0] 尾部 12 字节 : 冗余/对齐（-12 处 = modules_end 相对偏移 = off+len；语义未确证，解码不需要）
const os = trailerStart - 32
const byte_count = u64(os)
const mp_off = u32(os + 8)
const mp_len = u32(os + 12)
const entry = u32(os + 16)
const graph_base = os - byte_count // = 所有 StringPointer 的绝对基址
console.log('\n[Offsets] byte_count', byte_count, 'mp_off', mp_off, 'mp_len', mp_len,
  'entry_point_id', entry, '| graph_base', graph_base, `(.bun +${graph_base - bun.off})`,
  '| tail12:', u32(os + 20), u32(os + 24), u32(os + 28))

// ── P0-a step 3: 解模块记录数组 ─────────────────────────────────────────────
// 每条记录 52 字节（13×u32），字段相对 graph_base：
//   [0] name.offset    [4] name.length      -> 模块名（"/$bunfs/root/..."，NAMES PRESENT）
//   [8] contents.offset [12] contents.length -> blob 字节
//   [16] sourcemap.offset [20] sourcemap.length -> 实测恒空 (0,0)
//   [24..44] aux（bytecode + 入口专属额外指针）-> 除入口外全 0；入口指向零填充/重复名，与抽取无关
//   [48] loader/flags (u32)：byte[49] = Bun Loader enum（js=1, file=5, napi=10）
const RS = 52
const N = mp_len / RS
if (!Number.isInteger(N)) throw new Error(`modules_ptr.length ${mp_len} not divisible by record size ${RS}`)
const modPos = graph_base + mp_off
const str = (o, l) => buf.toString('latin1', graph_base + o, graph_base + o + l)
const head = (o, l) => buf.toString('latin1', graph_base + o, graph_base + o + Math.min(l, 46)).replace(/[^\x20-\x7e]/g, '.')
const LOADER = { 0: 'jsx', 1: 'js', 2: 'ts', 3: 'tsx', 4: 'css', 5: 'file', 6: 'json', 7: 'toml', 8: 'wasm', 9: 'napi', 10: 'napi/node' }
console.log(`\n[modules] ${N} records @ ${modPos} (record size ${RS}, count from mp_len/${RS}):`)
let allValid = true
for (let i = 0; i < N; i++) {
  const r = modPos + i * RS
  const nameOff = u32(r), nameLen = u32(r + 4), cOff = u32(r + 8), cLen = u32(r + 12)
  const smOff = u32(r + 16), smLen = u32(r + 20), flags = u32(r + 48)
  const loaderByte = buf[r + 49]
  const name = str(nameOff, nameLen)
  const contentsAbs = graph_base + cOff
  const contentHead = head(cOff, cLen)
  // 验证判据：name 可打印且形如 $bunfs 路径；contents 头是 @bun-cjs / ELF / 已知资产
  const nameOk = /^[\x20-\x7e]+$/.test(name) && name.includes('$bunfs')
  const contentOk = contentHead.startsWith('// @bun') || contentHead.startsWith('.ELF') ||
    contentHead.startsWith('"use strict"') || contentHead.startsWith('#!')
  if (!nameOk || !contentOk) allValid = false
  const mid = []
  for (let k = 4; k < 12; k++) mid.push(u32(r + k * 4))
  console.log(`  #${i}${i === entry ? ' [ENTRY]' : ''} loader=${LOADER[loaderByte] ?? loaderByte}(0x${flags.toString(16).padStart(8, '0')})` +
    ` ${nameOk && contentOk ? 'OK' : 'FAIL'}\n      name ${JSON.stringify(name)}` +
    `\n      contents @${contentsAbs} len ${cLen} head ${JSON.stringify(contentHead)}` +
    (smLen ? `\n      sourcemap @${graph_base + smOff} len ${smLen}` : '') +
    (mid.some((x) => x !== 0) ? `\n      aux u32[4..11] (entry-only, -> zero-fill/dup-name): ${mid.join(',')}` : ''))
}
console.log(`\n[verify] all ${N} blobs slice-and-header validated: ${allValid ? 'PASS' : 'FAIL'}`)

// ── P0-e: 是否存在内嵌 sourcemap ────────────────────────────────────────────
const wf = (s) => { const b = Buffer.from(s, 'latin1'); const out = []; let p = buf.indexOf(b); while (p !== -1) { out.push(p); p = buf.indexOf(b, p + 1) } return out }
console.log('\n[P0-e sourcemap] entry.sourcemap StringPointer =',
  (() => { const r = modPos + entry * RS; return `{off:${u32(r + 16)}, len:${u32(r + 20)}}` })(),
  '(empty => no embedded sourcemap)')
console.log('  "sourcemap.json" whole-file:', wf('sourcemap.json'), '(in .rodata engine区, not a graph blob)')
console.log('  "SourceMapTooLarge" whole-file:', wf('SourceMapTooLarge'))

// ── P0-c: helper 定义签名（名字随 minifier 漂移，签名跨版本稳定）─────────────
// 只对入口 blob（record[entry].contents）做正则识别；下游 split.mjs 用同法动态识别。
{
  const r = modPos + entry * RS
  const cOff = u32(r + 8), cLen = u32(r + 12)
  const app = buf.toString('latin1', graph_base + cOff, graph_base + cOff + cLen)
  const esm = app.match(/([A-Za-z_$][\w$]*)=\([a-zA-Z_$],[a-zA-Z_$]\)=>\(\)=>\([a-zA-Z_$]&&\([a-zA-Z_$]=[a-zA-Z_$]\([a-zA-Z_$]=0\)\),[a-zA-Z_$]\)/)
  const cjs = app.match(/([A-Za-z_$][\w$]*)=\([a-zA-Z_$],[a-zA-Z_$]\)=>\(\)=>\([a-zA-Z_$]\|\|[a-zA-Z_$]\(\([a-zA-Z_$]=\{exports:\{\}\}\)\.exports,[a-zA-Z_$]\),[a-zA-Z_$]\.exports\)/)
  console.log('\n[P0-c helpers] (name-agnostic, matched by definition signature)')
  console.log('  __esm       def:', esm ? JSON.stringify(esm[0]) : 'NOT FOUND', esm ? `-> local name "${esm[1]}"` : '')
  console.log('  __commonJS  def:', cjs ? JSON.stringify(cjs[0]) : 'NOT FOUND', cjs ? `-> local name "${cjs[1]}"` : '')
  if (esm) {
    const re = new RegExp(`[=,]${esm[1].replace(/[$]/g, '\\$')}\\(\\(\\)=>`, 'g')
    console.log(`  __esm usage  var X=${esm[1]}(()=>…) count:`, (app.match(re) || []).length)
  }
  if (cjs) {
    const re = new RegExp(`[=,]${cjs[1].replace(/[$]/g, '\\$')}\\(\\(`, 'g')
    console.log(`  __commonJS usage var X=${cjs[1]}((exports[,module])=>…) count:`, (app.match(re) || []).length)
  }

  // ── P0-d: version 锚（Claude 专属元数据对象）─────────────────────────────
  const v = app.match(/PACKAGE_URL:"@anthropic-ai\/claude-code",README_URL:"[^"]*",VERSION:"([^"]+)"/)
  const bare = (app.match(/2\.1\.\d+/g) || []).length
  console.log('\n[P0-d version anchor]')
  console.log('  metadata-object anchor VERSION =', v ? v[1] : 'NOT FOUND',
    v ? '(PACKAGE_URL:"@anthropic-ai/claude-code" + VERSION, all copies agree)' : '')
  console.log('  bare "2.1.x" occurrences (no unique anchor):', bare)
}
