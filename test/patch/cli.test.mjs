import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import Ajv2020 from 'ajv/dist/2020.js'
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

const repositoryRoot = path.resolve(import.meta.dir, '../..')
const cli = path.join(repositoryRoot, 'cli.mjs')
const golden = path.join(repositoryRoot, 'contract/golden/claude-v1/synthetic-2.1.175-clean.bin')
const statusSchema = JSON.parse(await readFile(path.join(repositoryRoot, 'contract/schemas/status.schema.json'), 'utf8'))
const errorSchema = JSON.parse(await readFile(path.join(repositoryRoot, 'contract/schemas/error.schema.json'), 'utf8'))
const writeEnvelopeSchema = JSON.parse(await readFile(path.join(repositoryRoot, 'contract/schemas/write-envelope.schema.json'), 'utf8'))
const ajv = new Ajv2020({ strict: true }).addSchema(errorSchema)
const validateStatus = ajv.compile(statusSchema)
const validateWriteEnvelope = ajv.compile(writeEnvelopeSchema)

let root
let binary
let store

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'unbun-cc-cli-'))
  binary = path.join(root, 'claude')
  store = path.join(root, 'store')
  await cp(golden, binary)
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

async function run(args) {
  const child = Bun.spawn(['bun', cli, 'cc', ...args], {
    cwd: repositoryRoot,
    env: { ...Bun.env, UNBUN_CC_STORE: store },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

async function runTty(args, input = '') {
  const command = `stty cols 80 rows 24; ${['bun', cli, 'cc', ...args].map((value) => Bun.$.escape(value)).join(' ')}`
  const child = Bun.spawn(['script', '-q', '-e', '-c', command, '/dev/null'], {
    cwd: repositoryRoot,
    env: { ...Bun.env, UNBUN_CC_STORE: store },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (input) await Bun.sleep(750)
  child.stdin.write(input)
  child.stdin.end()
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout: stdout.replaceAll('\r', ''), stderr }
}

async function newTarget(name) {
  const target = path.join(root, name)
  await cp(golden, target)
  return target
}

function writeEnvelope(result) {
  const envelope = JSON.parse(result.stdout)
  expect(validateWriteEnvelope(envelope), validateWriteEnvelope.errors?.map((error) => error.message).join('\n')).toBe(true)
  expect(envelope.exit_code).toBe(result.exitCode)
  return envelope
}

async function jsonStatus(target) {
  const result = await run(['status', '--binary', target, '--json'])
  expect(result).toMatchObject({ exitCode: 0, stderr: '' })
  return JSON.parse(result.stdout)
}

describe('unbun cc public process entry', () => {
  test('explicit status emits one schema-valid JSON object without creating the store', async () => {
    const result = await run(['status', '--binary', binary, '--json'])
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    const status = JSON.parse(result.stdout)
    expect(validateStatus(status), validateStatus.errors?.map((error) => error.message).join('\n')).toBe(true)
    expect(status).toMatchObject({
      schema_version: 1,
      path: binary,
      version: '2.1.175',
      has_baseline: false,
      probe_error: null,
      features: {
        'source-exec': { slug: 'source-exec', state: 'clean' },
        'agent-model': { slug: 'agent-model', state: 'clean' },
        channels: { slug: 'channels', state: 'clean' },
      },
    })
    await expect(access(store)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('profile is read-only and identifies the JavaScript implementation', async () => {
    const profileStore = path.join(root, 'profile-store')
    store = profileStore
    const result = await run(['status', '--binary', binary, '--profile'])
    expect(result).toMatchObject({ exitCode: 0, stderr: '' })
    expect(result.stdout).toContain('implementation=js')
    expect(result.stdout).toContain('total_ms=')
    await expect(access(profileStore)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('bare non-TTY is the same read-only status path', async () => {
    const result = await run(['--binary', binary, '--json'])
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout).path).toBe(binary)
    await expect(access(store)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('production CLI no longer imports the generation-one patch implementation', async () => {
    const source = await readFile(cli, 'utf8')
    expect(source).not.toMatch(/from ['"]\.\/lib\/patch-binary\.mjs['"]/) 
  })

  test('patch and revert use the transaction target-set semantics and common write envelope', async () => {
    const target = await newTarget('feature-target')
    const patched = await run(['patch', '--binary', target, '--feature', 'agent-model', '--yes', '--json'])
    expect(patched.stderr).toBe('')
    expect(writeEnvelope(patched)).toMatchObject({
      success: true,
      action: 'patch',
      results: [{ binary: target, applied: ['agent-model'], resigned: false }],
      errors: [],
    })
    expect((await jsonStatus(target)).features['agent-model'].state).toBe('patched')

    const reverted = await run(['revert', '--binary', target, '--feature', 'agent-model', '--json'])
    expect(reverted.stderr).toBe('')
    expect(writeEnvelope(reverted)).toMatchObject({
      success: true,
      action: 'revert',
      results: [{ binary: target, applied: [], resigned: false }],
      errors: [],
    })
    expect((await jsonStatus(target)).features['agent-model'].state).toBe('clean')
  })

  test('revert validates dependencies against the final target set', async () => {
    store = path.join(root, 'dependency-store')
    const target = await newTarget('dependency-target')
    writeEnvelope(await run(['patch', '--binary', target, '--feature', 'channels', '--json']))

    const refused = await run(['revert', '--binary', target, '--feature', 'source-exec', '--json'])
    expect(refused.stderr).toContain('unsupported_or_mixed_no_baseline')
    expect(writeEnvelope(refused)).toMatchObject({
      success: false,
      exit_code: 1,
      results: [],
      errors: [{ code: 'unsupported_or_mixed_no_baseline', feature: 'source-exec' }],
    })
    expect((await jsonStatus(target)).features.channels.state).toBe('patched')

    const reverted = await run([
      'revert',
      '--binary', target,
      '--feature', 'source-exec',
      '--feature', 'channels',
      '--json',
    ])
    expect(reverted.stderr).toBe('')
    expect(writeEnvelope(reverted)).toMatchObject({
      success: true,
      results: [{ applied: [] }],
      errors: [],
    })
    expect((await jsonStatus(target)).features).toMatchObject({
      'source-exec': { state: 'clean' },
      channels: { state: 'clean' },
    })
  })

  test('snapshot save/list/restore/rm are wired through the shared store and transaction APIs', async () => {
    const target = await newTarget('snapshot-target')
    writeEnvelope(await run(['patch', '--binary', target, '--feature', 'agent-model', '--json']))

    const saved = await run(['snapshot', 'save', 'agent-only', '--binary', target, '--json'])
    expect(saved.stderr).toBe('')
    const savedEnvelope = writeEnvelope(saved)
    expect(savedEnvelope).toMatchObject({ success: true, action: 'snapshot-save', errors: [] })
    expect(Object.keys(savedEnvelope.results[0])).toEqual(['binary', 'applied', 'edits', 'resigned'])

    writeEnvelope(await run(['revert', '--binary', target, '--feature', 'agent-model', '--json']))
    const restored = await run(['revert', '--snapshot', 'agent-only', '--binary', target, '--json'])
    expect(restored.stderr).toBe('')
    expect(writeEnvelope(restored)).toMatchObject({ success: true, action: 'snapshot-restore', errors: [] })
    expect((await jsonStatus(target)).features['agent-model'].state).toBe('patched')

    const listed = await run(['snapshot', 'list', '--binary', target, '--json'])
    expect(listed).toMatchObject({ exitCode: 0, stderr: '' })
    expect(JSON.parse(listed.stdout)).toMatchObject({
      schema_version: 1,
      snapshots: [{ binary: target, slug: 'agent-only', version: '2.1.175', invalid: false }],
    })

    const removed = await run(['snapshot', 'rm', 'agent-only', '--binary', target, '--json'])
    expect(removed.stderr).toBe('')
    expect(writeEnvelope(removed)).toMatchObject({ success: true, action: 'snapshot-rm', errors: [] })
    expect(JSON.parse((await run(['snapshot', 'list', '--binary', target, '--json'])).stdout).snapshots).toEqual([])
  })

  test('batch writes preserve successes and exit with the most severe structured error', async () => {
    const valid = await newTarget('batch-valid')
    const invalid = path.join(root, 'batch-invalid')
    await Bun.write(invalid, 'not a Claude binary')

    const result = await run([
      'patch',
      '--binary', valid,
      '--binary', invalid,
      '--feature', 'agent-model',
      '--json',
    ])
    expect(result.stderr).toContain('version_probe_failed')
    expect(writeEnvelope(result)).toMatchObject({
      success: false,
      exit_code: 1,
      action: 'patch',
      results: [{ binary: valid, applied: ['agent-model'] }],
      errors: [{ code: 'version_probe_failed', binary: invalid }],
    })
  })

  test('batch severity is the maximum across successful, usage-level, and integrity-level outcomes', async () => {
    store = path.join(root, 'severity-store')
    const valid = await newTarget('severity-valid')
    const damaged = await newTarget('severity-damaged')
    const unsupported = path.join(root, 'severity-unsupported')
    await writeFile(unsupported, 'not a Claude binary')
    writeEnvelope(await run(['patch', '--binary', valid, '--binary', damaged, '--feature', 'agent-model', '--json']))
    const damagedKey = await targetKeyFor(damaged)
    const baselineManifest = path.join(store, 'v1/targets', damagedKey, 'baselines/2.1.175/baseline.json')
    const baseline = JSON.parse(await readFile(baselineManifest, 'utf8'))
    baseline.sha256 = '0'.repeat(64)
    await writeFile(baselineManifest, `${JSON.stringify(baseline)}\n`)

    const result = await run([
      'patch',
      '--binary', valid,
      '--binary', unsupported,
      '--binary', damaged,
      '--feature', 'agent-model',
      '--json',
    ])
    expect(writeEnvelope(result)).toMatchObject({
      success: false,
      exit_code: 2,
      results: [{ binary: valid }],
      errors: [
        { code: 'version_probe_failed', binary: unsupported },
        { code: 'baseline_invalid', binary: damaged },
      ],
    })
  })

  test('snapshot-version selects the requested same-name slot for removal', async () => {
    store = path.join(root, 'snapshot-version-store')
    const target = await newTarget('snapshot-version-target')
    writeEnvelope(await run(['snapshot', 'save', 'same', '--binary', target, '--json']))
    const current = await readFile(target)
    await writeFile(target, Buffer.from(current.toString('latin1').replace('VERSION:"2.1.175"', 'VERSION:"2.1.174"'), 'latin1'))
    writeEnvelope(await run(['snapshot', 'save', 'same', '--binary', target, '--json']))
    await writeFile(target, current)

    const removed = await run(['snapshot', 'rm', 'same', '--snapshot-version', '2.1.174', '--binary', target, '--json'])
    expect(removed.stderr).toBe('')
    expect(writeEnvelope(removed)).toMatchObject({ success: true, action: 'snapshot-rm', errors: [] })
    expect(JSON.parse((await run(['snapshot', 'list', '--binary', target, '--json'])).stdout).snapshots).toEqual([
      { binary: target, slug: 'same', version: '2.1.175', invalid: false },
    ])
  })

  test('store root reports the temporary override without creating it', async () => {
    const isolatedStore = path.join(root, 'diagnostic-store')
    store = isolatedStore
    const result = await run(['store', 'root', '--json'])
    expect(result).toMatchObject({ exitCode: 0, stderr: '' })
    expect(JSON.parse(result.stdout)).toEqual({ schema_version: 1, root: isolatedStore })
    await expect(access(isolatedStore)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('lock inspect is read-only and cleanup requires force while preserving binary bytes', async () => {
    store = path.join(root, 'lock-store')
    const target = await newTarget('lock-target')
    writeEnvelope(await run(['patch', '--binary', target, '--feature', 'agent-model', '--json']))
    const targetManifest = JSON.parse(await readFile(path.join(store, 'v1/targets', await singleTargetKey(), 'target.json'), 'utf8'))
    const lockDirectory = path.join(store, 'v1/targets', targetManifest.path_key, 'write.lock')
    await mkdir(lockDirectory)
    await writeFile(path.join(lockDirectory, 'owner.json'), '{broken')
    const before = createHash('sha256').update(await readFile(target)).digest('hex')

    const inspected = await run(['lock', 'inspect', '--binary', target, '--json'])
    expect(inspected).toMatchObject({ exitCode: 0, stderr: '' })
    expect(JSON.parse(inspected.stdout)).toEqual({
      schema_version: 1,
      binary: target,
      locked: true,
      owner_known: false,
      owner: null,
    })

    const refused = await run(['lock', 'cleanup', '--binary', target, '--json'])
    expect(refused.stderr).toContain('target_locked')
    expect(writeEnvelope(refused)).toMatchObject({
      success: false,
      exit_code: 1,
      action: 'lock-cleanup',
      errors: [{ code: 'target_locked', binary: target }],
    })

    const cleaned = await run(['lock', 'cleanup', '--binary', target, '--force', '--json'])
    expect(cleaned.stderr).toBe('')
    expect(writeEnvelope(cleaned)).toMatchObject({ success: true, action: 'lock-cleanup', errors: [] })
    expect(createHash('sha256').update(await readFile(target)).digest('hex')).toBe(before)
  })

  test('bare TTY dynamically runs the Ink TUI while explicit status stays on the status path', async () => {
    store = path.join(root, 'tty-store')
    const target = await newTarget('tty-target')
    const bare = await runTty(['--binary', target], 'q')
    expect(bare.exitCode).toBe(0)
    expect(bare.stdout).toContain('UNBUN CC')
    expect(bare.stdout).not.toContain('not-yet-implemented')

    const explicit = await runTty(['status', '--binary', target, '--json'])
    expect(explicit.exitCode).toBe(0)
    expect(explicit.stderr).toBe('')
    expect(JSON.parse(explicit.stdout).path).toBe(target)
  })

  test('cc help lists the manager and preserved runtime-introspection commands', async () => {
    const result = await run(['--help'])
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('status|patch|revert|snapshot|store|lock')
    expect(result.stdout).toContain('run|introspect|patch-loader-hook')
  })

  test('unknown options and features are usage exit 1 with clean stdout', async () => {
    for (const args of [
      ['status', '--definitely-unknown'],
      ['patch', '--binary', binary, '--feature', 'not-a-feature', '--json'],
    ]) {
      const result = await run(args)
      expect(result.exitCode).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toContain('usage_error')
    }
  })

  test('--all and --feature are rejected as mutually exclusive', async () => {
    const result = await run(['patch', '--binary', binary, '--all', '--feature', 'agent-model', '--json'])
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('usage_error')
    expect(result.stderr).toContain('--all and --feature are mutually exclusive')
  })

  test('a missing explicit write target remains environment severity one', async () => {
    const missing = path.join(root, 'missing-claude')
    const result = await run(['patch', '--binary', missing, '--feature', 'agent-model', '--json'])
    expect(result.stderr).toContain('version_probe_failed')
    expect(writeEnvelope(result)).toMatchObject({
      success: false,
      exit_code: 1,
      results: [],
      errors: [{ code: 'version_probe_failed', binary: missing }],
    })
  })
})

async function singleTargetKey() {
  const entries = await Array.fromAsync(new Bun.Glob('*').scan({ cwd: path.join(store, 'v1/targets'), onlyFiles: false }))
  expect(entries).toHaveLength(1)
  return entries[0]
}

async function targetKeyFor(binaryPath) {
  const rootDirectory = path.join(store, 'v1/targets')
  const entries = await Array.fromAsync(new Bun.Glob('*/target.json').scan({ cwd: rootDirectory }))
  for (const entry of entries) {
    const manifest = JSON.parse(await readFile(path.join(rootDirectory, entry), 'utf8'))
    if (manifest.canonical_path === binaryPath) return manifest.path_key
  }
  throw new Error(`target metadata not found for ${binaryPath}`)
}