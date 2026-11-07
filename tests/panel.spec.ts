/**
 * The device page, rendered to markup.
 *
 * There is no jsdom here on purpose: this package is deliberately small, and pulling a DOM environment in for one page
 * would cost every install of a device. `react-dom/server` is already present with react-dom, and it is enough to pin
 * what the page shows for the configurations that matter — the decisions themselves are covered in `page-state.spec.ts`.
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { DevicePage } from '../src/client/index.tsx'
import { zh } from '../src/client/locales.ts'
import { DEFAULT_SSH } from '../src/client/page-state.ts'
import type { NodeConfig } from '../src/index.ts'

/** The page's translator: the real dictionary, with `{name}` substitution like the host does. */
const t = (key: keyof typeof zh): string => zh[key]

const config = (overrides: Partial<NodeConfig> = {}): NodeConfig => ({
  url: 'wss://hub.example', deviceId: 'laptop', token: 'tok', roots: [], heartbeatMs: 15_000, reconnectMs: 1_000,
  ssh: { ...DEFAULT_SSH }, ...overrides }) as NodeConfig

/** A form whose saved value is `value`, so the page renders a draft from it. */
const form = (value: NodeConfig, writable = true) => ({ state: { status: 'ready' as const, value, writable, revision: 1 },
  mutate: async () => true }) as never

/** The page, with the key list and the test result supplied rather than fetched. */
const render = (value: NodeConfig, options: { keys?: unknown[]; failed?: boolean } = {}): string =>
  renderToStaticMarkup(createElement(DevicePage, { t, form: form(value), initialKeys: options.keys as never,
    keysFailed: options.failed } as never))

it('shows the address it will dial and that the tunnel derives it', () => {
  const markup = render(config({ ssh: { ...DEFAULT_SSH, enabled: true, localPort: 8791 } }))
  expect(markup).toContain('ws://127.0.0.1:8791')
  // The address box must not be editable when it is derived: typing there would look like it mattered.
  expect(markup).toContain('readonly')
})

it('lists the keys it found, labelled by name and comment', () => {
  const markup = render(config(), { keys: [{ name: 'id_ed25519', path: '/home/me/.ssh/id_ed25519', comment: 'me@laptop' }] })
  expect(markup).toContain('id_ed25519 · me@laptop')
})

it('says there is no usable key rather than showing an empty picker', () => {
  expect(render(config(), { keys: [] })).toContain(zh.keysEmpty)
})

it('says the key list is unavailable when the device has no web server', () => {
  expect(render(config(), { failed: true })).toContain(zh.keysUnavailable)
})

it('says what is still missing, naming the fields', () => {
  const markup = render(config({ url: '', deviceId: '', token: '' }))
  expect(markup).toContain(zh.missing)
  expect(markup).toContain('url')
  expect(markup).toContain('deviceId')
})

it('does not ask for an address when a tunnel is configured', () => {
  const markup = render(config({ url: '', ssh: { ...DEFAULT_SSH, enabled: true, host: 'h', user: 'u', keyPath: '/k' } }))
  expect(markup).not.toContain('>url<')
})

it('tells a person to edit the profile when the host accepts no writes', () => {
  const markup = renderToStaticMarkup(createElement(DevicePage, { t, form: form(config(), false) } as never))
  expect(markup).toContain(zh.readOnly)
  expect(markup).not.toContain('data-node-save')
})

it('offers the save button when the host accepts writes', () => {
  expect(render(config())).toContain('data-node-save')
})
