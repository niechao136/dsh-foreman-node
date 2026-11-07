/** What the device's configuration page decides, without a DOM. */
import { expect, it } from 'vitest'
import type { NodeConfig } from '../src/index.ts'
import { addressPreview, DEFAULT_SSH, editsOf, emptyFields, keyLabel, needsToken, testMessage } from '../src/client/page-state.ts'

const config = (overrides: Partial<NodeConfig> = {}): NodeConfig =>
  ({ url: '', deviceId: '', token: '', roots: [], heartbeatMs: 15_000, reconnectMs: 1_000, ssh: { ...DEFAULT_SSH }, ...overrides }) as NodeConfig

it('labels a key by its comment, and by nothing else when it has none', () => {
  expect(keyLabel({ name: 'id_ed25519', path: '/k', comment: 'me@laptop' })).toBe('id_ed25519 · me@laptop')
  expect(keyLabel({ name: 'id_ed25519', path: '/k', comment: '' })).toBe('id_ed25519')
})

it('says which address will be dialled, and whether it is derived from the tunnel', () => {
  expect(addressPreview(config({ url: 'wss://hub.example' }))).toEqual({ address: 'wss://hub.example', derived: false })
  expect(addressPreview(config({ url: 'wss://hub.example', ssh: { ...DEFAULT_SSH, enabled: true, localPort: 8791 } })))
    .toEqual({ address: 'ws://127.0.0.1:8791', derived: true })
})

it('names the fields still empty, and stops asking for an address once a tunnel is on', () => {
  // The third argument says whether a token is already stored; a stored token is never sent to the page.
  expect(emptyFields(config(), false)).toEqual(['url', 'deviceId', 'token'])
  expect(emptyFields(config(), true)).toEqual(['url', 'deviceId'])
  expect(emptyFields(config({ ssh: { ...DEFAULT_SSH, enabled: true } }), false))
    .toEqual(['ssh.host', 'ssh.user', 'ssh.keyPath', 'deviceId', 'token'])
  expect(emptyFields(config({ url: 'ws://h', deviceId: 'd' }), true)).toEqual([])
})

it('never writes the token back when the page holds none, so the stored one survives', () => {
  // A secret never reaches the page. Sending `token: ''` would erase the stored one; sending nothing keeps it.
  const paths = editsOf(config({ token: undefined as never })).map(edit => edit.path.join('.'))
  expect(paths).not.toContain('token')
})

it('writes one edit per field rather than replacing the whole section', () => {
  // A root `set` replaces everything, so the token the page never received would be dropped on every save.
  // That is exactly what happened on a real machine: the device went offline after one save.
  const edits = editsOf(config())
  expect(edits.every(edit => edit.path.length > 0)).toBe(true)
  const paths = edits.map(edit => edit.path.join('.'))
  expect(paths).toContain('url')
  expect(paths).toContain('ssh.host')
  expect(paths).toContain('roots')
})

it('sends a typed token, and only then', () => {
  const typed = editsOf(config({ token: 'new-token' })).find(edit => edit.path.join('.') === 'token')
  expect(typed?.value).toBe('new-token')
  expect(editsOf(config({ token: '' })).some(edit => edit.path.join('.') === 'token')).toBe(false)
})

it('asks for a token only when it is not a string at all', () => {
  expect(needsToken({ token: undefined as never })).toBe(true)
})

it('names the passphrase case rather than reprinting the refusal', () => {
  expect(testMessage({ ok: false, output: 'Permission denied (publickey).' })).toBe('passphrase')
})

it('says a key worked', () => {
  expect(testMessage({ ok: true, output: '' })).toBe('ok')
})

it('tells a person the host could not be resolved', () => {
  expect(testMessage({ ok: false, output: 'ssh: Could not resolve hostname nope' })).toBe('unresolved')
})

it('says a test timed out instead of showing an empty output', () => {
  expect(testMessage({ ok: false, output: '(timed out after 15s)' })).toBe('timeout')
})

it('shows anything else ssh said verbatim, because it is already specific', () => {
  expect(testMessage({ ok: false, output: 'Connection refused' })).toBe('Connection refused')
})

it('falls back to a word when ssh said nothing at all', () => {
  expect(testMessage({ ok: false, output: '   ' })).toBe('refused')
})

it('writes trimmed values, so a stray space cannot become part of a token', () => {
  const edits = editsOf(config({ url: ' ws://h ', deviceId: ' d ', token: ' t ', roots: [{ project: ' shop ', path: ' /w ' }],
    ssh: { ...DEFAULT_SSH, enabled: true, host: ' h ', user: ' u ', keyPath: ' /k ' } }))
  const value = (path: string) => edits.find(edit => edit.path.join('.') === path)?.value
  expect(value('url')).toBe('ws://h')
  expect(value('deviceId')).toBe('d')
  expect(value('token')).toBe('t')
  expect(value('roots')).toEqual([{ project: 'shop', path: '/w' }])
  expect(value('ssh.host')).toBe('h')
  expect(value('ssh.user')).toBe('u')
  expect(value('ssh.keyPath')).toBe('/k')
})

it('keeps the ports as numbers, which the schema demands', () => {
  const edits = editsOf(config({ ssh: { ...DEFAULT_SSH, port: 2222, localPort: 8791, remotePort: 8790 } }))
  const value = (path: string) => edits.find(edit => edit.path.join('.') === path)?.value
  expect(value('ssh.port')).toBe(2222)
  expect(value('ssh.localPort')).toBe(8791)
  expect(value('ssh.remotePort')).toBe(8790)
})
