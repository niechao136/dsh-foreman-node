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

it('renders a placeholder until the page itself is wired in', () => {
  const markup = renderToStaticMarkup(createElement(Section, { form: controller({ status: 'loading' }), t } as never))
  expect(markup).toContain('data-section-pending')
})
