/** What the device's configuration page decides, without a DOM. */
import { expect, it } from 'vitest'
import type { NodeConfig } from '../src/index.ts'
import { addressPreview, configOf, DEFAULT_SSH, emptyFields, keyLabel, testMessage } from '../src/client/page-state.ts'

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
  expect(emptyFields(config())).toEqual(['url', 'deviceId', 'token'])
  expect(emptyFields(config({ ssh: { ...DEFAULT_SSH, enabled: true } }))).toEqual(['ssh.host', 'ssh.user', 'ssh.keyPath', 'deviceId', 'token'])
  expect(emptyFields(config({ url: 'ws://h', deviceId: 'd', token: 't' }))).toEqual([])
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
  const written = configOf(config({ url: ' ws://h ', deviceId: ' d ', token: ' t ', roots: [{ project: ' shop ', path: ' /w ' }],
    ssh: { ...DEFAULT_SSH, enabled: true, host: ' h ', user: ' u ', keyPath: ' /k ' } }))
  expect(written).toMatchObject({ url: 'ws://h', deviceId: 'd', token: 't', roots: [{ project: 'shop', path: '/w' }] })
  expect(written.ssh).toMatchObject({ host: 'h', user: 'u', keyPath: '/k' })
})

it('keeps the ports as numbers, which the schema demands', () => {
  const written = configOf(config({ ssh: { ...DEFAULT_SSH, port: 2222, localPort: 8791, remotePort: 8790 } })) as { ssh: Record<string, unknown> }
  expect(written.ssh).toMatchObject({ port: 2222, localPort: 8791, remotePort: 8790 })
})
