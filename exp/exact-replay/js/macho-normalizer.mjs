import { readFileSync } from 'node:fs'

const LC_SEGMENT = 0x1
const LC_SEGMENT_64 = 0x19
const LC_CODE_SIGNATURE = 0x1d

export class MachOFormatError extends Error {
  constructor(message) {
    super(message)
    this.name = 'MachOFormatError'
  }
}

function formatError(message) {
  throw new MachOFormatError(`invalid thin Mach-O: ${message}`)
}

function headerFormat(bytes) {
  if (bytes.length < 4) formatError('truncated magic')
  const magic = bytes.subarray(0, 4).toString('hex')
  if (magic === 'cffaedfe') return { bits: 64, endian: 'little', headerSize: 32 }
  if (magic === 'feedfacf') return { bits: 64, endian: 'big', headerSize: 32 }
  if (magic === 'cefaedfe') return { bits: 32, endian: 'little', headerSize: 28 }
  if (magic === 'feedface') return { bits: 32, endian: 'big', headerSize: 28 }
  formatError(`unsupported magic ${magic}`)
}

function readers(bytes, endian) {
  const little = endian === 'little'
  return {
    uint32(offset) {
      if (offset < 0 || offset + 4 > bytes.length) formatError(`truncated uint32 at ${offset}`)
      return little ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset)
    },
    uint64(offset) {
      if (offset < 0 || offset + 8 > bytes.length) formatError(`truncated uint64 at ${offset}`)
      const value = little ? bytes.readBigUInt64LE(offset) : bytes.readBigUInt64BE(offset)
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) formatError(`uint64 at ${offset} exceeds the supported file range`)
      return Number(value)
    },
  }
}

function segmentName(bytes, offset) {
  const end = bytes.indexOf(0, offset)
  const boundedEnd = end === -1 || end > offset + 16 ? offset + 16 : end
  return bytes.subarray(offset, boundedEnd).toString('ascii')
}

export function parseMachO(input) {
  const bytes = Buffer.from(input)
  const format = headerFormat(bytes)
  if (bytes.length < format.headerSize) formatError('truncated header')
  const read = readers(bytes, format.endian)
  const ncmds = read.uint32(16)
  const sizeofcmds = read.uint32(20)
  const commandsEnd = format.headerSize + sizeofcmds
  if (commandsEnd > bytes.length) formatError('load command region exceeds the file')

  const signatures = []
  const linkedits = []
  let commandOffset = format.headerSize
  for (let index = 0; index < ncmds; index += 1) {
    if (commandOffset + 8 > commandsEnd) formatError(`truncated load command ${index}`)
    const cmd = read.uint32(commandOffset)
    const cmdsize = read.uint32(commandOffset + 4)
    if (cmdsize < 8 || cmdsize % 4 !== 0) formatError(`invalid cmdsize for load command ${index}`)
    const commandEnd = commandOffset + cmdsize
    if (commandEnd > commandsEnd) formatError(`truncated load command ${index}`)

    if (cmd === LC_CODE_SIGNATURE) {
      if (cmdsize !== 16) formatError('LC_CODE_SIGNATURE must be exactly 16 bytes')
      signatures.push({
        commandOffset,
        dataoff: read.uint32(commandOffset + 8),
        datasize: read.uint32(commandOffset + 12),
      })
    }

    const expectedSegmentCommand = format.bits === 64 ? LC_SEGMENT_64 : LC_SEGMENT
    if (cmd === expectedSegmentCommand && segmentName(bytes, commandOffset + 8) === '__LINKEDIT') {
      const minimumSize = format.bits === 64 ? 72 : 56
      if (cmdsize < minimumSize) formatError('truncated __LINKEDIT segment command')
      linkedits.push(format.bits === 64
        ? {
            commandOffset,
            segname: '__LINKEDIT',
            vmsizeOffset: commandOffset + 32,
            fileoff: read.uint64(commandOffset + 40),
            filesizeOffset: commandOffset + 48,
            vmsize: read.uint64(commandOffset + 32),
            filesize: read.uint64(commandOffset + 48),
          }
        : {
            commandOffset,
            segname: '__LINKEDIT',
            vmsizeOffset: commandOffset + 28,
            fileoff: read.uint32(commandOffset + 32),
            filesizeOffset: commandOffset + 36,
            vmsize: read.uint32(commandOffset + 28),
            filesize: read.uint32(commandOffset + 36),
          })
    }
    commandOffset = commandEnd
  }

  if (commandOffset !== commandsEnd) formatError('ncmds does not consume sizeofcmds')
  if (signatures.length !== 1) formatError(`expected one LC_CODE_SIGNATURE, found ${signatures.length}`)
  if (linkedits.length !== 1) formatError(`expected one __LINKEDIT segment, found ${linkedits.length}`)
  const signature = signatures[0]
  const linkedit = linkedits[0]
  if (signature.datasize === 0) formatError('empty code signature blob')
  const signatureEnd = signature.dataoff + signature.datasize
  const linkeditEnd = linkedit.fileoff + linkedit.filesize
  if (signatureEnd > bytes.length || signatureEnd < signature.dataoff) formatError('code signature blob is out of bounds')
  if (linkeditEnd > bytes.length || linkeditEnd < linkedit.fileoff) formatError('__LINKEDIT range is out of bounds')
  if (signature.dataoff < linkedit.fileoff || signatureEnd > linkeditEnd) formatError('code signature blob is outside __LINKEDIT')
  if (signatureEnd !== bytes.length || linkeditEnd !== bytes.length) formatError('code signature and __LINKEDIT must end at EOF')
  if (signature.dataoff < commandsEnd) formatError('code signature overlaps load commands')

  return {
    ...format,
    ncmds,
    sizeofcmds,
    commandsEnd,
    fileLength: bytes.length,
    signature,
    linkedit,
  }
}

function write32(bytes, offset, value, endian) {
  if (endian === 'little') bytes.writeUInt32LE(value, offset)
  else bytes.writeUInt32BE(value, offset)
}

function writeSize(bytes, offset, value, parsed) {
  if (parsed.bits === 32) return write32(bytes, offset, value, parsed.endian)
  const bigint = BigInt(value)
  if (parsed.endian === 'little') bytes.writeBigUInt64LE(bigint, offset)
  else bytes.writeBigUInt64BE(bigint, offset)
}

export function normalizeMachO(input) {
  const bytes = Buffer.from(input)
  const parsed = parseMachO(bytes)
  const normalized = Buffer.from(bytes.subarray(0, parsed.signature.dataoff))
  write32(normalized, parsed.signature.commandOffset + 8, 0, parsed.endian)
  write32(normalized, parsed.signature.commandOffset + 12, 0, parsed.endian)
  const unsignedLinkeditSize = parsed.signature.dataoff - parsed.linkedit.fileoff
  writeSize(normalized, parsed.linkedit.filesizeOffset, unsignedLinkeditSize, parsed)
  writeSize(normalized, parsed.linkedit.vmsizeOffset, unsignedLinkeditSize, parsed)
  return normalized
}

if (import.meta.main) {
  const filePath = process.argv[2]
  if (!filePath) throw new Error('usage: bun macho-normalizer.mjs <path>')
  try {
    process.stdout.write(normalizeMachO(readFileSync(filePath)))
  } catch (error) {
    if (!(error instanceof MachOFormatError)) throw error
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 3
  }
}