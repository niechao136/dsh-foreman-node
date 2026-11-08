/**
 * The settings-page shell: the entry name and the subscription that feeds the page its form.
 *
 * `tests/section.spec` is `.ts`, not `.tsx`, because `vitest.config.ts` only collects `tests/**\/*.spec.ts`
 * and the rest of this package builds its elements with `createElement` for the same reason.
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { assertEntryId, ENTRY_ID, ENTRY_ORDER } from '../src/client/entry.ts'
import { zh } from '../src/client/locales.ts'
import { Section } from '../src/client/section.ts'

const t = (key: keyof typeof zh): string => zh[key]

/** A stand-in for the host's `ConfigForm` controller: a snapshot, a subscription, and a write queue. */
const controller = (snapshot: unknown) => ({
  getSnapshot: () => snapshot,
  subscribe: () => () => {},
  mutate: async () => true,
})

/** A snapshot the page can actually render a form from. */
const ready = { status: 'ready' as const, value: { url: 'wss://hub.example', deviceId: 'pc', token: 'tok', roots: [],
  heartbeatMs: 15_000, reconnectMs: 1_000, ssh: {} }, base: undefined, user: undefined, revision: 1,
  writable: true, mode: 'host' as const }

it('names the settings entry after the patch row it configures', () => {
  expect(ENTRY_ID).toBe('dsh-foreman-node')
  expect(ENTRY_ORDER).toBe(55)
})

it('finds the row id in a patch, and says so when there is no row at all', () => {
  expect(assertEntryId('- insert:\n    - id: dsh-foreman-node\n      name: x\n')).toBe('dsh-foreman-node')
  // A patch declaring some other row still reports that row: the caller compares it to `ENTRY_ID`, which is how a
  // rename gets caught. Only a document with no row at all has no answer.
  expect(assertEntryId('- insert:\n    - id: something-else\n')).toBe('something-else')
  expect(assertEntryId('')).toBeUndefined()
})

it('renders the configuration page once the host publishes a section', () => {
  const markup = renderToStaticMarkup(createElement(Section,
    { form: controller(ready), t } as never))
  expect(markup).toContain('data-foreman-node-page="ready"')
})

it('shows the reading line while the form has no value yet', () => {
  const markup = renderToStaticMarkup(createElement(Section, { form: controller({ status: 'loading' }), t } as never))
  expect(markup).toContain(zh.loading)
  expect(markup).not.toContain('data-node-save')
})
