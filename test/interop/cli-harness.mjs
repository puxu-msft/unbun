import { spawn } from 'node:child_process'
import path from 'node:path'

import { parseAndNormalizeOutput } from './normalize-output.mjs'

const ROOT = path.resolve(import.meta.dir, '../..')

export const PUBLIC_CLI_BOUNDARIES = Object.freeze({
  javascript: Object.freeze({
    id: 'unbun-cc',
    implementation: 'js',
    maturity: 'public-contract',
    availability: 'available',
    role: 'public-entrypoint',
    command: ['bun', 'cli.mjs', 'cc'],
    cwd: ROOT,
  }),
  python: Object.freeze({
    id: 'ccpatch',
    implementation: 'python',
    maturity: 'public-contract',
    availability: 'available',
    role: 'public-entrypoint',
    command: ['uv', 'run', '--directory', 'python/cc-patch', 'ccpatch'],
    cwd: ROOT,
  }),
})

export const CONTRACT_RUNNER_BOUNDARIES = Object.freeze({
  javascript: Object.freeze({
    id: 'js-contract-vector-runner',
    implementation: 'js',
    maturity: 'contract-runner',
    availability: 'available',
    role: 'read-only-contract',
    command: ['bun', path.join(ROOT, 'test', 'contract', 'js-vector-runner.mjs')],
    cwd: ROOT,
  }),
  python: Object.freeze({
    id: 'python-contract-prototype',
    implementation: 'python',
    maturity: 'prototype',
    availability: 'available',
    role: 'read-only-contract',
    command: ['python3', path.join(ROOT, 'test', 'contract', 'python-vector-runner.py')],
    cwd: ROOT,
  }),
})

function validateBoundary(boundary) {
  if (!boundary || typeof boundary !== 'object') throw new TypeError('CLI boundary is required')
  if (!boundary.id || !boundary.implementation || !boundary.maturity) {
    throw new TypeError('CLI boundary requires id, implementation, and maturity')
  }
  if (!Array.isArray(boundary.command) || boundary.command.length === 0) {
    throw new TypeError('CLI boundary requires a non-empty command array')
  }
}

export async function runCli(boundary, {
  args = [],
  cwd = boundary.cwd ?? ROOT,
  env = {},
  unsetEnv = [],
  stdin = '',
  normalize = {},
} = {}) {
  validateBoundary(boundary)
  const [executable, ...commandArgs] = boundary.command
  const childEnv = { ...process.env, ...boundary.env, ...env }
  for (const name of unsetEnv) delete childEnv[name]
  const child = spawn(executable, [...commandArgs, ...args], {
    cwd,
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  const stdoutChunks = []
  const stderrChunks = []
  child.stdout.on('data', (chunk) => stdoutChunks.push(chunk))
  child.stderr.on('data', (chunk) => stderrChunks.push(chunk))
  child.stdin.end(stdin)

  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  const stdout = Buffer.concat(stdoutChunks).toString('utf8')
  const stderr = Buffer.concat(stderrChunks).toString('utf8')

  return {
    boundary: {
      id: boundary.id,
      implementation: boundary.implementation,
      maturity: boundary.maturity,
      availability: boundary.availability,
      role: boundary.role,
    },
    exitCode,
    output: parseAndNormalizeOutput(stdout, normalize),
    stderr,
  }
}

export function classifyInterop(writer, reader) {
  validateBoundary(writer)
  validateBoundary(reader)
  if (writer.implementation === reader.implementation) return 'same-implementation-write-read'
  return `${writer.implementation}-write-${reader.implementation}-read`
}

export async function runInteropScenario({
  writer,
  reader,
  artifactPath,
  normalize = {},
}) {
  const writerResult = await runCli(writer, {
    args: ['write', artifactPath],
    normalize,
  })
  if (writerResult.exitCode !== 0) {
    throw new Error(`${writer.id} write failed with exit ${writerResult.exitCode}: ${writerResult.stderr}`)
  }
  const readerResult = await runCli(reader, {
    args: ['read', artifactPath],
    normalize,
  })
  if (readerResult.exitCode !== 0) {
    throw new Error(`${reader.id} read failed with exit ${readerResult.exitCode}: ${readerResult.stderr}`)
  }
  return {
    mode: classifyInterop(writer, reader),
    writer: writerResult,
    reader: readerResult,
  }
}