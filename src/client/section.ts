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

/**
 * The controller the settings provider hands out, as this file needs it.
 *
 * Every member is a method, not a property, because the real `ConfigFormController` is a class: `getSnapshot`,
 * `subscribe` and `mutate` all read `this.store` or `this.writeGeneration`. Passing one of those references around
 * detaches it and the call throws `Cannot read properties of undefined`. Nothing in this file ever reads a member off
 * the controller object once it is mounted.
 */
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
 * The page, subscribed to its form.
 *
 * Both controller members are wrapped in closures rather than passed by reference. `useSyncExternalStore` and
 * `DevicePage` would call them unbound, and the real controller is a class whose methods need `this`; a test double
 * built from arrow properties cannot catch that, which is how an unbound `mutate` reached a real save button and
 * failed as "保存失败" without ever attempting the write.
 */
export function Section({ form, t, initialKeys, keysFailed }: SectionProps): ReturnType<typeof createElement> {
  const subscribe = (listener: () => void): (() => void) => form.subscribe(listener)
  const snapshot = (): ConfigFormSnapshot<Record<string, unknown>> => form.getSnapshot()
  const mutate: FormController['mutate'] = (ops, revision) => form.mutate(ops, revision)
  // The settings provider replaces the snapshot object on every change, so identity comparison is enough here and no
  // deep equality is needed. The third argument is the server snapshot and it is the same read: the page is only ever
  // server-rendered by this package's tests, and React throws `Missing getServerSnapshot` without it.
  const state = useSyncExternalStore(subscribe, snapshot, snapshot)
  return createElement(DevicePage, { t, form: { state, mutate }, initialKeys, keysFailed })
}
