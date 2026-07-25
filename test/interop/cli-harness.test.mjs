import { afterEach, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  CONTRACT_RUNNER_BOUNDARIES,
  PUBLIC_CLI_BOUNDARIES,
  classifyInterop,
  runCli,
  runInteropScenario,
} from './cli-harness.mjs'
import { normalizeOutput } from './normalize-output.mjs'

const ROOT = path.resolve(import.meta.dir, '../..')
const VECTOR_ROOT = path.join(ROOT, 'contract', 'vectors')
const JS_RUNNER = path.join(ROOT, 'test', 'contract', 'js-vector-runner.mjs')
const PYTHON_RUNNER = path.join(ROOT, 'test', 'contract', 'python-vector-runner.py')

const created = []

afterEach(() => {
  for (const target of created.splice(0)) rmSync(target, { force: true, recursive: true })
})

function makeFakeBoundary(root, implementation) {
  const scriptPath = path.join(root, `fake-${implementation}.mjs`)
  writeFileSync(scriptPath, `
import { readFileSync, writeFileSync } from 'node:fs'
const [action, artifactPath] = process.argv.slice(2)
const observation = {
  implementation: process.env.FAKE_IMPLEMENTATION,
  path: artifactPath,
  created_at: new Date().toISOString(),
  pid: process.pid,
  hostname: 'ephemeral-host',
  code: 'agent_model_variant_unsupported',
  hash: 'a'.repeat(64),
  sites: [7, 19],
}
if (action === 'write') {
  observation.producer = process.env.FAKE_IMPLEMENTATION
  writeFileSync(artifactPath, JSON.stringify(observation))
}
if (action === 'read') {
  const stored = JSON.parse(readFileSync(artifactPath, 'utf8'))
  Object.assign(observation, stored, {
    implementation: process.env.FAKE_IMPLEMENTATION,
    consumer: process.env.FAKE_IMPLEMENTATION,
  })
}
process.stdout.write(JSON.stringify(observation) + '\\n')
`)
  return {
    id: `${implementation}-fake-cli`,
    implementation,
    maturity: 'test-fake',
    availability: 'available',
    role: 'test-fake',
    command: ['bun', scriptPath],
    cwd: root,
    env: { FAKE_IMPLEMENTATION: implementation },
  }
}

test('runCli can remove an inherited environment variable', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'unbun-cli-unset-env-'))
  created.push(root)
  const scriptPath = path.join(root, 'environment.mjs')
  writeFileSync(scriptPath, `process.stdout.write(JSON.stringify({ value: process.env.UNBUN_CC_STORE ?? null }) + '\\n')\n`)
  const boundary = {
    id: 'environment-fake-cli',
    implementation: 'js',
    maturity: 'test-fake',
    availability: 'available',
    role: 'test-fake',
    command: ['bun', scriptPath],
    cwd: root,
  }

  const result = await runCli(boundary, {
    env: { UNBUN_CC_STORE: '/inherited/store' },
    unsetEnv: ['UNBUN_CC_STORE'],
  })

  expect(result.exitCode).toBe(0)
  expect(result.output).toEqual({ value: null })
})

test('harness identifies a JS write followed by a Python read', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'unbun-cli-harness-'))
  created.push(root)
  const writer = makeFakeBoundary(root, 'js')
  const reader = makeFakeBoundary(root, 'python')
  const result = await runInteropScenario({
    writer,
    reader,
    artifactPath: path.join(root, 'artifact.json'),
    normalize: { tempRoots: [root] },
  })

  expect(result.mode).toBe('js-write-python-read')
  expect(result.writer.boundary).toEqual({
    id: 'js-fake-cli',
    implementation: 'js',
    maturity: 'test-fake',
    availability: 'available',
    role: 'test-fake',
  })
  expect(result.reader.boundary).toEqual({
    id: 'python-fake-cli',
    implementation: 'python',
    maturity: 'test-fake',
    availability: 'available',
    role: 'test-fake',
  })
  expect(result.writer.output).toMatchObject({
    implementation: '<implementation>',
    producer: 'js',
    path: '<temp>/artifact.json',
  })
  expect(result.reader.output).toMatchObject({
    implementation: '<implementation>',
    producer: 'js',
    consumer: 'python',
    path: '<temp>/artifact.json',
  })
})

test('normalization replaces only approved dynamic fields', () => {
  const root = path.join(tmpdir(), 'normalization-positive-control')
  const stable = {
    code: 'agent_model_variant_unsupported',
    exit: 1,
    hash: 'b'.repeat(64),
    sites: [11, 29],
    state: 'unsupported',
    manifest: {
      schema: 'unbun.cc.baseline',
      sha256: 'c'.repeat(64),
      states: { 'source-exec': 'clean', 'agent-model': 'unsupported' },
    },
  }
  const normalized = normalizeOutput({
    ...stable,
    implementation: 'python',
    hostname: 'transient-host',
    pid: 43210,
    created_at: '2026-07-23T12:34:56.000Z',
    path: path.join(root, 'binary'),
  }, { tempRoots: [root] })

  expect(normalized).toEqual({
    ...stable,
    implementation: '<implementation>',
    hostname: '<hostname>',
    pid: '<pid>',
    created_at: '<timestamp>',
    path: '<temp>/binary',
  })
})

test('available public CLI boundaries remain distinct from contract prototypes', () => {
  expect(PUBLIC_CLI_BOUNDARIES.javascript).toMatchObject({
    id: 'unbun-cc',
    implementation: 'js',
    maturity: 'public-contract',
    availability: 'available',
    role: 'public-entrypoint',
    command: ['bun', 'cli.mjs', 'cc'],
  })
  expect(PUBLIC_CLI_BOUNDARIES.python).toMatchObject({
    id: 'ccpatch',
    implementation: 'python',
    maturity: 'public-contract',
    availability: 'available',
    role: 'public-entrypoint',
    command: ['uv', 'run', '--directory', 'python/cc-patch', 'ccpatch'],
  })
  expect(classifyInterop(PUBLIC_CLI_BOUNDARIES.javascript, PUBLIC_CLI_BOUNDARIES.javascript)).toBe('same-implementation-write-read')
})

function runnerBoundary(implementation) {
  return implementation === 'js'
    ? CONTRACT_RUNNER_BOUNDARIES.javascript
    : CONTRACT_RUNNER_BOUNDARIES.python
}

async function runVector(implementation, vectorPath) {
  return runCli(runnerBoundary(implementation), {
    stdin: `${vectorPath}\n`,
  })
}

test('JS and Python runners independently derive dependency closures', async () => {
  const vectorPath = path.join(VECTOR_ROOT, 'feature-claude-v1', 'fixtures', 'dependency-input.json')
  const expectedPath = path.join(VECTOR_ROOT, 'feature-claude-v1', 'fixtures', 'dependency-expected.json')
  const expected = JSON.parse(readFileSync(expectedPath, 'utf8'))
  const [javascript, python] = await Promise.all([
    runVector('js', vectorPath),
    runVector('python', vectorPath),
  ])

  expect(javascript.exitCode).toBe(0)
  expect(python.exitCode).toBe(0)
  expect(javascript.output).toEqual(python.output)
  expect(javascript.output.request_sets.map(({ closed_set }) => closed_set)).toEqual(expected.closures)
  expect(javascript.output.request_sets).toContainEqual({
    request_set: ['agent-model', 'channels'],
    closed_set: ['source-exec', 'agent-model', 'channels'],
  })
  expect(expected.remove_source_exec_while_agent_model_enabled).toEqual({ allowed: true, code: null, exit: 0 })
  expect(expected.remove_source_exec_while_channels_enabled).toEqual({ allowed: false, code: 'feature_dependency_conflict', exit: 1 })
})

test('lineage targets expose request_set and fixed-graph closed_set', async () => {
  const vectorPath = path.join(VECTOR_ROOT, 'lineage-v1', 'fixtures', 'lineage-cases.json')
  const [javascript, python] = await Promise.all([
    runVector('js', vectorPath),
    runVector('python', vectorPath),
  ])

  expect(javascript.output).toEqual(python.output)
  expect(javascript.output.kind).toBe('lineage-targets')
  expect(javascript.output.targets).toEqual([
    { request_set: [], closed_set: [] },
    { request_set: ['source-exec'], closed_set: ['source-exec'] },
    { request_set: ['agent-model'], closed_set: ['agent-model'] },
    { request_set: ['channels'], closed_set: ['source-exec', 'channels'] },
    { request_set: ['source-exec', 'agent-model'], closed_set: ['source-exec', 'agent-model'] },
    { request_set: ['source-exec', 'channels'], closed_set: ['source-exec', 'channels'] },
    { request_set: ['source-exec', 'agent-model', 'channels'], closed_set: ['source-exec', 'agent-model', 'channels'] },
  ])
})

test('feature conformance codes, hashes, and sites survive runner output', async () => {
  const manifestPath = path.join(VECTOR_ROOT, 'feature-claude-v1', 'manifest.json')
  const expectedPath = path.join(VECTOR_ROOT, 'feature-claude-v1', 'fixtures', 'agent-model-expected.json')
  const [manifestResult, expectedResult] = await Promise.all([
    runVector('python', manifestPath),
    runVector('python', expectedPath),
  ])
  const agentVector = manifestResult.output.document.vectors.find(({ id }) => id === 'agent-model-corpus')

  expect(agentVector.expected_code).toBe('agent_model_variant_unsupported')
  expect(agentVector.expected_output_sha256).toBe('68099ecb0069f7d1c3a56e7aaf188cdf41e5939661feff6c5c7a31ec46997b49')
  expect(expectedResult.output.document.variants['multiple-suffixes'].sites).toBe(2)
})

test('runner source does not import or execute the other implementation', () => {
  const javascript = readFileSync(JS_RUNNER, 'utf8')
  const python = readFileSync(PYTHON_RUNNER, 'utf8')

  expect(javascript).not.toContain('python-vector-runner')
  expect(javascript).not.toContain('python3')
  expect(python).not.toContain('js-vector-runner')
  expect(python).not.toContain('subprocess')
  expect(python).not.toContain('os.system')
})

async function runRaw(command, stdin) {
  const [executable, ...args] = command
  const child = spawn(executable, args, {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const stdout = []
  const stderr = []
  child.stdout.on('data', (chunk) => stdout.push(chunk))
  child.stderr.on('data', (chunk) => stderr.push(chunk))
  child.stdin.end(stdin)
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  return {
    exitCode,
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'),
  }
}

test('runner failures reserve stdout for JSON and send diagnostics to stderr', async () => {
  const missingPath = path.join(ROOT, 'contract', 'vectors', 'does-not-exist.json')
  const [javascript, python] = await Promise.all([
    runRaw(CONTRACT_RUNNER_BOUNDARIES.javascript.command, `${missingPath}\n`),
    runRaw(CONTRACT_RUNNER_BOUNDARIES.python.command, `${missingPath}\n`),
  ])

  expect(javascript.exitCode).toBe(1)
  expect(javascript.stdout).toBe('')
  expect(javascript.stderr).toContain('js-vector-runner:')
  expect(python.exitCode).toBe(1)
  expect(python.stdout).toBe('')
  expect(python.stderr).toContain('python-vector-runner:')
})

test('runners symmetrically reject a non-object vector root', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'unbun-vector-root-'))
  created.push(root)
  const vectorPath = path.join(root, 'array.json')
  writeFileSync(vectorPath, '[]\n')
  const [javascript, python] = await Promise.all([
    runRaw(CONTRACT_RUNNER_BOUNDARIES.javascript.command, `${vectorPath}\n`),
    runRaw(CONTRACT_RUNNER_BOUNDARIES.python.command, `${vectorPath}\n`),
  ])

  expect(javascript.exitCode).toBe(1)
  expect(javascript.stdout).toBe('')
  expect(javascript.stderr).toContain('vector root must be an object')
  expect(python.exitCode).toBe(1)
  expect(python.stdout).toBe('')
  expect(python.stderr).toContain('vector root must be an object')
})