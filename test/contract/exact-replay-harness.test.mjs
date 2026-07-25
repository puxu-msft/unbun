import { afterEach, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dir, '../..')
const EXP_ROOT = path.join(ROOT, 'exp', 'exact-replay')
const MANIFEST_PATH = path.join(EXP_ROOT, 'fixtures', 'manifest.json')
const SCHEMA_PATH = path.join(ROOT, 'contract', 'schemas', 'exact-replay-result.schema.json')
const CLEAN_PATH = path.join(ROOT, 'contract', 'golden', 'claude-v1', 'synthetic-2.1.175-clean.bin')
const ALL_PATCHED_PATH = path.join(ROOT, 'contract', 'golden', 'claude-v1', 'synthetic-2.1.175-all-patched.bin')
const HASH_PATTERN = /^[0-9a-f]{64}$/
const CLEAN_SHA256 = '0a067e12954675a56d6a2aa25c4180c1746005d5cd9e438607d0fb913355ff61'

const boundaries = [
  {
    id: 'exact-replay-js-poc',
    implementation: 'js',
    maturity: 'mature-poc',
    availability: 'available',
    role: 'read-only-proof',
    command: ['bun', path.join(EXP_ROOT, 'js', 'replay-proof.mjs')],
    cwd: ROOT,
  },
  {
    id: 'exact-replay-python-poc',
    implementation: 'python',
    maturity: 'mature-poc',
    availability: 'available',
    role: 'read-only-proof',
    command: ['python3', path.join(EXP_ROOT, 'python', 'replay_proof.py')],
    cwd: ROOT,
  },
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

function makeDriftCopy(sourcePath, offset, byte) {
  const root = mkdtempSync(path.join(tmpdir(), 'unbun-exact-replay-'))
  created.push(root)
  const currentPath = path.join(root, 'current.bin')
  copyFileSync(sourcePath, currentPath)
  const current = readFileSync(currentPath)
  current[offset] = byte
  writeFileSync(currentPath, current)
  return currentPath
}

async function resultValidator() {
  const { default: Ajv2020 } = await import('ajv/dist/2020.js')
  const ajv = new Ajv2020({ allErrors: true, strict: true })
  return ajv.compile(loadJson(SCHEMA_PATH))
}

async function runProof(boundary, args) {
  const [executable, ...commandArgs] = boundary.command
  const child = spawn(executable, [...commandArgs, ...args], {
    cwd: boundary.cwd,
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

function fixturePath(manifest, fixtureName) {
  return path.resolve(path.dirname(MANIFEST_PATH), manifest.fixtures[fixtureName].path)
}

function currentPathForCase(manifest, caseName) {
  const scenario = manifest.cases[caseName]
  if (scenario.current_fixture) return fixturePath(manifest, scenario.current_fixture)
  return makeDriftCopy(fixturePath(manifest, scenario.base_fixture), scenario.mutation.offset, scenario.mutation.byte)
}

function withoutImplementation(output) {
  const { implementation: _implementation, ...contract } = output
  return contract
}

function makeTempRoot(prefix = 'unbun-exact-replay-cross-') {
  const root = mkdtempSync(path.join(tmpdir(), prefix))
  created.push(root)
  return root
}

describe('exact replay fixture contract', () => {
  test('pins synthetic facts and every required replay case', () => {
    const manifest = loadJson(MANIFEST_PATH)
    expect(manifest).toMatchObject({
      schema: 'unbun.exact-replay.fixtures',
      schema_version: 1,
      feature_contract: 'claude-v1',
      lineage_algorithm: 'claude-v1-exact-replay',
      format: 'synthetic-elf-like',
      executable: false,
      normalized_size: 1031,
      baseline: {
        path: '../../../contract/golden/claude-v1/synthetic-2.1.175-clean.bin',
        size: 1031,
        sha256: CLEAN_SHA256,
      },
    })
    expect(manifest.provenance).toEqual({
      source: expect.any(String),
      audit_basis: expect.any(String),
      frozen_at: '2026-07-23',
    })
    expect(manifest.target_sets).toEqual([
      { request_set: [], closed_set: [], fixture: 'clean' },
      { request_set: ['source-exec'], closed_set: ['source-exec'], fixture: 'target-source-exec' },
      { request_set: ['agent-model'], closed_set: ['agent-model'], fixture: 'target-agent-model' },
      { request_set: ['channels'], closed_set: ['source-exec', 'channels'], fixture: 'target-channels' },
      { request_set: ['source-exec', 'agent-model'], closed_set: ['source-exec', 'agent-model'], fixture: 'target-source-exec-agent-model' },
      { request_set: ['source-exec', 'channels'], closed_set: ['source-exec', 'channels'], fixture: 'target-channels' },
      { request_set: ['agent-model', 'channels'], closed_set: ['source-exec', 'agent-model', 'channels'], fixture: 'target-all' },
      { request_set: ['source-exec', 'agent-model', 'channels'], closed_set: ['source-exec', 'agent-model', 'channels'], fixture: 'target-all' },
    ])
    for (const target of manifest.target_sets) expect(manifest.fixtures[target.fixture]).toBeDefined()

    const requiredCases = [
      'clean',
      'target-source-exec',
      'target-agent-model',
      'target-source-exec-agent-model',
      'target-channels',
      'target-all',
      'mixed-replayable',
      'mixed-unreplayable',
      'same-version-different-build',
      'feature-owned-clean-drift',
    ]
    expect(Object.keys(manifest.cases).sort()).toEqual(requiredCases.sort())
    const agentOnly = readFileSync(fixturePath(manifest, 'target-agent-model'))
    expect(agentOnly.subarray(8, 17).toString('ascii')).toBe('@bytecode')
    expect(agentOnly.subarray(305, 346).toString('ascii')).toBe('Q.string()/* any model ................*/')
    for (const [name, scenario] of Object.entries(manifest.cases)) {
      if (scenario.current_fixture) {
        expect(manifest.fixtures[scenario.current_fixture], `${name} has an unknown current_fixture`).toBeDefined()
        expect(scenario.current_sha256).toBe(manifest.fixtures[scenario.current_fixture].sha256)
      }
    }
    for (const fixture of Object.values(manifest.fixtures)) {
      expect(fixture).toEqual({
        path: expect.any(String),
        size: 1031,
        sha256: expect.stringMatching(HASH_PATTERN),
      })
      const fixturePath = path.resolve(path.dirname(MANIFEST_PATH), fixture.path)
      const bytes = readFileSync(fixturePath)
      expect(bytes).toHaveLength(fixture.size)
      expect(sha256(bytes)).toBe(fixture.sha256)
    }
  })

  test('injects non-feature build drift on a temporary copy and freezes rejection', async () => {
    const sourceBefore = sha256(readFileSync(CLEAN_PATH))
    const manifest = loadJson(MANIFEST_PATH)
    const scenario = manifest.cases['same-version-different-build']
    const currentPath = makeDriftCopy(fixturePath(manifest, scenario.base_fixture), scenario.mutation.offset, scenario.mutation.byte)

    expect(scenario).toMatchObject({
      embedded_version: '2.1.175',
      substates: { 'source-exec': 'clean', 'agent-model': 'clean', channels: 'clean' },
      expected: { supported: true, expected_sha256: CLEAN_SHA256, byte_equal: false, error: 'baseline_stale_build' },
      mutation: { ownership: 'non-feature' },
    })
    expect(sha256(readFileSync(currentPath))).toBe(scenario.current_sha256)
    expect(sha256(readFileSync(currentPath))).not.toBe(CLEAN_SHA256)
    expect(readFileSync(CLEAN_PATH)[scenario.mutation.offset]).toBe(readFileSync(ALL_PATCHED_PATH)[scenario.mutation.offset])
    expect(sha256(readFileSync(CLEAN_PATH))).toBe(sourceBefore)
  })

  test('injects feature-owned clean-byte drift and forbids masked success', async () => {
    const sourceBefore = sha256(readFileSync(CLEAN_PATH))
    const manifest = loadJson(MANIFEST_PATH)
    const scenario = manifest.cases['feature-owned-clean-drift']
    const currentPath = makeDriftCopy(fixturePath(manifest, scenario.base_fixture), scenario.mutation.offset, scenario.mutation.byte)

    expect(scenario).toMatchObject({
      substates: { 'source-exec': 'clean', 'agent-model': 'clean', channels: 'clean' },
      expected: { supported: true, expected_sha256: CLEAN_SHA256, byte_equal: false, error: 'baseline_stale_build' },
      mutation: { offset: 600, ownership: 'channels-decision', clean_byte: expect.any(Number) },
    })
    expect(scenario.mutation.byte).not.toBe(scenario.mutation.clean_byte)
    expect(sha256(readFileSync(currentPath))).toBe(scenario.current_sha256)
    expect(sha256(readFileSync(currentPath))).not.toBe(CLEAN_SHA256)
    expect(readFileSync(CLEAN_PATH)[scenario.mutation.offset]).not.toBe(readFileSync(ALL_PATCHED_PATH)[scenario.mutation.offset])
    expect(sha256(readFileSync(CLEAN_PATH))).toBe(sourceBefore)
  })
})

describe('exact replay result contract', () => {
  test('every manifest expectation forms a schema-valid future result', async () => {
    const validate = await resultValidator()
    const manifest = loadJson(MANIFEST_PATH)
    for (const [name, scenario] of Object.entries(manifest.cases)) {
      const result = {
        implementation: 'js',
        format: manifest.format,
        supported: scenario.expected.supported,
        normalized_size: manifest.normalized_size,
        baseline_lineage_sha256: manifest.baseline.sha256,
        expected_sha256: scenario.expected.expected_sha256,
        current_sha256: scenario.current_sha256,
        byte_equal: scenario.expected.byte_equal,
        error: scenario.expected.error,
      }
      expect(validate(result), JSON.stringify({ name, errors: validate.errors })).toBe(true)
    }
  })

  test('accepts explicit not_implemented results and rejects false-green shapes', async () => {
    const validate = await resultValidator()
    const unsupported = {
      implementation: 'js',
      format: 'synthetic-elf-like',
      supported: false,
      normalized_size: 1031,
      baseline_lineage_sha256: CLEAN_SHA256,
      expected_sha256: null,
      current_sha256: CLEAN_SHA256,
      byte_equal: false,
      error: 'not_implemented',
    }
    expect(validate(unsupported), JSON.stringify(validate.errors)).toBe(true)
    expect(validate({ ...unsupported, supported: true }), JSON.stringify(validate.errors)).toBe(false)
    expect(validate({ ...unsupported, byte_equal: true }), JSON.stringify(validate.errors)).toBe(false)
    expect(validate({ ...unsupported, error: null }), JSON.stringify(validate.errors)).toBe(false)
    const missingField = { ...unsupported }
    delete missingField.current_sha256
    expect(validate(missingField), JSON.stringify(validate.errors)).toBe(false)
  })

  test('both mature PoCs agree on schema, exit, support, equality, error, and every hash for every case', async () => {
    const validate = await resultValidator()
    const manifest = loadJson(MANIFEST_PATH)

    for (const [caseName, scenario] of Object.entries(manifest.cases)) {
      const currentPath = currentPathForCase(manifest, caseName)
      const results = await Promise.all(boundaries.map((boundary) => runProof(boundary, [
        '--manifest', MANIFEST_PATH,
        '--case', caseName,
        '--current', currentPath,
      ])))

      for (const [index, result] of results.entries()) {
        expect(validate(result.output), JSON.stringify({ caseName, implementation: boundaries[index].implementation, errors: validate.errors })).toBe(true)
        expect(result.output.implementation).toBe(boundaries[index].implementation)
        expect(result.output).toMatchObject({
          supported: scenario.expected.supported,
          byte_equal: scenario.expected.byte_equal,
          error: scenario.expected.error,
          expected_sha256: scenario.expected.expected_sha256,
          current_sha256: scenario.current_sha256,
          baseline_lineage_sha256: manifest.baseline.sha256,
        })
      }
      expect(results[0].exitCode, caseName).toBe(results[1].exitCode)
      expect(withoutImplementation(results[0].output), caseName).toEqual(withoutImplementation(results[1].output))
    }
  })

  test('each successful replay writes bytes that the other PoC verifies byte-for-byte', async () => {
    const validate = await resultValidator()
    const manifest = loadJson(MANIFEST_PATH)
    const successfulCases = Object.entries(manifest.cases).filter(([, scenario]) => scenario.expected.byte_equal)

    for (const [caseName, scenario] of successfulCases) {
      const sourceBytes = readFileSync(fixturePath(manifest, scenario.current_fixture))
      for (const [producer, verifier] of [[boundaries[0], boundaries[1]], [boundaries[1], boundaries[0]]]) {
        const root = makeTempRoot()
        const expectedPath = path.join(root, `${caseName}-${producer.implementation}.bin`)
        const produced = await runProof(producer, [
          '--manifest', MANIFEST_PATH,
          '--case', caseName,
          '--current', fixturePath(manifest, scenario.current_fixture),
          '--write-expected', expectedPath,
        ])

        expect(produced.exitCode, `${caseName}:${producer.implementation}`).toBe(0)
        expect(validate(produced.output), JSON.stringify(validate.errors)).toBe(true)
        expect(existsSync(expectedPath)).toBe(true)
        const expectedBytes = readFileSync(expectedPath)
        expect(expectedBytes.equals(sourceBytes), `${caseName}:${producer.implementation} bytes`).toBe(true)
        expect(sha256(expectedBytes)).toBe(produced.output.expected_sha256)

        const verified = await runProof(verifier, [
          '--manifest', MANIFEST_PATH,
          '--case', caseName,
          '--current', expectedPath,
        ])
        expect(verified.exitCode, `${caseName}:${verifier.implementation}`).toBe(0)
        expect(validate(verified.output), JSON.stringify(validate.errors)).toBe(true)
        expect(verified.output.byte_equal).toBe(true)
        expect(readFileSync(expectedPath).equals(sourceBytes), `${caseName}:${verifier.implementation} preserved bytes`).toBe(true)
        expect(withoutImplementation(verified.output)).toEqual(withoutImplementation(produced.output))
      }
    }
  })
})