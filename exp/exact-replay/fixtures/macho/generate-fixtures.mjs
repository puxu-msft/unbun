import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { parseMachO } from '../../js/macho-normalizer.mjs'

const SOURCE_PATH = path.join(import.meta.dir, 'entry.js')
const CROSS_COMPILE_COMMAND = 'bun build --compile --target=bun-darwin-x64 --outfile=<temporary>/source-macho exp/exact-replay/fixtures/macho/entry.js'
const SIGNATURE_SIZES = { 'synthetic-original-layout': 32, 'synthetic-adhoc-layout': 80 }

for (const obsoleteName of ['original-signed.macho', 'ad-hoc-resigned.macho']) {
  rmSync(path.join(import.meta.dir, obsoleteName), { force: true })
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function align(value, alignment) {
  return Math.ceil(value / alignment) * alignment
}

function write64LE(bytes, offset, value) {
  bytes.writeBigUInt64LE(BigInt(value), offset)
}

function syntheticSuperBlob(size, fill) {
  if (size < 12) throw new Error('synthetic SuperBlob must contain its fixed header')
  const blob = Buffer.alloc(size, fill)
  blob.writeUInt32BE(0xfade0cc0, 0)
  blob.writeUInt32BE(size, 4)
  blob.writeUInt32BE(0, 8)
  return blob
}

function compactFixture(sourceHeader, parsed, signatureSize, fill) {
  const headerSize = 32
  const linkeditCommandOffset = headerSize
  const signatureCommandOffset = linkeditCommandOffset + 72
  const commandsEnd = signatureCommandOffset + 16
  const linkeditFileoff = align(commandsEnd, 16)
  const payload = Buffer.alloc(64)
  payload.write('unbun-macho-linkedit-payload-v1', 0, 'ascii')
  const signatureOffset = align(linkeditFileoff + payload.length, 16)
  const fileLength = signatureOffset + signatureSize
  const bytes = Buffer.alloc(fileLength)
  sourceHeader.copy(bytes, 0, 0, headerSize)
  bytes.writeUInt32LE(2, 16)
  bytes.writeUInt32LE(88, 20)
  bytes.writeUInt32LE(0x19, linkeditCommandOffset)
  bytes.writeUInt32LE(72, linkeditCommandOffset + 4)
  bytes.write('__LINKEDIT', linkeditCommandOffset + 8, 'ascii')
  write64LE(bytes, linkeditCommandOffset + 24, 0x100000000)
  write64LE(bytes, linkeditCommandOffset + 32, fileLength - linkeditFileoff)
  write64LE(bytes, linkeditCommandOffset + 40, linkeditFileoff)
  write64LE(bytes, linkeditCommandOffset + 48, fileLength - linkeditFileoff)
  bytes.writeUInt32LE(1, linkeditCommandOffset + 56)
  bytes.writeUInt32LE(1, linkeditCommandOffset + 60)
  bytes.writeUInt32LE(0, linkeditCommandOffset + 64)
  bytes.writeUInt32LE(0, linkeditCommandOffset + 68)
  bytes.writeUInt32LE(0x1d, signatureCommandOffset)
  bytes.writeUInt32LE(16, signatureCommandOffset + 4)
  bytes.writeUInt32LE(signatureOffset, signatureCommandOffset + 8)
  bytes.writeUInt32LE(signatureSize, signatureCommandOffset + 12)
  payload.copy(bytes, linkeditFileoff)
  syntheticSuperBlob(signatureSize, fill).copy(bytes, signatureOffset)
  return bytes
}

const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'unbun-macho-fixture-'))
try {
  const sourceMachOPath = path.join(temporaryRoot, 'source-macho')
  execFileSync('bun', ['build', '--compile', '--target=bun-darwin-x64', `--outfile=${sourceMachOPath}`, SOURCE_PATH], {
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  const sourceMachO = readFileSync(sourceMachOPath)
  const parsed = parseMachO(sourceMachO)
  if (parsed.bits !== 64 || parsed.endian !== 'little' || parsed.ncmds !== 23 || parsed.sizeofcmds !== 2632) {
    throw new Error(`unexpected Bun cross-compile layout: ${JSON.stringify(parsed)}`)
  }
  const sourceHeader = sourceMachO.subarray(0, parsed.commandsEnd)
  writeFileSync(path.join(import.meta.dir, 'source-header.bin'), sourceHeader)

  const fixtures = {}
  for (const [name, signatureSize] of Object.entries(SIGNATURE_SIZES)) {
    const bytes = compactFixture(sourceHeader, parsed, signatureSize, name === 'synthetic-original-layout' ? 0xa1 : 0xb2)
    const fileName = `${name}.macho`
    writeFileSync(path.join(import.meta.dir, fileName), bytes)
    const compact = parseMachO(bytes)
    fixtures[name] = {
      path: fileName,
      size: bytes.length,
      sha256: sha256(bytes),
      signature: {
        kind: 'synthetic-superblob',
        dataoff: compact.signature.dataoff,
        datasize: compact.signature.datasize,
      },
      linkedit: {
        fileoff: compact.linkedit.fileoff,
        filesize: compact.linkedit.filesize,
        vmsize: compact.linkedit.vmsize,
      },
      sizeofcmds: compact.sizeofcmds,
    }
  }

  const manifest = {
    schema: 'unbun.exact-replay.macho-fixtures',
    schema_version: 1,
    format: 'macho',
    arch: 'x86_64',
    executable: false,
    normalization: 'lc-code-signature-v1',
    signature_evidence: 'synthetic-not-codesign-equivalent',
    provenance: {
      source: 'entry.js cross-compiled by Bun 1.3.14 to a real thin x86_64 Mach-O; compact fixtures preserve its Mach header identity fields and use a deterministic minimal LC_SEGMENT_64 __LINKEDIT plus LC_CODE_SIGNATURE topology.',
      generation_command: 'bun exp/exact-replay/fixtures/macho/generate-fixtures.mjs',
      cross_compile_command: CROSS_COMPILE_COMMAND,
      audit_basis: 'The generator rejects drift in bits, endian, ncmds, and sizeofcmds; source-header.bin pins the complete real header/load-command bytes. Compact fixtures are independently parseable minimal Mach-O structures. Synthetic SuperBlobs exercise parser and size normalization only.',
      license: 'repository-generated test fixture',
      frozen_at: '2026-07-23',
      bun_version: '1.3.14',
    },
    source: {
      path: 'entry.js',
      sha256: sha256(readFileSync(SOURCE_PATH)),
    },
    source_macho: {
      magic: 'MH_MAGIC_64',
      endian: parsed.endian,
      ncmds: parsed.ncmds,
      sizeofcmds: parsed.sizeofcmds,
      file_size: sourceMachO.length,
      sha256: sha256(sourceMachO),
      header_path: 'source-header.bin',
      header_size: sourceHeader.length,
      header_sha256: sha256(sourceHeader),
      signature: { dataoff: parsed.signature.dataoff, datasize: parsed.signature.datasize },
      linkedit: {
        fileoff: parsed.linkedit.fileoff,
        filesize: parsed.linkedit.filesize,
        vmsize: parsed.linkedit.vmsize,
      },
    },
    fixtures,
  }
  writeFileSync(path.join(import.meta.dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  const gate = {
    schema: 'unbun.exact-replay.platform-gate',
    schema_version: 1,
    platform: 'macos',
    format: 'macho',
    writes: 'disabled',
    conclusion: 'not-proven',
    reason: 'real-codesign-equivalence-unavailable',
    evidence: {
      fixture_manifest: 'manifest.json',
      contract_test: 'test/contract/exact-replay-macho.test.mjs',
      parser_negative_vectors: ['conflicting-command', 'out-of-bounds-blob', 'overlapping-command', 'truncated-load-command'],
      implementations: ['js', 'python'],
      synthetic_signature_equivalence: true,
      real_adhoc_equivalence: false,
      codesign_available: false,
      skipped: false,
    },
  }
  writeFileSync(path.join(import.meta.dir, 'platform-gate.json'), `${JSON.stringify(gate, null, 2)}\n`)
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true })
}