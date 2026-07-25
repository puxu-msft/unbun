// test/bun-binary.test.mjs
import { test, expect } from 'bun:test'
import { execSync } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readBinary } from '../lib/bun-binary.mjs'

const LIVE = execSync('readlink -f "$(command -v claude)"', { encoding: 'utf8' }).trim()

function tmpFile(buf) {
  const dir = mkdtempSync(join(tmpdir(), 'unbun-binguard-'))
  const p = join(dir, 'in.bin')
  writeFileSync(p, buf)
  return p
}

test('reads ELF sections incl .bun and locates section header table at EOF', () => {
  const r = readBinary(LIVE)
  try {
    const { sections, elf } = r
    expect(sections['.bun']).toBeDefined()
    expect(sections['.bun'].size).toBeGreaterThan(50_000_000) // .bun 是体积大头
    expect(sections['.shstrtab']).toBeDefined()
    // ELF 不变量：section header 表尾正好铺到文件末（feasibility 评审实测 B1）
    expect(elf.shoff + elf.shentsize * elf.shnum).toBe(r.size)
  } finally {
    r.close()
  }
})

// A2 守卫①：非 ELF 输入 fail-loud（never-swallow-errors），不静默产垃圾 sections。
test('rejects non-ELF input with a clear error (not garbage sections)', () => {
  const p = tmpFile(Buffer.from('this is not an elf file at all, just plain text'))
  expect(() => readBinary(p)).toThrow(/not an ELF file/)
})

// A2 守卫①b：ELF32（magic 对但 EI_CLASS=1）→ fail-loud。
test('rejects ELF32 (EI_CLASS != 2)', () => {
  const buf = Buffer.alloc(64, 0)
  buf[0] = 0x7f; buf[1] = 0x45; buf[2] = 0x4c; buf[3] = 0x46; buf[4] = 1 // ELFCLASS32
  expect(() => readBinary(tmpFile(buf))).toThrow(/not ELF64/)
})

// A2 守卫②：损坏 strtab（section 名无终止 0）→ 名字扫描 throw 而非越界死循环 hang。
// 合成一个刚好走到名字扫描、且 strtab 区到 EOF 无 null 的最小 ELF64。
test('throws (not hangs) on unterminated section name', () => {
  const buf = Buffer.alloc(200, 0x41) // 0x41='A'：strtab 区全非 null → 扫到 EOF
  buf[0] = 0x7f; buf[1] = 0x45; buf[2] = 0x4c; buf[3] = 0x46; buf[4] = 2
  buf.writeBigUInt64LE(64n, 0x28) // e_shoff = 64
  buf.writeUInt16LE(64, 0x3a)     // e_shentsize = 64
  buf.writeUInt16LE(1, 0x3c)      // e_shnum = 1
  buf.writeUInt16LE(0, 0x3e)      // e_shstrndx = 0
  buf.writeUInt32LE(0, 64)        // section[0].sh_name = 0
  buf.writeBigUInt64LE(100n, 64 + 0x18) // section[0].sh_offset (=strOff) → 100（[100,200) 全 'A'，无 null）
  expect(() => readBinary(tmpFile(buf))).toThrow(/unterminated section name/)
})
