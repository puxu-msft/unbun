import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'acorn'
import { openFileReader } from '../../lib/patch/io/raw-reader.mjs'
import { readElfBinary } from '../../lib/bun-binary.mjs'

const tempDirs = []
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

function tempFile(name, bytes) {
  const dir = mkdtempSync(join(tmpdir(), 'unbun-raw-reader-'))
  tempDirs.push(dir)
  const path = join(dir, name)
  writeFileSync(path, bytes)
  return path
}

function minimalElf64() {
  const bytes = Buffer.alloc(129)
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2])
  bytes.writeBigUInt64LE(64n, 0x28)
  bytes.writeUInt16LE(64, 0x3a)
  bytes.writeUInt16LE(1, 0x3c)
  bytes.writeUInt16LE(0, 0x3e)
  bytes.writeBigUInt64LE(128n, 64 + 0x18)
  bytes.writeBigUInt64LE(1n, 64 + 0x20)
  return bytes
}

const formats = [
  ['ELF', minimalElf64()],
  ['PE', Buffer.from([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0])],
  ['Mach-O', Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 7, 0, 0, 1])],
  ['arbitrary raw', Buffer.from('raw\0bytes\xff', 'latin1')],
]

const forcePread = () => spyOn(Bun, 'mmap').mockImplementation(() => {
  const error = new Error('forced mmap failure')
  error.code = 'ETXTBSY'
  throw error
})

function moduleSpecifiers(source) {
  const program = parse(source, { ecmaVersion: 'latest', sourceType: 'module' })
  const specifiers = []

  function visit(node) {
    if (node == null || typeof node !== 'object') return
    if (
      (node.type === 'ImportDeclaration'
        || node.type === 'ExportNamedDeclaration'
        || node.type === 'ExportAllDeclaration'
        || node.type === 'ImportExpression')
      && typeof node.source?.value === 'string'
    ) {
      specifiers.push(node.source.value)
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit)
      else visit(value)
    }
  }

  visit(program)
  return specifiers
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

test.each(formats)('openFileReader opens %s without parsing ELF', (name, bytes) => {
  const path = tempFile(`${name}.bin`, bytes)
  const reader = openFileReader(path)
  try {
    expect(reader.size).toBe(bytes.length)
    expect(Buffer.from(reader.slice(0, bytes.length))).toEqual(bytes)
    expect(reader.sections).toBeUndefined()
    expect(reader.elf).toBeUndefined()
  } finally {
    reader.close()
  }
})

test('readElfBinary parses ELF metadata and is the only layer that rejects non-ELF formats', () => {
  const elfPath = tempFile('minimal.elf', minimalElf64())
  const elf = readElfBinary(elfPath)
  try {
    expect(elf.sections['']).toEqual({ off: 128, size: 1 })
    expect(elf.elf).toEqual({ shoff: 64, shentsize: 64, shnum: 1 })
  } finally {
    elf.close()
  }

  for (const [name, bytes] of formats.slice(1)) {
    const path = tempFile(`${name}.bin`, bytes)
    const raw = openFileReader(path)
    raw.close()
    expect(() => readElfBinary(path)).toThrow(/not an ELF file/)
  }
})

test('future production patch modules cannot import the ELF compatibility layer', async () => {
  const patchRoot = join(projectRoot, 'lib/patch')
  const glob = new Bun.Glob('**/*.mjs')
  const violations = []

  for await (const relativePath of glob.scan({ cwd: patchRoot, onlyFiles: true })) {
    const path = join(patchRoot, relativePath)
    const source = await Bun.file(path).text()
    for (const specifier of moduleSpecifiers(source)) {
      if (!specifier.startsWith('.')) continue
      const importedPath = resolve(dirname(path), specifier)
      if (importedPath === join(projectRoot, 'lib/bun-binary.mjs')) violations.push(relativePath)
    }
  }

  expect(violations).toEqual([])
})

test('production import boundary detects static, re-exported, and dynamic ELF imports', () => {
  expect(moduleSpecifiers(`
    import '../../bun-binary.mjs'
    export { readBinary } from '../../bun-binary.mjs'
    export * from '../../bun-binary.mjs'
    async function load() { return import('../../bun-binary.mjs') }
  `)).toEqual(Array(4).fill('../../bun-binary.mjs'))
})

describe.each([
  ['mmap', () => null],
  ['pread fallback', forcePread],
])('%s backend contract', (_backend, setup) => {
  test('supports bounded slices, lastIndexOf, and merging multiple windows', () => {
    const bytes = Buffer.from('0123--needle--89--needle--XYZ', 'latin1')
    const path = tempFile('windows.bin', bytes)
    const spy = setup()
    let reader
    try {
      reader = openFileReader(path)
      expect(Buffer.from(reader.slice(2, 7))).toEqual(bytes.subarray(2, 9))
      expect(reader.slice(bytes.length, 0)).toEqual(Buffer.alloc(0))
      expect(() => reader.slice(-1, 1)).toThrow(/out of bounds/)
      expect(() => reader.slice(0, -1)).toThrow(/out of bounds/)
      expect(() => reader.slice(bytes.length, 1)).toThrow(/out of bounds/)
      expect(() => reader.slice(0.5, 1)).toThrow(/safe integers/)
      expect(() => reader.slice(0, 1.5)).toThrow(/safe integers/)
      expect(() => reader.slice(Number.NaN, 1)).toThrow(/safe integers/)
      expect(() => reader.slice(0, Number.POSITIVE_INFINITY)).toThrow(/safe integers/)
      expect(reader.u8(0)).toBe(bytes.readUInt8(0))
      expect(reader.u16(1)).toBe(bytes.readUInt16LE(1))
      expect(reader.u32(2)).toBe(bytes.readUInt32LE(2))
      expect(reader.u64(3)).toBe(Number(bytes.readBigUInt64LE(3)))
      expect(reader.toString('latin1', 6, 12)).toBe(bytes.toString('latin1', 6, 12))
      expect(reader.lastIndexOf(Buffer.from('needle'), 0, bytes.length)).toBe(18)
      expect(reader.lastIndexOf(Buffer.from('absent'), 0, bytes.length)).toBe(-1)
      expect(() => reader.lastIndexOf(Buffer.from('needle'), -1, bytes.length)).toThrow(/out of bounds/)
      expect(() => reader.lastIndexOf(Buffer.from('needle'), 0, bytes.length + 1)).toThrow(/out of bounds/)

      const windows = [[0, 5], [5, 8], [13, 4], [17, bytes.length - 17]]
      const merged = Buffer.concat(windows.map(([offset, length]) => Buffer.from(reader.slice(offset, length))))
      expect(merged).toEqual(bytes)
    } finally {
      spy?.mockRestore()
      reader?.close()
    }
  })

  test('fails every data access after close', () => {
    const path = tempFile('closed.bin', Buffer.from('closed reader'))
    const spy = setup()
    const reader = openFileReader(path)
    spy?.mockRestore()
    reader.close()
    expect(() => reader.slice(0, 1)).toThrow(/used after close/)
    expect(() => reader.toString('utf8', 0, 1)).toThrow(/used after close/)
    expect(() => reader.lastIndexOf(Buffer.from('c'), 0, 1)).toThrow(/used after close/)
  })
})