/**
 * The section the settings panel mounts.
 *
 * It exists so the page component stays testable without a slot registry: everything DSH-specific — the form
 * controller, the subscription, the translator — is narrowed to props here, and `DevicePage` receives plain values.
 */
import { createElement, useSyncExternalStore } from 'react'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SshKey } from '../keys.ts'
import { DevicePage } from './index.tsx'
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

export function Section({ form, t, initialKeys, keysFailed }: SectionProps): ReturnType<typeof createElement> {
  // The settings provider replaces the snapshot object on every change, so identity comparison is enough here and no
  // deep equality is needed. The third argument is the server snapshot and it is the same read: the page is only ever
  // server-rendered by this package's tests, and React throws `Missing getServerSnapshot` without it.
  const state = useSyncExternalStore(form.subscribe, form.getSnapshot, form.getSnapshot)
  return createElement(DevicePage, { t, form: { state, mutate: form.mutate }, initialKeys, keysFailed })
}
