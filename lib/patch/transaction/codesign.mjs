import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import path from 'node:path'

import { StoreError } from '../store/manifests.mjs'

function failed(message, details = {}) {
  return new StoreError('codesign_failed', message, 3, details)
}

async function findExecutable(name, { env = process.env } = {}) {
  for (const directory of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, name)
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {}
  }
  return null
}

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout = []
    const stderr = []
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    child.on('error', reject)
    child.on('close', (exitCode) => resolve({
      exitCode,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }))
  })
}

export function createMacOSCodesigner({
  resolveExecutable = () => findExecutable('codesign'),
  run = runProcess,
} = {}) {
  return async function codesign(binaryPath) {
    const executable = await resolveExecutable()
    if (!executable) throw failed('codesign executable was not found', { stage: 'resolve' })
    const stages = [
      ['remove-signature', ['--remove-signature', binaryPath]],
      ['sign', ['-s', '-', binaryPath]],
    ]
    for (const [stage, args] of stages) {
      let result
      try {
        result = await run(executable, args)
      } catch (error) {
        throw failed(`codesign ${stage} could not be started`, { stage, cause: error.message })
      }
      if (result?.exitCode !== 0) {
        throw failed(`codesign ${stage} failed`, {
          stage,
          exitCode: result?.exitCode ?? null,
          output: (result?.stderr || result?.stdout || '').trim(),
        })
      }
    }
    return { resigned: true }
  }
}