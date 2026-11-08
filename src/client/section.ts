/**
 * The section the settings panel mounts.
 *
 * It exists so the page component stays testable without a slot registry: everything DSH-specific — the form
 * controller, the subscription, the translator — is narrowed to props here, and `DevicePage` receives plain values.
 */
import { createElement, useSyncExternalStore } from 'react'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SshKey } from '../keys.ts'
import type { zh } from './locales.ts'

/**
 * What the page needs from a configuration form: the current snapshot and one write door.
 *
 * Narrowed on purpose. The Host also offers `set`, `unset` and `describe`; the page never uses them, and a wider prop
 * would let a future edit reach for a write path the tests here do not cover.
 */
export interface PageForm {
  state: ConfigFormSnapshot<Record<string, unknown>>
  mutate: ConfigForm<Record<string, unknown>>['mutate']
}

/** The controller the settings provider hands out, as this file needs it. */
export interface FormController {
  getSnapshot(): ConfigFormSnapshot<Record<string, unknown>>
  subscribe(listener: () => void): () => void
  mutate: ConfigForm<Record<string, unknown>>['mutate']
}

export interface SectionProps {
  form: FormController
  t: (key: keyof typeof zh) => string
  /** Supplied only by tests, so a page can render without a network. */
  initialKeys?: readonly SshKey[]
  keysFailed?: boolean
}

/**
 * A placeholder that the next task replaces with the real page.
 *
 * Task 1 of the plan deliberately stops here: the subscription is the risky part (a missing `configForms` service, a
 * namespace the Host has not published yet), so it is proven on its own before the page is rebuilt around it.
 */
function Pending({ t }: { t: SectionProps['t'] }): ReturnType<typeof createElement> {
  return createElement('div', { 'data-section-pending': '' }, t('loading'))
}

export function Section({ form, t }: SectionProps): ReturnType<typeof createElement> {
  // `useSyncExternalStore` is the hook the Host's own settings pages use: the form replaces its snapshot object on
  // every change, so identity comparison is enough and no deep equality is needed here.
  //
  // The third argument is the server snapshot, and it is the same read: the page is only ever server-rendered by the
  // tests in this package (`renderToStaticMarkup`), where the browser's subscription machinery does not run. Without
  // it React throws `Missing getServerSnapshot` and the whole page fails to render.
  useSyncExternalStore(form.subscribe, form.getSnapshot, form.getSnapshot)
  return createElement(Pending, { t })
}
