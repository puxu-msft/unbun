// test/bun-binary.test.mjs
import { test, expect } from 'bun:test'
import { execSync } from 'node:child_process'
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs'
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
  const buf = Buffer.alloc(300, 0x41) // 0x41='A'：strtab 区全非 null → 扫到 EOF
  buf[0] = 0x7f; buf[1] = 0x45; buf[2] = 0x4c; buf[3] = 0x46; buf[4] = 2
  buf.writeBigUInt64LE(64n, 0x28) // e_shoff = 64
  buf.writeUInt16LE(64, 0x3a)     // e_shentsize = 64
  buf.writeUInt16LE(1, 0x3c)      // e_shnum = 1
  buf.writeUInt16LE(0, 0x3e)      // e_shstrndx = 0
  buf.writeUInt32LE(1, 64)        // section[0].sh_name = 1（指向无终止的 'A' run）
  buf.writeBigUInt64LE(200n, 64 + 0x18) // section[0].sh_offset (=strOff) → 200（[200,300) 全 'A'，无 null）
  buf.writeBigUInt64LE(100n, 64 + 0x20)
  expect(() => readBinary(tmpFile(buf))).toThrow(/unterminated section name/)
})

function elfWithSections({ shentsize = 64, shstrndx = 0, shoff = 64, payloadOff = 256, payloadSize = 4, payloadType = 1 } = {}) {
  const buf = Buffer.alloc(320)
  buf[0] = 0x7f; buf[1] = 0x45; buf[2] = 0x4c; buf[3] = 0x46; buf[4] = 2
  buf.writeBigUInt64LE(BigInt(shoff), 0x28)
  buf.writeUInt16LE(shentsize, 0x3a)
  buf.writeUInt16LE(2, 0x3c)
  buf.writeUInt16LE(shstrndx, 0x3e)
  const str = Buffer.from('\0.shstrtab\0.bad\0')
  const strOff = 220
  str.copy(buf, strOff)
  const a = shoff
  buf.writeUInt32LE(1, a)
  buf.writeUInt32LE(3, a + 4)
  buf.writeBigUInt64LE(BigInt(strOff), a + 0x18)
  buf.writeBigUInt64LE(BigInt(str.length), a + 0x20)
  const b = shoff + shentsize
  if (b + 64 <= buf.length) {
    buf.writeUInt32LE(11, b)
    buf.writeUInt32LE(payloadType, b + 4)
    buf.writeBigUInt64LE(BigInt(payloadOff), b + 0x18)
    buf.writeBigUInt64LE(BigInt(payloadSize), b + 0x20)
  }
  return buf
}

test('rejects ELF section headers smaller than ELF64_Shdr', () => {
  expect(() => readBinary(tmpFile(elfWithSections({ shentsize: 32 })))).toThrow(/section header entry size.*64/i)
})

test('rejects out-of-range section-name table indices', () => {
  expect(() => readBinary(tmpFile(elfWithSections({ shstrndx: 2 })))).toThrow(/shstrndx.*out of range/i)
})

test('rejects a section header table that extends beyond the file', () => {
  expect(() => readBinary(tmpFile(elfWithSections({ shoff: 280 })))).toThrow(/section header table.*out of bounds/i)
})

test('rejects file-backed section payloads outside the file but permits SHT_NOBITS', () => {
  expect(() => readBinary(tmpFile(elfWithSections({ payloadOff: 10_000, payloadSize: 999 })))).toThrow(/section.*payload.*out of bounds/i)
  const reader = readBinary(tmpFile(elfWithSections({ payloadOff: 10_000, payloadSize: 999, payloadType: 8 })))
  reader.close()
})

test('top-level parsing primitives do not import the patch subsystem', () => {
  const source = readFileSync(new URL('../lib/bun-binary.mjs', import.meta.url), 'utf8')
  expect(source).not.toMatch(/(?:from|import\()\s*['"][^'"]*\/patch\//)
})
