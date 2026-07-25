import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { quarantineArtifact } from '../../../lib/patch/store/quarantine.mjs'
import { validateManifest } from '../../../lib/patch/store/manifests.mjs'

const temporary = []
afterEach(async () => Promise.all(temporary.splice(0).map((entry) => rm(entry, { recursive: true, force: true }))))

async function targetDirectory() {
  const root = await mkdtemp(path.join(tmpdir(), 'unbun-quarantine-js-'))
  temporary.push(root)
  return root
}

describe('store quarantine', () => {
  test('moves an artifact out of the active namespace and records validated provenance', async () => {
    const target = await targetDirectory()
    const relative = 'baselines/2.1.217/baseline.json'
    const source = path.join(target, ...relative.split('/'))
    const bytes = Buffer.from('invalid manifest')
    await mkdir(path.dirname(source), { recursive: true })
    await writeFile(source, bytes)

    const result = await quarantineArtifact(target, relative, 'baseline_hash_mismatch', {
      now: () => new Date('2026-07-23T12:34:56.000Z'),
      uuid: () => '123e4567-e89b-42d3-a456-426614174000',
    })
    await expect(stat(source)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readFile(result.artifactPath)).equals(bytes)).toBe(true)
    const metadata = JSON.parse(await readFile(result.manifestPath, 'utf8'))
    expect(validateManifest('quarantine', metadata)).toEqual(metadata)
    expect(metadata).toMatchObject({
      original_path: relative,
      reason: 'baseline_hash_mismatch',
      observed_sha256: createHash('sha256').update(bytes).digest('hex'),
      discovered_by: 'js',
    })
  })

  test('rejects paths outside the target and invalid reason codes before moving', async () => {
    const target = await targetDirectory()
    for (const relative of ['../escape', '/absolute', 'C:/absolute', 'nested\\windows']) {
      await expect(quarantineArtifact(target, relative, 'baseline_hash_mismatch')).rejects.toThrow()
    }
    await expect(quarantineArtifact(target, 'baseline.json', 'Bad Reason')).rejects.toThrow()
  })
})