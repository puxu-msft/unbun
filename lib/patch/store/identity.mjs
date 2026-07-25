import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import path from 'node:path'

function asciiLower(value) {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase())
}

export function canonicalizeWindowsPath(inputPath) {
  if (typeof inputPath !== 'string' || !path.win32.isAbsolute(inputPath)) {
    throw new TypeError('target path must be a Windows absolute path')
  }
  const withoutExtendedPrefix = inputPath.startsWith('\\\\?\\UNC\\')
    ? `\\\\${inputPath.slice(8)}`
    : inputPath.startsWith('\\\\?\\') ? inputPath.slice(4) : inputPath
  return asciiLower(withoutExtendedPrefix.replaceAll('\\', '/')).normalize('NFC')
}

export async function canonicalizePath(inputPath, {
  platform = process.platform === 'win32' ? 'windows' : 'posix',
  realpath: resolveRealpath = realpath,
} = {}) {
  if (platform === 'windows' || platform === 'win32') {
    const resolved = await resolveRealpath(inputPath)
    return canonicalizeWindowsPath(resolved)
  }
  if (typeof inputPath !== 'string' || !path.posix.isAbsolute(inputPath)) {
    throw new TypeError('target path must be a POSIX absolute path')
  }
  return (await resolveRealpath(inputPath)).normalize('NFC')
}

export function pathKey(canonicalPath) {
  if (typeof canonicalPath !== 'string' || canonicalPath.length === 0) {
    throw new TypeError('canonical path must be a non-empty string')
  }
  return createHash('sha256').update(canonicalPath, 'utf8').digest('hex')
}

export async function targetIdentity(inputPath, options) {
  const canonicalPath = await canonicalizePath(inputPath, options)
  return { canonicalPath, pathKey: pathKey(canonicalPath) }
}