// lib/hook.mjs — 等长 loader-hook 打桩器（纯字节 + 守卫）。
//
// 思路（并入 archive/patch-loader-hook.mjs，详见归档 findings）：
//   claude（Bun --compile standalone）bundle 顶部有一行纯注释锚
//   `// Claude Code is a Beta product per Anthropic's Commercial Terms of Service.`（77 字节，
//   二进制里出现多处）。注释字节本不执行；把它**等长**覆盖成一段可执行 payload + 空格填充，
//   行尾 \n 原位保留 → 文件 size 分毫不变 → Bun 尾部 TOC 偏移全不动 → 无需改 TOC；
//   于是该 payload 在模块顶层、main 之前执行，require 环境变量 CC_EXT 指向的外部 bundle。
//
// 本模块只做**纯字节**变换（收 buf 出 buf），不碰文件系统、不判 versions/ live 二进制、
// 不做 .bak 尺寸校验——那些 CLI 层守卫放在 cli.mjs 的 `patch-loader-hook` 分支（Task 4.2）。
// 纯函数 + 常量便于合成 buffer 单测。anchor/payload 参数化：真 claude 用默认 CC_ANCHOR，
// fixture 用自己的等长 `//!` 锚（Task 4.2 不对称说明）。

export const CC_ANCHOR = "// Claude Code is a Beta product per Anthropic's Commercial Terms of Service."
export const CC_PAYLOAD = 'if(process.env.CC_EXT)try{require(process.env.CC_EXT)}catch(e){}'

const NL = 0x0a

// patchLoaderHook(buf, opts) → { patched, sites }
//   - 在 buf 里找**所有** anchor 出现处（indexOf 循环）；每处校验其后紧跟 \n，否则抛
//     （防打到被改写/错位的构建）；
//   - 每处用 payload.padEnd(anchor.length, ' ') 等长覆盖 → patched.length === buf.length；
//   - payload 超 anchor 长度即抛（无法保持等长，前置守卫，与是否命中无关）；
//   - 返回 patched（新 buffer，不改入参）+ sites（命中偏移数组，空数组交 CLI 决定是否算错）。
//   - force 是 CLI 层关注点（拒碰 versions/ live、.bak 校验在 cli.mjs）；此处仅为签名对称接受，
//     纯函数不消费它。
export function patchLoaderHook(buf, { force = false, anchor = CC_ANCHOR, payload = CC_PAYLOAD } = {}) {
  void force // CLI-layer concern; accepted for signature symmetry, no-op in the pure transform.
  if (payload.length > anchor.length) {
    throw new Error(`payload (${payload.length}) longer than anchor (${anchor.length}); cannot keep equal length`)
  }
  const len = anchor.length
  const anchorBuf = Buffer.from(anchor, 'latin1')
  const payloadBuf = Buffer.from(payload.padEnd(len, ' '), 'latin1')
  const patched = Buffer.from(buf) // 复制，绝不改调用方的入参 buffer

  const sites = []
  for (let i = 0; (i = patched.indexOf(anchorBuf, i)) !== -1; i++) sites.push(i)
  for (const off of sites) {
    if (patched[off + len] !== NL) {
      throw new Error(`no \\n right after anchor at ${off} (got ${patched[off + len]}); refusing to patch`)
    }
    payloadBuf.copy(patched, off)
  }
  return { patched, sites }
}
