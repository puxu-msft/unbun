import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const PE_OFFSET = 0x80
const OPTIONAL_HEADER_OFFSET = 0x98
const OPTIONAL_HEADER_SIZE = 0xf0
const SECTION_TABLE_OFFSET = OPTIONAL_HEADER_OFFSET + OPTIONAL_HEADER_SIZE
const HEADER_SIZE = 0x200
const PAYLOAD_SIZE = 1031
const RAW_SECTION_SIZE = 0x600
const NORMALIZED_SIZE = HEADER_SIZE + RAW_SECTION_SIZE
const SOURCE_MANIFEST_PATH = path.resolve(import.meta.dir, '..', 'manifest.json')
const SOURCE_MANIFEST = JSON.parse(readFileSync(SOURCE_MANIFEST_PATH, 'utf8'))

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function sourceFixturePath(name) {
  return path.resolve(path.dirname(SOURCE_MANIFEST_PATH), SOURCE_MANIFEST.fixtures[name].path)
}

function buildHeader() {
  const header = Buffer.alloc(HEADER_SIZE)
  header.write('MZ', 0, 'ascii')
  header.writeUInt32LE(PE_OFFSET, 0x3c)
  header.write('PE\0\0', PE_OFFSET, 'binary')

  const coff = PE_OFFSET + 4
  header.writeUInt16LE(0x8664, coff)
  header.writeUInt16LE(1, coff + 2)
  header.writeUInt16LE(OPTIONAL_HEADER_SIZE, coff + 16)
  header.writeUInt16LE(0x0022, coff + 18)

  const optional = OPTIONAL_HEADER_OFFSET
  header.writeUInt16LE(0x20b, optional)
  header.writeUInt32LE(RAW_SECTION_SIZE, optional + 4)
  header.writeUInt32LE(0x1000, optional + 20)
  header.writeBigUInt64LE(0x140000000n, optional + 24)
  header.writeUInt32LE(0x1000, optional + 32)
  header.writeUInt32LE(0x200, optional + 36)
  header.writeUInt16LE(6, optional + 40)
  header.writeUInt16LE(6, optional + 48)
  header.writeUInt32LE(0x2000, optional + 56)
  header.writeUInt32LE(HEADER_SIZE, optional + 60)
  header.writeUInt16LE(3, optional + 68)
  header.writeBigUInt64LE(0x100000n, optional + 72)
  header.writeBigUInt64LE(0x1000n, optional + 80)
  header.writeBigUInt64LE(0x100000n, optional + 88)
  header.writeBigUInt64LE(0x1000n, optional + 96)
  header.writeUInt32LE(16, optional + 108)

  header.write('.payload', SECTION_TABLE_OFFSET, 'ascii')
  header.writeUInt32LE(PAYLOAD_SIZE, SECTION_TABLE_OFFSET + 8)
  header.writeUInt32LE(0x1000, SECTION_TABLE_OFFSET + 12)
  header.writeUInt32LE(RAW_SECTION_SIZE, SECTION_TABLE_OFFSET + 16)
  header.writeUInt32LE(HEADER_SIZE, SECTION_TABLE_OFFSET + 20)
  header.writeUInt32LE(0x40000040, SECTION_TABLE_OFFSET + 36)
  return header
}

function wrapPayload(payload) {
  if (payload.length !== PAYLOAD_SIZE) throw new Error(`expected ${PAYLOAD_SIZE}-byte payload, got ${payload.length}`)
  return Buffer.concat([buildHeader(), payload, Buffer.alloc(RAW_SECTION_SIZE - payload.length)])
}

const fixtureNames = [
  'clean',
  'target-source-exec',
  'target-agent-model',
  'target-source-exec-agent-model',
  'target-channels',
  'target-all',
  'mixed-replayable',
  'mixed-unreplayable',
]
const fixtures = {}
const fixtureBytes = {}
for (const name of fixtureNames) {
  const bytes = wrapPayload(readFileSync(sourceFixturePath(name)))
  const fileName = `pe-2.1.175-${name}.exe`
  writeFileSync(path.join(import.meta.dir, fileName), bytes)
  fixtureBytes[name] = bytes
  fixtures[name] = { path: fileName, size: bytes.length, sha256: sha256(bytes) }
}
const sourceFixtureBySha256 = new Map(Object.entries(SOURCE_MANIFEST.fixtures).map(([name, fixture]) => [fixture.sha256, name]))

function adjustedCase(name) {
  const source = structuredClone(SOURCE_MANIFEST.cases[name])
  if (source.current_fixture) source.current_sha256 = fixtures[source.current_fixture].sha256
  if (source.mutation) {
    source.mutation.offset += HEADER_SIZE
    const current = Buffer.from(fixtureBytes[source.base_fixture])
    current[source.mutation.offset] = source.mutation.byte
    source.current_sha256 = sha256(current)
  }
  if (source.expected.expected_sha256 !== null) {
    const expectedFixture = sourceFixtureBySha256.get(source.expected.expected_sha256)
    if (!expectedFixture || !fixtures[expectedFixture]) throw new Error(`case ${name} expected hash does not map to a PE fixture`)
    source.expected.expected_sha256 = fixtures[expectedFixture].sha256
  }
  return source
}

const cases = Object.fromEntries(Object.keys(SOURCE_MANIFEST.cases).map((name) => [name, adjustedCase(name)]))
const manifest = {
  schema: 'unbun.exact-replay.pe-fixtures',
  schema_version: 1,
  feature_contract: 'claude-v1',
  lineage_algorithm: 'claude-v1-exact-replay',
  format: 'pe',
  executable: false,
  arch: 'x86_64',
  signature: 'unsigned-synthetic',
  embedded_version: SOURCE_MANIFEST.embedded_version,
  normalization: 'identity-v1',
  header_size: HEADER_SIZE,
  payload_offset: HEADER_SIZE,
  payload_size: PAYLOAD_SIZE,
  raw_section_size: RAW_SECTION_SIZE,
  normalized_size: NORMALIZED_SIZE,
  provenance: {
    source: '../manifest.json frozen synthetic replay corpus wrapped in a deterministic minimal PE32+ image',
    generation_command: 'bun exp/exact-replay/fixtures/pe/generate-fixtures.mjs',
    audit_basis: 'One x86_64 PE32+ image section contains each frozen synthetic vector unchanged; DOS, COFF, optional-header, section, alignment, size, and complete-file hashes are contract-tested.',
    license: 'repository-generated test fixture',
    frozen_at: '2026-07-23',
  },
  baseline: fixtures.clean,
  fixtures,
  target_sets: SOURCE_MANIFEST.target_sets,
  cases,
}
writeFileSync(path.join(import.meta.dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

const gate = {
  schema: 'unbun.exact-replay.platform-gate',
  schema_version: 1,
  platform: 'windows',
  format: 'pe',
  writes: 'enabled',
  evidence: {
    fixture_manifest: 'manifest.json',
    contract_test: 'test/contract/exact-replay-pe.test.mjs',
    required_cases: Object.keys(cases),
    negative_headers: ['bad-dos-magic', 'bad-pe-magic', 'truncated-header', 'contradictory-optional-header'],
    implementations: ['js', 'python'],
    full_byte_cross_verification: true,
    skipped: false,
  },
}
writeFileSync(path.join(import.meta.dir, 'platform-gate.json'), `${JSON.stringify(gate, null, 2)}\n`)