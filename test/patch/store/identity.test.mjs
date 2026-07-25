import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'

import {
  canonicalizePath,
  canonicalizeWindowsPath,
  pathKey,
} from '../../../lib/patch/store/identity.mjs'

const vectors = JSON.parse(await readFile(new URL('../../../contract/vectors/canonical-path-v1.json', import.meta.url), 'utf8'))

describe('store target identity', () => {
  for (const vector of vectors.cases) {
    test(`matches frozen canonical path vector ${vector.id}`, async () => {
      const canonicalPath = vector.platform === 'windows'
        ? canonicalizeWindowsPath(vector.input_path)
        : await canonicalizePath(vector.input_path, {
            platform: 'posix',
            realpath: async (input) => {
              let resolved = input
              for (const [link, target] of Object.entries(vector.symlinks ?? {})) {
                if (resolved === link || resolved.startsWith(`${link}/`)) resolved = `${target}${resolved.slice(link.length)}`
              }
              return resolved
            },
          })

      expect(canonicalPath).toBe(vector.canonical_path)
      expect(pathKey(canonicalPath)).toBe(vector.path_key)
      expect(pathKey(canonicalPath)).toMatch(/^[0-9a-f]{64}$/)
    })
  }

  test('requires an existing target through the realpath boundary', async () => {
    const missing = new Error('missing')
    missing.code = 'ENOENT'
    await expect(canonicalizePath('/missing/claude', {
      platform: 'posix',
      realpath: async () => { throw missing },
    })).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('preserves UNC identity when removing the extended Windows prefix', () => {
    expect(canonicalizeWindowsPath('\\\\?\\UNC\\Server\\Share\\Claude.exe')).toBe('//server/share/claude.exe')
  })
})