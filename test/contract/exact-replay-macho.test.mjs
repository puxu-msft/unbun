import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { normalizeMachO, parseMachO } from '../../exp/exact-replay/js/macho-normalizer.mjs'

const FIXTURE_ROOT = path.resolve(import.meta.dir, '../../exp/exact-replay/fixtures/macho')
const JS_NORMALIZER = path.resolve(import.meta.dir, '../../exp/exact-replay/js/macho-normalizer.mjs')
const PYTHON_NORMALIZER = path.resolve(import.meta.dir, '../../exp/exact-replay/python/macho_normalizer.py')
const boundaries = [
  { implementation: 'js', command: 'bun', args: [JS_NORMALIZER] },
  { implementation: 'python', command: 'python3', args: [PYTHON_NORMALIZER] },
]
const created = []

afterEach(() => {
  for (const target of created.splice(0)) rmSync(target, { recursive: true, force: true })
})

function runNormalizer(boundary, filePath) {
  return spawnSync(boundary.command, [...boundary.args, filePath], { cwd: path.resolve(import.meta.dir, '../..') })
}

function makeTempFixture(bytes, name) {
  const root = mkdtempSync(path.join(tmpdir(), 'unbun-macho-contract-'))
  created.push(root)
  const filePath = path.join(root, name)
  writeFileSync(filePath, bytes)
  return filePath
}

describe('Mach-O signature normalization fixture and gate', () => {
  test('pins a real Bun cross-compiled thin Mach-O source and two auditable synthetic signature layouts', () => {
    const manifest = JSON.parse(readFileSync(path.join(FIXTURE_ROOT, 'manifest.json'), 'utf8'))
    expect(manifest).toMatchObject({
      schema: 'unbun.exact-replay.macho-fixtures',
      schema_version: 1,
      format: 'macho',
      arch: 'x86_64',
      executable: false,
      normalization: 'lc-code-signature-v1',
      signature_evidence: 'synthetic-not-codesign-equivalent',
    })
    expect(manifest.provenance.generation_command).toBe('bun exp/exact-replay/fixtures/macho/generate-fixtures.mjs')
    expect(manifest.provenance.cross_compile_command).toContain('--target=bun-darwin-x64')
    expect(manifest.source_macho).toMatchObject({ magic: 'MH_MAGIC_64', ncmds: 23, sizeofcmds: 2632 })

    const sourceHeader = readFileSync(path.join(FIXTURE_ROOT, manifest.source_macho.header_path))
    expect(sourceHeader).toHaveLength(manifest.source_macho.header_size)
    expect(sourceHeader.readUInt32LE(0)).toBe(0xfeedfacf)
    expect(sourceHeader.readUInt32LE(16)).toBe(manifest.source_macho.ncmds)
    expect(sourceHeader.readUInt32LE(20)).toBe(manifest.source_macho.sizeofcmds)

    const original = readFileSync(path.join(FIXTURE_ROOT, manifest.fixtures['synthetic-original-layout'].path))
    const resigned = readFileSync(path.join(FIXTURE_ROOT, manifest.fixtures['synthetic-adhoc-layout'].path))
    const originalParsed = parseMachO(original)
    const resignedParsed = parseMachO(resigned)
    expect(originalParsed.signature.datasize).not.toBe(resignedParsed.signature.datasize)
    expect(originalParsed.linkedit.filesize).not.toBe(resignedParsed.linkedit.filesize)
    expect(originalParsed.linkedit.vmsize).not.toBe(resignedParsed.linkedit.vmsize)
    expect(originalParsed.sizeofcmds).toBe(resignedParsed.sizeofcmds)
    expect(original.length).not.toBe(resigned.length)
    expect(normalizeMachO(original)).toEqual(normalizeMachO(resigned))
  })

  test('keeps macOS writes disabled because Linux cannot prove real ad-hoc codesign equivalence', () => {
    const gate = JSON.parse(readFileSync(path.join(FIXTURE_ROOT, 'platform-gate.json'), 'utf8'))
    expect(gate).toMatchObject({
      platform: 'macos',
      format: 'macho',
      writes: 'disabled',
      conclusion: 'not-proven',
      reason: 'real-codesign-equivalence-unavailable',
      evidence: {
        parser_negative_vectors: ['conflicting-command', 'out-of-bounds-blob', 'overlapping-command', 'truncated-load-command'],
        implementations: ['js', 'python'],
        synthetic_signature_equivalence: true,
        real_adhoc_equivalence: false,
        skipped: false,
      },
    })
  })

  test('both independent process boundaries produce identical complete normalized bytes', () => {
    const manifest = JSON.parse(readFileSync(path.join(FIXTURE_ROOT, 'manifest.json'), 'utf8'))
    const outputs = []
    for (const [fixtureName, fixture] of Object.entries(manifest.fixtures)) {
      const filePath = path.join(FIXTURE_ROOT, fixture.path)
      for (const boundary of boundaries) {
        const result = runNormalizer(boundary, filePath)
        expect(result.status, `${fixtureName}:${boundary.implementation}`).toBe(0)
        expect(result.stderr.toString('utf8'), `${fixtureName}:${boundary.implementation}`).toBe('')
        outputs.push(result.stdout)
      }
    }
    expect(outputs[0].length).toBeLessThan(manifest.fixtures['synthetic-original-layout'].size)
    for (const output of outputs.slice(1)) expect(output).toEqual(outputs[0])
  })

  test('both implementations fail closed for conflicting, out-of-bounds, overlapping, and truncated structures', () => {
    const manifest = JSON.parse(readFileSync(path.join(FIXTURE_ROOT, 'manifest.json'), 'utf8'))
    const original = readFileSync(path.join(FIXTURE_ROOT, manifest.fixtures['synthetic-original-layout'].path))
    const parsed = parseMachO(original)
    const invalidInputs = {
      'conflicting-command': (() => {
        const command = original.subarray(parsed.signature.commandOffset, parsed.signature.commandOffset + 16)
        const bytes = Buffer.concat([original.subarray(0, parsed.commandsEnd), command, original.subarray(parsed.commandsEnd)])
        bytes.writeUInt32LE(parsed.ncmds + 1, 16)
        bytes.writeUInt32LE(parsed.sizeofcmds + 16, 20)
        return bytes
      })(),
      'out-of-bounds-blob': (() => {
        const bytes = Buffer.from(original)
        bytes.writeUInt32LE(bytes.length + 1, parsed.signature.commandOffset + 8)
        return bytes
      })(),
      'overlapping-command': (() => {
        const bytes = Buffer.from(original)
        bytes.writeUInt32LE(parsed.commandsEnd - 8, parsed.signature.commandOffset + 8)
        bytes.writeUInt32LE(bytes.length - (parsed.commandsEnd - 8), parsed.signature.commandOffset + 12)
        return bytes
      })(),
      'truncated-load-command': (() => {
        const bytes = Buffer.from(original)
        bytes.writeUInt32LE(24, parsed.signature.commandOffset + 4)
        return bytes
      })(),
    }

    for (const [name, bytes] of Object.entries(invalidInputs)) {
      const filePath = makeTempFixture(bytes, `${name}.macho`)
      for (const boundary of boundaries) {
        const result = runNormalizer(boundary, filePath)
        expect(result.status, `${name}:${boundary.implementation}`).toBe(3)
        expect(result.stdout, `${name}:${boundary.implementation}`).toHaveLength(0)
        expect(result.stderr.toString('utf8'), `${name}:${boundary.implementation}`).toContain('invalid thin Mach-O')
      }
    }
  })
})