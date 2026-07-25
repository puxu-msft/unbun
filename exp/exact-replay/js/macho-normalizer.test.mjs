import { describe, expect, test } from 'bun:test'

import { MachOFormatError, normalizeMachO, parseMachO } from './macho-normalizer.mjs'

function makeFixture({ bits = 64, endian = 'little', signatureSize = 32 } = {}) {
  const little = endian === 'little'
  const headerSize = bits === 64 ? 32 : 28
  const segmentCommand = bits === 64 ? 0x19 : 0x1
  const segmentSize = bits === 64 ? 72 : 56
  const signatureSizeCommand = 16
  const commandSize = segmentSize + signatureSizeCommand
  const payload = Buffer.from('unbun-macho-normalizer-v1')
  const signatureOffset = headerSize + commandSize + payload.length
  const fileSize = signatureOffset + signatureSize
  const bytes = Buffer.alloc(fileSize)
  const write32 = little ? bytes.writeUInt32LE.bind(bytes) : bytes.writeUInt32BE.bind(bytes)
  const write64 = little ? bytes.writeBigUInt64LE.bind(bytes) : bytes.writeBigUInt64BE.bind(bytes)
  write32(bits === 64 ? 0xfeedfacf : 0xfeedface, 0)
  write32(bits === 64 ? 0x01000007 : 7, 4)
  write32(3, 8)
  write32(2, 12)
  write32(2, 16)
  write32(commandSize, 20)
  write32(0, 24)
  if (bits === 64) write32(0, 28)

  let offset = headerSize
  write32(segmentCommand, offset)
  write32(segmentSize, offset + 4)
  bytes.write('__LINKEDIT', offset + 8, 'ascii')
  if (bits === 64) {
    write64(0x100000000n, offset + 24)
    write64(BigInt(payload.length + signatureSize), offset + 32)
    write64(BigInt(headerSize + commandSize), offset + 40)
    write64(BigInt(payload.length + signatureSize), offset + 48)
  } else {
    write32(0x1000, offset + 24)
    write32(fileSize, offset + 28)
    write32(headerSize + commandSize, offset + 32)
    write32(payload.length + signatureSize, offset + 36)
  }
  offset += segmentSize
  write32(0x1d, offset)
  write32(signatureSizeCommand, offset + 4)
  write32(signatureOffset, offset + 8)
  write32(signatureSize, offset + 12)
  payload.copy(bytes, headerSize + commandSize)
  bytes.fill(signatureSize === 32 ? 0xa1 : 0xb2, signatureOffset)
  return bytes
}

describe('JavaScript Mach-O normalizer', () => {
  test.each([
    [64, 'little'],
    [64, 'big'],
    [32, 'little'],
    [32, 'big'],
  ])('parses a thin %i-bit %s-endian header and its unique signature command', (bits, endian) => {
    const parsed = parseMachO(makeFixture({ bits, endian }))
    expect(parsed).toMatchObject({ bits, endian, ncmds: 2, signature: { datasize: 32 }, linkedit: { segname: '__LINKEDIT' } })
  })

  test('normalizes different signature lengths and all affected size fields to identical bytes', () => {
    const original = makeFixture({ signatureSize: 32 })
    const resigned = makeFixture({ signatureSize: 80 })
    const originalParsed = parseMachO(original)
    const resignedParsed = parseMachO(resigned)
    expect(resignedParsed.signature.datasize).not.toBe(originalParsed.signature.datasize)
    expect(resignedParsed.linkedit.filesize).not.toBe(originalParsed.linkedit.filesize)
    expect(resignedParsed.linkedit.vmsize).not.toBe(originalParsed.linkedit.vmsize)
    expect(resigned.length).not.toBe(original.length)
    expect(normalizeMachO(resigned)).toEqual(normalizeMachO(original))
  })

  test.each(['conflicting-command', 'out-of-bounds-blob', 'overlapping-command', 'truncated-load-command'])(
    'fails closed for %s',
    (kind) => {
      const bytes = makeFixture()
      if (kind === 'conflicting-command') {
        const command = Buffer.from(bytes.subarray(104, 120))
        const expanded = Buffer.concat([bytes.subarray(0, 120), command, bytes.subarray(120)])
        expanded.writeUInt32LE(3, 16)
        expanded.writeUInt32LE(104, 20)
        expect(() => parseMachO(expanded)).toThrow(MachOFormatError)
      } else if (kind === 'out-of-bounds-blob') {
        bytes.writeUInt32LE(bytes.length + 1, 112)
        expect(() => normalizeMachO(bytes)).toThrow(MachOFormatError)
      } else if (kind === 'overlapping-command') {
        bytes.writeUInt32LE(112, 112)
        bytes.writeUInt32LE(bytes.length - 112, 116)
        expect(() => normalizeMachO(bytes)).toThrow(MachOFormatError)
      } else {
        bytes.writeUInt32LE(24, 108)
        expect(() => parseMachO(bytes)).toThrow(MachOFormatError)
      }
    },
  )

  test.each(['fat-container', 'missing-signature', 'signature-not-at-eof'])(
    'rejects an unverifiable %s boundary',
    (kind) => {
      const bytes = makeFixture()
      if (kind === 'fat-container') bytes.writeUInt32BE(0xcafebabe, 0)
      else if (kind === 'missing-signature') bytes.writeUInt32LE(0x2, 104)
      else bytes.writeUInt32LE(bytes.readUInt32LE(112) - 1, 112)
      expect(() => normalizeMachO(bytes)).toThrow(MachOFormatError)
    },
  )

  test('fails closed for a big-endian out-of-bounds signature blob', () => {
    const bytes = makeFixture({ endian: 'big' })
    bytes.writeUInt32BE(bytes.length + 1, 112)
    expect(() => normalizeMachO(bytes)).toThrow(MachOFormatError)
  })
})