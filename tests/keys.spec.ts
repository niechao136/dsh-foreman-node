/** What the device offers as a key: which files count, and what of them leaves the machine. */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { listKeys } from '../src/keys.ts'

/** A directory with whatever the test needs in it. */
function keysDir(files: Record<string, string>): string {
  const directory = mkdtempSync(join(tmpdir(), 'foreman-keys-'))
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(directory, name), contents)
  return directory
}

it('lists a key only when its public half sits beside it', () => {
  const directory = keysDir({ id_ed25519: 'PRIVATE', 'id_ed25519.pub': 'ssh-ed25519 AAAAC3Nza niech@desktop',
    id_orphan: 'PRIVATE', known_hosts: 'x', config: 'Host *' })
  expect(listKeys(directory)).toEqual([{ name: 'id_ed25519', path: join(directory, 'id_ed25519'), comment: 'niech@desktop' }])
})

it('never returns the private half', () => {
  const directory = keysDir({ id_ed25519: 'SECRET-MATERIAL', 'id_ed25519.pub': 'ssh-ed25519 AAAAC3Nza c' })
  expect(JSON.stringify(listKeys(directory))).not.toContain('SECRET-MATERIAL')
})

it('says nothing rather than failing when the directory does not exist', () => {
  expect(listKeys('/definitely/not/here')).toEqual([])
})

it('keeps a key whose public half has no comment, with an empty one', () => {
  const directory = keysDir({ id_ed25519: 'P', 'id_ed25519.pub': 'ssh-ed25519 AAAAC3Nza' })
  expect(listKeys(directory)[0]).toMatchObject({ name: 'id_ed25519', comment: '' })
})

it('offers every key in the directory, in a stable order', () => {
  const directory = keysDir({ id_b: 'P2', 'id_b.pub': 'ssh-rsa B', id_a: 'P1', 'id_a.pub': 'ssh-rsa A' })
  expect(listKeys(directory).map(key => key.name)).toEqual(['id_a', 'id_b'])
})
