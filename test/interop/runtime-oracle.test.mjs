import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { PUBLIC_CLI_BOUNDARIES, runCli } from './cli-harness.mjs'

const repositoryRoot = path.resolve(import.meta.dir, '../..')
const defaultCleanFixture = '/home/xp/.local/share/claude/versions/2.1.214'
const cleanFixture = process.env.UNBUN_CC_CLEAN_FIXTURE || defaultCleanFixture
const cleanFixtureSha256 = '3c029136f7c81f54ed4a38e9d52e655aad536433dbbde50519c8c31bb646ad14'
const temporaryRoots = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function sha256(file) {
  return new Bun.CryptoHasher('sha256').update(await readFile(file)).digest('hex')
}

function commandArgs(binary, action = 'patch') {
  const args = [action, '--binary', binary]
  if (action === 'patch') args.push('--feature', 'agent-model')
  return [...args, '--json']
}

async function writeWithPublicCli(implementation, binary, store, action = 'patch') {
  const result = await runCli(PUBLIC_CLI_BOUNDARIES[implementation], {
    args: commandArgs(binary, action),
    env: { UNBUN_CC_STORE: store },
  })
  expect(result.exitCode, result.stderr).toBe(0)
  expect(result.output).toMatchObject({
    schema_version: 1,
    success: true,
    action,
    exit_code: 0,
    errors: [],
  })
  return result.output
}

async function runProcess(command, options = {}) {
  const process = Bun.spawn(command, {
    cwd: repositoryRoot,
    stdout: 'pipe',
    stderr: 'pipe',
    ...options,
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  return { exitCode, stdout, stderr }
}

async function runOracle(binary, label, root) {
  await mkdir(root)
  const script = `
import json
import sys
from http.server import ThreadingHTTPServer
from pathlib import Path
import threading

sys.path.insert(0, ${JSON.stringify(path.join(repositoryRoot, 'exp/agent-model-runtime'))})
from runtime_probe import MockHandler, MockState, run_variant

state = MockState()
server = ThreadingHTTPServer(("127.0.0.1", 0), MockHandler)
server.state = state
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
host, port = server.server_address
try:
    result = run_variant(Path(sys.argv[1]), sys.argv[2], state, f"http://{host}:{port}", Path(sys.argv[3]), 45)
    print(json.dumps({"host": host, "port": port, "result": result}, separators=(",", ":")))
finally:
    server.shutdown()
    server.server_close()
    thread.join(timeout=5)
`
  const process = Bun.spawn(['python3', '-c', script, binary, label, root], {
    cwd: repositoryRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  expect(exitCode, stderr).toBe(0)
  expect(stderr).toBe('')
  return JSON.parse(stdout)
}

describe('public CLI agent-model runtime oracle', () => {
  test('ordinary Bun SFX runs but both public CLIs reject it without Claude-specific anchors', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unbun-runtime-sfx-'))
    temporaryRoots.push(root)
    const source = path.join(root, 'entry.js')
    const original = path.join(root, 'original')
    await writeFile(source, 'console.log(`unbun-runtime-sfx=${6 * 7}`)\n')
    const built = await runProcess(['bun', 'build', '--compile', '--bytecode', '--outfile', original, source])
    expect(built.exitCode, built.stderr).toBe(0)
    expect((await runProcess([original])).stdout.trim()).toBe('unbun-runtime-sfx=42')
    const originalBytes = await readFile(original)

    for (const implementation of ['javascript', 'python']) {
      const binary = path.join(root, `sfx-${implementation}`)
      await copyFile(original, binary)
      await chmod(binary, 0o755)
      const result = await runCli(PUBLIC_CLI_BOUNDARIES[implementation], {
        args: commandArgs(binary),
        env: { UNBUN_CC_STORE: path.join(root, `store-${implementation}`) },
      })
      expect(result.exitCode).not.toBe(0)
      expect(result.output).toMatchObject({
        schema_version: 1,
        success: false,
        action: 'patch',
        results: [],
        errors: [{ binary }],
      })
      expect(await readFile(binary)).toEqual(originalBytes)
      expect((await runProcess([binary])).stdout.trim()).toBe('unbun-runtime-sfx=42')
    }
  }, 30_000)

  test('both implementations patch isolated clean copies that advertise string and send a gpt child request', async () => {
    expect(await sha256(cleanFixture)).toBe(cleanFixtureSha256)
    const sourceBefore = { hash: await sha256(cleanFixture), stat: await stat(cleanFixture, { bigint: true }) }

    const cleanRoot = await mkdtemp(path.join(os.tmpdir(), 'unbun-runtime-clean-'))
    temporaryRoots.push(cleanRoot)
    const cleanBinary = path.join(cleanRoot, 'claude')
    await copyFile(cleanFixture, cleanBinary)
    const cleanOracle = await runOracle(cleanBinary, 'clean', path.join(cleanRoot, 'oracle'))
    expect(cleanOracle.result.agent_tool_advertised).toBe(true)
    expect(cleanOracle.result.agent_schema.properties.model.enum).toEqual(['sonnet', 'opus', 'haiku', 'fable'])
    expect(cleanOracle.result.tool_use_received_by_client).toBe(true)
    expect(cleanOracle.result.subagent_request_observed).toBe(false)

    for (const implementation of ['javascript', 'python']) {
      const root = await mkdtemp(path.join(os.tmpdir(), `unbun-runtime-${implementation}-`))
      temporaryRoots.push(root)
      const binary = path.join(root, 'claude')
      await copyFile(cleanFixture, binary)
      const originalBytes = await readFile(binary)
      const store = path.join(root, 'store')
      const patched = await writeWithPublicCli(implementation, binary, store)
      expect(patched.results).toEqual([
        expect.objectContaining({ applied: ['agent-model'], edits: 1 }),
      ])

      const oracle = await runOracle(binary, implementation, path.join(root, 'oracle'))
      expect(oracle.host).toBe('127.0.0.1')
      expect(oracle.port).toBeGreaterThan(0)
      expect(oracle.result.client.timed_out).toBe(false)
      expect(oracle.result.agent_tool_advertised).toBe(true)
      expect(oracle.result.agent_schema.properties.model).toMatchObject({ type: 'string' })
      expect(oracle.result.agent_schema.properties.model.enum).toBeUndefined()
      expect(oracle.result.tool_use_received_by_client).toBe(true)
      expect(oracle.result.subagent_request_observed).toBe(true)
      expect(oracle.result.subagent_requests[0].body.model).toBe('gpt-5.5')
      expect(oracle.result.binary_state).toMatchObject({
        bytecode_markers: 5,
        source_markers: 0,
        clean_agent_model_sites: 0,
        patched_agent_model_sites: 1,
      })

      const reverted = await writeWithPublicCli(implementation, binary, store, 'revert')
      expect(reverted.results).toEqual([
        expect.objectContaining({ applied: [], edits: 1 }),
      ])
      expect(await readFile(binary)).toEqual(originalBytes)

      const revertedOracle = await runOracle(binary, `${implementation}-reverted`, path.join(root, 'oracle-reverted'))
      expect(revertedOracle.result.agent_schema.properties.model.enum).toEqual(['sonnet', 'opus', 'haiku', 'fable'])
      expect(revertedOracle.result.subagent_request_observed).toBe(false)
      expect(revertedOracle.result.binary_state).toMatchObject({
        bytecode_markers: 5,
        source_markers: 0,
        clean_agent_model_sites: 1,
        patched_agent_model_sites: 0,
      })
    }

    const sourceAfter = { hash: await sha256(cleanFixture), stat: await stat(cleanFixture, { bigint: true }) }
    expect(sourceAfter.hash).toBe(sourceBefore.hash)
    expect(sourceAfter.stat.mtimeNs).toBe(sourceBefore.stat.mtimeNs)
    expect(sourceAfter.stat.size).toBe(sourceBefore.stat.size)
  }, 180_000)
})