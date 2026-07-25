import { afterEach, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dir, '../..')
const EXP_ROOT = path.join(ROOT, 'exp', 'exact-replay')
const MANIFEST_PATH = path.join(EXP_ROOT, 'fixtures', 'pe', 'manifest.json')
const GATE_PATH = path.join(EXP_ROOT, 'fixtures', 'pe', 'platform-gate.json')
const HEADER_SIZE = 512
const HASH_PATTERN = /^[0-9a-f]{64}$/
const SUCCESS_CASES = [
  'clean',
  'target-source-exec',
  'target-agent-model',
  'target-source-exec-agent-model',
  'target-channels',
  'target-all',
  'mixed-replayable',
]
const REQUIRED_CASES = [
  ...SUCCESS_CASES,
  'mixed-unreplayable',
  'same-version-different-build',
  'feature-owned-clean-drift',
]
const boundaries = [
  { implementation: 'js', command: ['bun', path.join(EXP_ROOT, 'js', 'replay-proof.mjs')] },
  { implementation: 'python', command: ['python3', path.join(EXP_ROOT, 'python', 'replay_proof.py')] },
]
const created = []

afterEach(() => {
  for (const target of created.splice(0)) rmSync(target, { recursive: true, force: true })
})

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function loadJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'))
}

function fixturePath(manifest, fixtureName) {
  return path.resolve(path.dirname(MANIFEST_PATH), manifest.fixtures[fixtureName].path)
}

function makeTempFile(bytes, name = 'current.exe') {
  const root = mkdtempSync(path.join(tmpdir(), 'unbun-exact-replay-pe-'))
  created.push(root)
  const filePath = path.join(root, name)
  writeFileSync(filePath, bytes)
  return filePath
}

function currentPathForCase(manifest, caseName) {
  const scenario = manifest.cases[caseName]
  if (scenario.current_fixture) return fixturePath(manifest, scenario.current_fixture)
  const current = readFileSync(fixturePath(manifest, scenario.base_fixture))
  current[scenario.mutation.offset] = scenario.mutation.byte
  return makeTempFile(current, `${caseName}.exe`)
}

async function runProof(boundary, args) {
  const [executable, ...commandArgs] = boundary.command
  const child = spawn(executable, [...commandArgs, ...args], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdout = []
  const stderr = []
  child.stdout.on('data', (chunk) => stdout.push(chunk))
  child.stderr.on('data', (chunk) => stderr.push(chunk))
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  return {
    exitCode,
    output: JSON.parse(Buffer.concat(stdout).toString('utf8')),
    stderr: Buffer.concat(stderr).toString('utf8'),
  }
}

function withoutImplementation(output) {
  const { implementation: _implementation, ...contract } = output
  return contract
}

describe('PE fixture provenance and structure', () => {
  test('pins an auditable deterministic PE32+ fixture corpus', () => {
    const manifest = loadJson(MANIFEST_PATH)
    expect(manifest).toMatchObject({
      schema: 'unbun.exact-replay.pe-fixtures',
      schema_version: 1,
      feature_contract: 'claude-v1',
      lineage_algorithm: 'claude-v1-exact-replay',
      format: 'pe',
      arch: 'x86_64',
      signature: 'unsigned-synthetic',
      executable: false,
      embedded_version: '2.1.175',
      header_size: HEADER_SIZE,
      payload_size: 1031,
      normalized_size: 2048,
      normalization: 'identity-v1',
    })
    expect(manifest.provenance).toEqual({
      source: expect.any(String),
      generation_command: 'bun exp/exact-replay/fixtures/pe/generate-fixtures.mjs',
      audit_basis: expect.any(String),
      license: 'repository-generated test fixture',
      frozen_at: '2026-07-23',
    })
    expect(Object.keys(manifest.cases).sort()).toEqual([...REQUIRED_CASES].sort())
    expect(manifest.target_sets).toHaveLength(8)

    const agentOnly = readFileSync(fixturePath(manifest, 'target-agent-model'))
    expect(agentOnly.subarray(HEADER_SIZE + 8, HEADER_SIZE + 17).toString('ascii')).toBe('@bytecode')
    expect(agentOnly.subarray(HEADER_SIZE + 305, HEADER_SIZE + 346).toString('ascii')).toBe('Q.string()/* any model ................*/')

    for (const fixture of Object.values(manifest.fixtures)) {
      expect(fixture).toEqual({ path: expect.any(String), size: 2048, sha256: expect.stringMatching(HASH_PATTERN) })
      const bytes = readFileSync(path.resolve(path.dirname(MANIFEST_PATH), fixture.path))
      expect(bytes).toHaveLength(fixture.size)
      expect(sha256(bytes)).toBe(fixture.sha256)
      expect(bytes.subarray(0, 2).toString('ascii')).toBe('MZ')
      const peOffset = bytes.readUInt32LE(0x3c)
      expect(peOffset).toBe(0x80)
      expect(bytes.subarray(peOffset, peOffset + 4)).toEqual(Buffer.from('PE\0\0', 'binary'))
    }
  })
})

describe('PE format dispatch and exact replay cross proof', () => {
  test('both implementations reject bad DOS magic, bad PE magic, truncation, and contradictory headers', async () => {
    const manifest = loadJson(MANIFEST_PATH)
    const clean = readFileSync(fixturePath(manifest, 'clean'))
    const invalidInputs = {
      'bad-dos-magic': Buffer.from(clean).fill(0, 0, 2),
      'bad-pe-magic': Buffer.from(clean).fill(0, 0x80, 0x84),
      'truncated-header': clean.subarray(0, 0x90),
      'contradictory-optional-header': (() => {
        const bytes = Buffer.from(clean)
        bytes.writeUInt16LE(0x10b, 0x98)
        return bytes
      })(),
    }

    for (const [name, bytes] of Object.entries(invalidInputs)) {
      const currentPath = makeTempFile(bytes, `${name}.exe`)
      const results = await Promise.all(boundaries.map((boundary) => runProof(boundary, [
        '--manifest', MANIFEST_PATH,
        '--case', 'clean',
        '--current', currentPath,
      ])))
      for (const result of results) {
        expect(result.exitCode, name).toBe(3)
        expect(result.output).toMatchObject({ format: 'pe', supported: false, byte_equal: false, error: 'unsupported_format' })
        expect(result.stderr, name).toContain('PE')
      }
      expect(withoutImplementation(results[0].output), name).toEqual(withoutImplementation(results[1].output))
    }
  })

  test('both implementations agree on complete results for every PE replay vector', async () => {
    const manifest = loadJson(MANIFEST_PATH)
    for (const [caseName, scenario] of Object.entries(manifest.cases)) {
      const currentPath = currentPathForCase(manifest, caseName)
      const results = await Promise.all(boundaries.map((boundary) => runProof(boundary, [
        '--manifest', MANIFEST_PATH,
        '--case', caseName,
        '--current', currentPath,
      ])))

      for (const [index, result] of results.entries()) {
        expect(result.output).toMatchObject({
          implementation: boundaries[index].implementation,
          format: 'pe',
          normalized_size: scenario.normalized_size ?? manifest.normalized_size,
          supported: scenario.expected.supported,
          expected_sha256: scenario.expected.expected_sha256,
          current_sha256: scenario.current_sha256,
          byte_equal: scenario.expected.byte_equal,
          error: scenario.expected.error,
        })
      }
      expect(results[0].exitCode, caseName).toBe(results[1].exitCode)
      expect(withoutImplementation(results[0].output), caseName).toEqual(withoutImplementation(results[1].output))
    }
  })

  test('each successful producer materializes complete bytes verified by the other implementation', async () => {
    const manifest = loadJson(MANIFEST_PATH)
    for (const caseName of SUCCESS_CASES) {
      const scenario = manifest.cases[caseName]
      const currentPath = fixturePath(manifest, scenario.current_fixture)
      for (const [producer, verifier] of [[boundaries[0], boundaries[1]], [boundaries[1], boundaries[0]]]) {
        const expectedPath = makeTempFile(Buffer.alloc(0), `${caseName}-${producer.implementation}.exe`)
        const produced = await runProof(producer, [
          '--manifest', MANIFEST_PATH,
          '--case', caseName,
          '--current', currentPath,
          '--write-expected', expectedPath,
        ])
        expect(produced.exitCode, `${caseName}:${producer.implementation}`).toBe(0)
        expect(existsSync(expectedPath)).toBe(true)
        expect(readFileSync(expectedPath).equals(readFileSync(currentPath)), `${caseName}:${producer.implementation}:bytes`).toBe(true)

        const verified = await runProof(verifier, [
          '--manifest', MANIFEST_PATH,
          '--case', caseName,
          '--current', expectedPath,
        ])
        expect(verified.exitCode, `${caseName}:${verifier.implementation}`).toBe(0)
        expect(verified.output.byte_equal).toBe(true)
        expect(withoutImplementation(verified.output)).toEqual(withoutImplementation(produced.output))
      }
    }
  })

  test('detects non-feature and feature-owned full-byte drift without masking', async () => {
    const manifest = loadJson(MANIFEST_PATH)
    const clean = readFileSync(fixturePath(manifest, 'clean'))
    const targetAll = readFileSync(fixturePath(manifest, 'target-all'))
    const sameBuildVersion = manifest.cases['same-version-different-build']
    const featureOwned = manifest.cases['feature-owned-clean-drift']
    expect(sameBuildVersion.embedded_version).toBe(manifest.embedded_version)
    expect(sameBuildVersion.mutation.ownership).toBe('non-feature')
    expect(featureOwned.mutation.ownership).toBe('channels-decision')
    expect(clean[sameBuildVersion.mutation.offset]).toBe(targetAll[sameBuildVersion.mutation.offset])
    expect(clean[featureOwned.mutation.offset]).not.toBe(targetAll[featureOwned.mutation.offset])
    expect(readFileSync(fixturePath(manifest, 'clean')).subarray(HEADER_SIZE).includes(Buffer.from(manifest.embedded_version))).toBe(true)

    for (const caseName of ['same-version-different-build', 'feature-owned-clean-drift']) {
      for (const boundary of boundaries) {
        const result = await runProof(boundary, [
          '--manifest', MANIFEST_PATH,
          '--case', caseName,
          '--current', currentPathForCase(manifest, caseName),
        ])
        expect(result.exitCode, `${caseName}:${boundary.implementation}`).toBe(4)
        expect(result.output).toMatchObject({ supported: true, byte_equal: false, error: 'baseline_stale_build' })
      }
    }
  })
})

describe('Windows platform gate', () => {
  test('is enabled only by the complete non-skipped Task 1.5 evidence set', () => {
    const gate = loadJson(GATE_PATH)
    expect(gate).toEqual({
      schema: 'unbun.exact-replay.platform-gate',
      schema_version: 1,
      platform: 'windows',
      format: 'pe',
      writes: 'enabled',
      evidence: {
        fixture_manifest: 'manifest.json',
        contract_test: 'test/contract/exact-replay-pe.test.mjs',
        required_cases: REQUIRED_CASES,
        negative_headers: ['bad-dos-magic', 'bad-pe-magic', 'truncated-header', 'contradictory-optional-header'],
        implementations: ['js', 'python'],
        full_byte_cross_verification: true,
        skipped: false,
      },
    })
  })
})