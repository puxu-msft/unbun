import { afterEach, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { SYNTHETIC_SITES, evaluateCase, normalizePe, replaySynthetic } from './replay-proof.mjs'

const EXP_ROOT = path.resolve(import.meta.dir, '..')
const ROOT = path.resolve(EXP_ROOT, '../..')
const MANIFEST_PATH = path.join(EXP_ROOT, 'fixtures', 'manifest.json')
const PE_MANIFEST_PATH = path.join(EXP_ROOT, 'fixtures', 'pe', 'manifest.json')
const PROOF_PATH = path.join(import.meta.dir, 'replay-proof.mjs')
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
const peManifest = JSON.parse(readFileSync(PE_MANIFEST_PATH, 'utf8'))
const created = []

afterEach(() => {
  for (const target of created.splice(0)) rmSync(target, { recursive: true, force: true })
})

function fixturePath(name) {
  return path.resolve(path.dirname(MANIFEST_PATH), manifest.fixtures[name].path)
}

function peFixturePath(name) {
  return path.resolve(path.dirname(PE_MANIFEST_PATH), peManifest.fixtures[name].path)
}

function temporaryCopy(sourcePath = fixturePath('clean')) {
  const root = mkdtempSync(path.join(tmpdir(), 'unbun-js-replay-'))
  created.push(root)
  const target = path.join(root, 'current.bin')
  copyFileSync(sourcePath, target)
  return target
}

async function runProof(caseName, currentPath, manifestPath = MANIFEST_PATH, writeExpected) {
  const args = [
    PROOF_PATH,
    '--manifest', manifestPath,
    '--case', caseName,
    '--current', currentPath,
  ]
  if (writeExpected) args.push('--write-expected', writeExpected)
  const child = spawn('bun', [
    ...args,
  ], {
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

function writeManifest(mutator) {
  const root = mkdtempSync(path.join(tmpdir(), 'unbun-js-replay-manifest-'))
  created.push(root)
  const manifestPath = path.join(root, 'manifest.json')
  const changed = structuredClone(manifest)
  mutator(changed)
  writeFileSync(manifestPath, `${JSON.stringify(changed, null, 2)}\n`)
  return manifestPath
}

describe('JavaScript synthetic exact replay CLI', () => {
  for (const { request_set: requestSet, fixture } of manifest.target_sets) {
    test(`replays target closure for ${requestSet.join('+') || 'clean'} exactly`, async () => {
      const caseName = fixture
      const scenario = manifest.cases[caseName]
      const currentPath = fixturePath(scenario.current_fixture)
      const result = await runProof(caseName, currentPath)

      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe('')
      expect(result.output).toEqual({
        implementation: 'js',
        format: 'synthetic-elf-like',
        supported: true,
        normalized_size: manifest.normalized_size,
        baseline_lineage_sha256: manifest.baseline.sha256,
        expected_sha256: scenario.expected.expected_sha256,
        current_sha256: scenario.current_sha256,
        byte_equal: true,
        error: null,
      })
    })
  }

  test('replays complete mixed substates exactly', async () => {
    const caseName = 'mixed-replayable'
    const scenario = manifest.cases[caseName]
    const result = await runProof(caseName, fixturePath(scenario.current_fixture))

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.output).toMatchObject({
      supported: true,
      expected_sha256: scenario.expected.expected_sha256,
      current_sha256: scenario.current_sha256,
      byte_equal: true,
      error: null,
    })
  })

  test('writes exact expected bytes without adding stdout records', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'unbun-js-replay-output-'))
    created.push(root)
    const expectedPath = path.join(root, 'expected.bin')
    const result = await runProof('target-all', fixturePath('target-all'), MANIFEST_PATH, expectedPath)

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(readFileSync(expectedPath).equals(readFileSync(fixturePath('target-all')))).toBe(true)
    expect(result.output.expected_sha256).toBe(manifest.cases['target-all'].expected.expected_sha256)
  })

  test('does not write expected bytes for a rejected case', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'unbun-js-replay-output-'))
    created.push(root)
    const expectedPath = path.join(root, 'expected.bin')
    const result = await runProof('mixed-unreplayable', fixturePath('mixed-unreplayable'), MANIFEST_PATH, expectedPath)

    expect(result.exitCode).toBe(3)
    expect(existsSync(expectedPath)).toBe(false)
  })

  test('rejects an incomplete mixed substate vector', async () => {
    const scenario = manifest.cases['mixed-unreplayable']
    const result = await runProof('mixed-unreplayable', fixturePath(scenario.current_fixture))

    expect(result.exitCode).toBe(3)
    expect(result.stderr).toContain('agent-model')
    expect(result.output).toMatchObject({
      supported: false,
      expected_sha256: null,
      byte_equal: false,
      error: 'substate_unreplayable',
    })
  })

  for (const caseName of ['same-version-different-build', 'feature-owned-clean-drift']) {
    test(`rejects ${caseName} after full replay`, async () => {
      const scenario = manifest.cases[caseName]
      const currentPath = temporaryCopy()
      const current = readFileSync(currentPath)
      current[scenario.mutation.offset] = scenario.mutation.byte
      writeFileSync(currentPath, current)
      const result = await runProof(caseName, currentPath)

      expect(result.exitCode).toBe(4)
      expect(result.stderr).toContain('full byte comparison failed')
      expect(result.output).toMatchObject({
        supported: true,
        expected_sha256: scenario.expected.expected_sha256,
        current_sha256: scenario.current_sha256,
        byte_equal: false,
        error: 'baseline_stale_build',
      })
    })
  }

  test('full byte comparison remains load-bearing when reported hashes match', () => {
    const current = readFileSync(fixturePath('clean'))
    const replayWithMiddleByteDrift = (...args) => {
      const expected = replaySynthetic(...args)
      expected[511] ^= 0xff
      return expected
    }
    const matchingHash = () => manifest.baseline.sha256
    const [result, exitCode] = evaluateCase(
      manifest,
      'clean',
      current,
      MANIFEST_PATH,
      SYNTHETIC_SITES,
      { replay: replayWithMiddleByteDrift, digest: matchingHash },
    )

    expect(manifest.cases.clean.expected.expected_sha256).toBe(manifest.cases.clean.current_sha256)
    expect(exitCode).toBe(4)
    expect(result.expected_sha256).toBe(result.current_sha256)
    expect(result.byte_equal).toBe(false)
    expect(result.error).toBe('baseline_stale_build')
  })

  test('rejects a baseline whose non-site bytes do not match its pinned hash', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'unbun-js-replay-baseline-'))
    created.push(root)
    const baselinePath = path.join(root, 'baseline.bin')
    const changed = structuredClone(manifest)
    const baseline = readFileSync(fixturePath('clean'))
    baseline[30] ^= 1
    writeFileSync(baselinePath, baseline)
    changed.baseline.path = 'baseline.bin'

    expect(() => evaluateCase(changed, 'clean', readFileSync(fixturePath('clean')), path.join(root, 'manifest.json'))).toThrow('frozen baseline does not match manifest size and sha256')
  })

  test('rejects a normalized size mismatch before success', async () => {
    const currentPath = temporaryCopy()
    writeFileSync(currentPath, Buffer.concat([readFileSync(currentPath), Buffer.from([0])]))
    const result = await runProof('clean', currentPath)

    expect(result.exitCode).toBe(4)
    expect(result.stderr).toContain('full byte comparison failed')
    expect(result.output).toMatchObject({
      supported: true,
      normalized_size: manifest.normalized_size + 1,
      byte_equal: false,
      error: 'baseline_stale_build',
    })
  })

  test('rejects unsupported formats without attempting replay', async () => {
    const manifestPath = writeManifest((changed) => {
      changed.format = 'pe'
    })
    const result = await runProof('clean', fixturePath('clean'), manifestPath)

    expect(result.exitCode).toBe(3)
    expect(result.output).toMatchObject({ supported: false, error: 'unsupported_format' })
  })
})

describe('JavaScript synthetic replay validation', () => {
  test('rejects a missing site', () => {
    const sites = structuredClone(SYNTHETIC_SITES)
    sites.channels.splice(1, 1)
    const [result, exitCode, diagnostic] = evaluateCase(manifest, 'target-channels', readFileSync(fixturePath('target-channels')), MANIFEST_PATH, sites)

    expect(exitCode).toBe(3)
    expect(diagnostic).toContain('missing site')
    expect(result).toMatchObject({ supported: false, expected_sha256: null, byte_equal: false, error: 'substate_unreplayable' })
  })

  test('rejects a site outside the normalized binary', () => {
    const sites = structuredClone(SYNTHETIC_SITES)
    sites['source-exec'][0].offset = manifest.normalized_size
    const [result, exitCode, diagnostic] = evaluateCase(manifest, 'target-source-exec', readFileSync(fixturePath('target-source-exec')), MANIFEST_PATH, sites)

    expect(exitCode).toBe(3)
    expect(diagnostic).toContain('out of bounds')
    expect(result).toMatchObject({ supported: false, expected_sha256: null, byte_equal: false, error: 'substate_unreplayable' })
  })

  test('rejects an unknown top-level state', () => {
    const changed = structuredClone(manifest)
    changed.cases.clean.substates['agent-model'] = 'partly-patched'
    const [result, exitCode, diagnostic] = evaluateCase(changed, 'clean', readFileSync(fixturePath('clean')), MANIFEST_PATH)

    expect(exitCode).toBe(3)
    expect(diagnostic).toContain('unknown state')
    expect(result).toMatchObject({ supported: false, expected_sha256: null, byte_equal: false, error: 'substate_unreplayable' })
  })

  test('rejects an unknown nested state', () => {
    const changed = structuredClone(manifest)
    changed.cases['mixed-replayable'].substates.channels.permissions = 'partly-patched'
    const [result, exitCode, diagnostic] = evaluateCase(changed, 'mixed-replayable', readFileSync(fixturePath('mixed-replayable')), MANIFEST_PATH)

    expect(exitCode).toBe(3)
    expect(diagnostic).toContain('unknown state')
    expect(result).toMatchObject({ supported: false, expected_sha256: null, byte_equal: false, error: 'substate_unreplayable' })
  })

  test('rejects an unknown nested site', () => {
    const changed = structuredClone(manifest)
    changed.cases['mixed-replayable'].substates.channels.typo_key = 'patched'
    const [result, exitCode, diagnostic] = evaluateCase(changed, 'mixed-replayable', readFileSync(fixturePath('mixed-replayable')), MANIFEST_PATH)

    expect(exitCode).toBe(3)
    expect(diagnostic).toContain('unknown site')
    expect(result).toMatchObject({ supported: false, expected_sha256: null, byte_equal: false, error: 'substate_unreplayable' })
  })

  test('rejects an unknown top-level feature', () => {
    const changed = structuredClone(manifest)
    changed.cases.clean.substates['bogus-feature'] = 'clean'
    const [result, exitCode, diagnostic] = evaluateCase(changed, 'clean', readFileSync(fixturePath('clean')), MANIFEST_PATH)

    expect(exitCode).toBe(3)
    expect(diagnostic).toContain('unknown feature')
    expect(result).toMatchObject({ supported: false, expected_sha256: null, byte_equal: false, error: 'substate_unreplayable' })
  })
})

describe('JavaScript PE format dispatch', () => {
  test('validates PE32+ structure and preserves every byte for identity normalization', () => {
    const clean = readFileSync(peFixturePath('clean'))

    expect(normalizePe(clean)).toBe(clean)
    expect(normalizePe(clean).equals(clean)).toBe(true)
  })

  test.each([
    ['DOS magic', (bytes) => bytes.fill(0, 0, 2)],
    ['PE magic', (bytes) => bytes.fill(0, 0x80, 0x84)],
    ['truncated PE header', (bytes) => bytes.subarray(0, 0x90)],
    ['contradictory optional header', (bytes) => { bytes.writeUInt16LE(0x10b, 0x98); return bytes }],
  ])('rejects %s before replay', (_name, mutate) => {
    const invalid = mutate(Buffer.from(readFileSync(peFixturePath('clean'))))
    expect(() => normalizePe(invalid)).toThrow('PE')
  })

  test('dispatches a valid PE manifest through the CLI', async () => {
    const result = await runProof('clean', peFixturePath('clean'), PE_MANIFEST_PATH)

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.output).toMatchObject({
      implementation: 'js',
      format: 'pe',
      supported: true,
      normalized_size: peManifest.normalized_size,
      byte_equal: true,
      error: null,
    })
  })
})