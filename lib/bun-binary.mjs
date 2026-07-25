// lib/bun-binary.mjs — ELF parser compatibility layer over the cross-platform raw reader.
import { execSync } from 'node:child_process'
import { bufferReader, openFileReader } from './patch/io/raw-reader.mjs'

export { bufferReader }

// parseElfSections(reader, path)：从**任一 reader**（mmap 或 pread 后端）读 ELF64 header + 段头表 +
// .shstrtab，填入 reader.sections / reader.elf。两后端共用（reader.slice 返回的都是 Buffer，方法一致）。
// ELF magic + ELFCLASS64 + strtab 终止守卫全部 fail-loud（never-swallow-errors）。
function parseElfSections(reader, path) {
  const size = reader.size

  // ELF magic + ELFCLASS64 校验：非 ELF / ELF32 输入若不拦，下方 header 读会静默产垃圾 sections。
  // 放在任何 header 字段读**之前**——短文件也先在此得清晰错。
  const nHead = Math.min(size, 64)
  const head = reader.slice(0, nHead)
  if (nHead < 4 || !(head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46)) {
    throw new Error(`readBinary: not an ELF file (bad magic) — ${path}`)
  }
  if (head[4] !== 2) throw new Error(`readBinary: not ELF64 (EI_CLASS=${head[4]}, expected 2) — ${path}`)
  if (size < 64) throw new Error(`readBinary: ELF64 header truncated (${size} bytes) — ${path}`)

  // ELF64 header 关键字段（都在前 64 字节内）。
  const shoff = Number(head.readBigUInt64LE(0x28))
  const shentsize = head.readUInt16LE(0x3a)
  const shnum = head.readUInt16LE(0x3c)
  const shstrndx = head.readUInt16LE(0x3e)

  // 段头表：读整张表（shnum×shentsize 字节，通常几 KB，紧贴 EOF）一次。
  const shTable = reader.slice(shoff, shnum * shentsize)
  // .shstrtab 段（section 名字表）：先从段头表取 shstrndx 段的 off/size，再读该段一次。strSize 可能是
  // 损坏值（合成/坏 ELF）→ 把段末 clamp 到文件末，别让越界读抢在名字扫描守卫前抛「out of bounds」误导；
  // clamp 后损坏的无终止 strtab 仍由下方 null 扫描守卫 fail-loud（对齐旧行为）。
  const strOff = Number(shTable.readBigUInt64LE(shstrndx * shentsize + 0x18))
  const strSize = Number(shTable.readBigUInt64LE(shstrndx * shentsize + 0x20))
  const strEnd = Math.min(strOff + strSize, size)
  const strtab = reader.slice(strOff, Math.max(0, strEnd - strOff)) // 名字全在此段内，扫描以段长为界

  const sections = {}
  for (let i = 0; i < shnum; i++) {
    const e = i * shentsize
    const nameIdx = shTable.readUInt32LE(e)
    // 名字扫描须有越界守卫（never-swallow-errors）：损坏/无终止的 strtab 会让扫描越过段末**死循环
    // hang**。以 strtab 段长为界，越界即 fail-fast throw，别 hang、别静默截断。
    let end = nameIdx
    while (end < strtab.length && strtab[end] !== 0) end++
    if (end >= strtab.length) {
      throw new Error(`readBinary: unterminated section name at strtab offset ${strOff + nameIdx} (corrupt .shstrtab?)`)
    }
    const name = strtab.toString('latin1', nameIdx, end)
    sections[name] = {
      off: Number(shTable.readBigUInt64LE(e + 0x18)),
      size: Number(shTable.readBigUInt64LE(e + 0x20)),
    }
  }

  reader.sections = sections
  reader.elf = { shoff, shentsize, shnum }
}

export function readElfBinary(path) {
  const reader = openFileReader(path)
  try {
    parseElfSections(reader, path)
    return reader
  } catch (error) {
    reader.close()
    throw error
  }
}

export const readBinary = readElfBinary

export function defaultBinary() {
  const p = execSync('readlink -f "$(command -v claude)"', { encoding: 'utf8' }).trim()
  if (!p) throw new Error('could not locate claude binary; pass it explicitly')
  return p
}
