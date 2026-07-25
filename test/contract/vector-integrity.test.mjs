import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { classifyAgentModel } from '../../archive/generation-one-patch/patch-agent-model.mjs'
import { backupPath, runPatch, runRevert } from '../../archive/generation-one-patch/patch-binary.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const VECTOR_ROOT = join(ROOT, 'contract', 'vectors')
const GOLDEN_ROOT = join(ROOT, 'contract', 'golden')
const REQUIRED_MANIFESTS = [
  'feature-claude-v1',
  'store-v1',
  'lineage-v1',
  'known-bad-v1',
]
const REQUIRED_COVERAGE = {
  'feature-claude-v1': [
    'source-exec:first-tail-multi-tag',
    'source-exec:32mb-boundary',
    'source-exec:overlapping-windows',
    'source-exec:clean',
    'source-exec:patched',
    'source-exec:mixed',
    'source-exec:unsupported',
    'agent-model:receiver-e',
    'agent-model:receiver-s',
    'agent-model:receiver-a',
    'agent-model:receiver-q',
    'agent-model:unknown-enum-unsupported',
    'agent-model:multiple-describe-suffixes',
    'channels:decision-clean',
    'channels:decision-patched',
    'channels:tail-register-decoy',
    'channels:multiple-decoys',
    'channels:essential-feature-flag-missing',
    'channels:permissions-absent',
    'channels:cap-strip-absent',
    'channels:best-effort-clean',
    'channels:best-effort-patched',
    'channels:best-effort-mixed',
    'dependency:empty',
    'dependency:source-exec',
    'dependency:agent-model',
    'dependency:channels',
    'dependency:source-exec-agent-model',
    'dependency:source-exec-channels',
    'dependency:agent-model-channels',
    'dependency:all',
    'dependency:allow-remove-source-exec-with-agent-model',
    'dependency:reject-remove-source-exec',
  ],
  'store-v1': [
    'store:valid-manifests',
    'store:missing-field',
    'store:wrong-type',
    'store:higher-version',
    'store:path-traversal',
    'store:hash-mismatch',
    'store:size-mismatch',
    'store:version-mismatch',
    'store:state-mismatch',
    'store:orphan-blob',
    'store:manifest-only',
    'store:temp-only',
    'store:lock-contention',
    'store:stale-lock-unknown-owner',
    'store:snapshot-ambiguity',
    'store:force-activation',
  ],
  'lineage-v1': [
    'lineage:clean',
    'lineage:target-empty',
    'lineage:target-source-exec',
    'lineage:target-agent-model',
    'lineage:target-channels',
    'lineage:target-source-exec-agent-model',
    'lineage:target-source-exec-channels',
    'lineage:target-all',
    'lineage:mixed-replayable',
    'lineage:mixed-unreplayable',
    'lineage:same-path-version-different-build',
  ],
  'known-bad-v1': [
    'known-bad:hardcoded-e',
    'known-bad:incorrect-agent-source-dependency',
    'known-bad:channels-revert-erases-agent-model',
    'known-bad:adjacent-bak',
    'known-bad:collapsed-error-exit',
  ],
}

const created = []
afterEach(() => {
  for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true })
  process.exitCode = 0
})

function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

function loadManifest(name) {
  const path = join(VECTOR_ROOT, name, 'manifest.json')
  expect(existsSync(path), `missing ${path}`).toBe(true)
  return { path, value: JSON.parse(readFileSync(path, 'utf8')) }
}

function resolveFixture(manifestPath, relativePath) {
  expect(relativePath).toMatch(/^(?:fixtures\/[A-Za-z0-9._/-]+|\.\.\/\.\.\/golden\/claude-v1\/[A-Za-z0-9._-]+)$/)
  if (relativePath.startsWith('fixtures/')) expect(relativePath.split('/')).not.toContain('..')
  const path = resolve(dirname(manifestPath), relativePath)
  const allowedRoots = [resolve(dirname(manifestPath), 'fixtures'), resolve(GOLDEN_ROOT, 'claude-v1')]
  expect(allowedRoots.some((root) => path === root || path.startsWith(root + sep))).toBe(true)
  return path
}

function assertPinnedFile(manifestPath, file) {
  expect(file).toEqual({
    path: expect.any(String),
    size: expect.any(Number),
    sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
  })
  const path = resolveFixture(manifestPath, file.path)
  expect(existsSync(path), `missing fixture ${path}`).toBe(true)
  const bytes = readFileSync(path)
  expect(statSync(path).size).toBe(file.size)
  expect(sha256(bytes)).toBe(file.sha256)
}

describe('frozen vector manifests', () => {
  for (const name of REQUIRED_MANIFESTS) {
    test(`${name} pins every fixture and expected result`, () => {
      const { path, value } = loadManifest(name)
      expect(value.schema).toBe(`unbun.cc.vectors.${name}`)
      expect(value.schema_version).toBe(1)
      expect(value.feature_contract).toBe('claude-v1')
      expect(value.provenance).toEqual({
        source: expect.any(String),
        audit_basis: expect.any(String),
        frozen_at: expect.stringMatching(/^2026-07-23$/),
      })
      expect(value.vectors.length).toBeGreaterThan(0)

      const coverage = new Set()
      const referencedFixtures = new Set()
      for (const vector of value.vectors) {
        expect(vector.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
        expect(vector.source).toEqual({ description: expect.any(String), audit_basis: expect.any(String) })
        expect(['clean', 'patched', 'mixed', 'unsupported', 'store', 'lineage', 'known-bad']).toContain(vector.input_state)
        expect(vector.expected_substates).toBeDefined()
        expect(vector.expected_output_sha256).toMatch(/^[0-9a-f]{64}$/)
        expect(vector.expected_code === null || typeof vector.expected_code === 'string').toBe(true)
        expect(Number.isInteger(vector.expected_exit)).toBe(true)
        expect(vector.coverage.length).toBeGreaterThan(0)
        for (const token of vector.coverage) coverage.add(token)
        expect(vector.files.some((file) => file.sha256 === vector.expected_output_sha256)).toBe(true)
        for (const file of vector.files) {
          assertPinnedFile(path, file)
          if (file.path.startsWith('fixtures/')) referencedFixtures.add(file.path.slice('fixtures/'.length))
        }
      }

      for (const token of REQUIRED_COVERAGE[name]) {
        expect(coverage.has(token), `${name} lacks coverage ${token}`).toBe(true)
      }
      expect([...referencedFixtures].sort()).toEqual(readdirSync(join(dirname(path), 'fixtures')).sort())
    })
  }
})

test('golden checksum inventory is complete and self-consistent', () => {
  const sumsPath = join(GOLDEN_ROOT, 'SHA256SUMS')
  const readmePath = join(GOLDEN_ROOT, 'README.md')
  expect(existsSync(readmePath)).toBe(true)
  expect(existsSync(sumsPath)).toBe(true)
  const lines = readFileSync(sumsPath, 'utf8').trim().split('\n')
  expect(lines.length).toBeGreaterThanOrEqual(2)
  const checksummed = []
  for (const line of lines) {
    const match = line.match(/^([0-9a-f]{64})  (contract\/golden\/claude-v1\/[A-Za-z0-9._-]+)$/)
    expect(match).not.toBeNull()
    const path = join(ROOT, match[2])
    checksummed.push(match[2].slice('contract/golden/claude-v1/'.length))
    expect(existsSync(path)).toBe(true)
    expect(sha256(readFileSync(path))).toBe(match[1])
  }
  expect(checksummed.sort()).toEqual(readdirSync(join(GOLDEN_ROOT, 'claude-v1')).sort())
  const readme = readFileSync(readmePath, 'utf8')
  expect(readme).toContain('/home/xp/.claude/scripts/cc-patch/tests/golden')
  expect(readme).toContain('1031 bytes')
  expect(readme).toContain('人工审计依据')
})

test('known-bad vectors are executable positive controls against generation-one JS', async () => {
  const { value } = loadManifest('known-bad-v1')
  expect(value.vectors).toHaveLength(5)
  for (const vector of value.vectors) {
    expect(vector.expected_failure).toBe(true)
    expect(vector.assertion).toEqual({
      kind: expect.any(String),
      expected: expect.anything(),
      observed_generation_one: expect.anything(),
    })
  }

  const byId = Object.fromEntries(value.vectors.map((vector) => [vector.id, vector]))
  const receiverFixture = readFileSync(resolveFixture(join(VECTOR_ROOT, 'known-bad-v1', 'manifest.json'), byId['hardcoded-e'].files[0].path))
  expect(classifyAgentModel(receiverFixture).status).toBe(byId['hardcoded-e'].assertion.observed_generation_one)

  const dependencyVector = JSON.parse(readFileSync(resolveFixture(join(VECTOR_ROOT, 'known-bad-v1', 'manifest.json'), byId['incorrect-agent-source-dependency'].files[0].path), 'utf8'))
  const selected = new Set()
  const add = (feature) => {
    for (const dependency of dependencyVector.requires[feature]) add(dependency)
    selected.add(feature)
  }
  for (const feature of dependencyVector.request_set) add(feature)
  const generationOneClosure = dependencyVector.registry_order.filter((feature) => selected.has(feature))
  expect(generationOneClosure).toEqual(byId['incorrect-agent-source-dependency'].assertion.observed_generation_one)
  expect(generationOneClosure).not.toEqual(byId['incorrect-agent-source-dependency'].assertion.expected)

  const temp = mkdtempSync(join(tmpdir(), 'unbun-known-bad-'))
  created.push(temp)
  const binary = join(temp, 'claude')
  const binaryFixture = readFileSync(resolveFixture(join(VECTOR_ROOT, 'known-bad-v1', 'manifest.json'), byId['channels-revert-erases-agent-model'].files[0].path))
  writeFileSync(binary, binaryFixture)
  runPatch({ binary, feature: 'channels', log: () => {} })
  runPatch({ binary, feature: 'agent-model', log: () => {} })
  runRevert({ binary, feature: 'channels', log: () => {} })
  expect(readFileSync(binary).toString('latin1')).not.toContain(byId['channels-revert-erases-agent-model'].assertion.expected)
  expect(existsSync(backupPath(binary))).toBe(byId['adjacent-bak'].assertion.observed_generation_one)

  const invalidBinary = join(temp, 'claude-missing-essential')
  const invalidFixture = readFileSync(resolveFixture(join(VECTOR_ROOT, 'known-bad-v1', 'manifest.json'), byId['collapsed-error-exit'].files[0].path))
  writeFileSync(invalidBinary, invalidFixture)
  let generationOneExit = 0
  try {
    runPatch({ binary: invalidBinary, feature: 'channels', log: () => {} })
  } catch {
    generationOneExit = 1
  }
  expect(generationOneExit).toBe(byId['collapsed-error-exit'].assertion.observed_generation_one)
})