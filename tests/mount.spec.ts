/**
 * What `apply` actually mounts, driven end to end.
 *
 * Every other test here hands the page a hand-built object. That is exactly how two real defects survived a green
 * suite: the settings provider's controller is a *class*, and its `getSnapshot`/`subscribe`/`mutate` live on the
 * prototype and need their `this`. A double built from arrow properties is pre-bound, so it cannot fail the way the
 * real one does. This file uses a class-shaped double and renders whatever `apply` registered.
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { apply } from '../src/client/index.tsx'
import { zh } from '../src/client/locales.ts'

const t = (key: keyof typeof zh): string => zh[key]

/** The real provider's shape: methods on the prototype, state behind `this`. */
class Controller {
  private snap: Record<string, unknown>
  writes = 0

  constructor(snap: Record<string, unknown>) { this.snap = snap }

  getSnapshot(): never { return this.snap as never }
  subscribe(_listener: () => void): () => void { return () => {} }
  async mutate(): Promise<boolean> { this.writes++; return true }
}

/** A context whose `inject` runs the callback with a child context, as cordis does. */
function fakeContext(controller: Controller) {
  const registered: { name: string; component?: () => unknown }[] = []
  const childEffects: string[] = []
  const outerEffects: string[] = []
  const child = {
    effect: (fn: () => unknown, label?: string) => {
      if (label !== undefined) childEffects.push(label)
      const off = fn()
      return typeof off === 'function' ? off : () => {}
    },
    slots: {
      inject: (_name: string, run: () => unknown) => { run() },
      register: (options: { name: string }, component: () => unknown) => {
        registered.push({ name: options.name, component }); return () => {}
      },
    },
    configForms: {
      get: () => controller,
      whileServed: (_namespaces: string[], register: () => () => void) => { register(); return () => {} },
    },
  }
  const ctx = {
    effect: (fn: () => unknown, label?: string) => {
      if (label !== undefined) outerEffects.push(label)
      const off = fn()
      return typeof off === 'function' ? off : () => {}
    },
    locale: { register: () => () => {}, bind: () => t },
    slots: child.slots,
    inject: (_deps: string[], run: (c: unknown) => void) => { run(child) },
  }
  return { ctx, registered, childEffects, outerEffects }
}

const ready = { status: 'ready', value: { url: 'wss://hub.example', deviceId: 'pc', token: '', roots: [],
  heartbeatMs: 15_000, reconnectMs: 1_000, ssh: { enabled: false, host: '', port: 22, user: '', keyPath: '',
    remotePort: 8790, localPort: 8790 } }, base: undefined, user: undefined, revision: 1, writable: true, mode: 'host' }

it('mounts a page that renders the saved configuration, not an error', () => {
  // Before the fix this threw `Cannot read properties of undefined (reading 'value')`: `apply` passed the raw
  // controller where the page expected `{ state, mutate }`, so opening the settings page blanked the panel.
  const { ctx, registered } = fakeContext(new Controller(ready))
  apply(ctx as never)
  const section = registered.find(entry => entry.name === 'settings.section')
  expect(section?.component).toBeDefined()
  const markup = renderToStaticMarkup(createElement(section!.component as () => JSX.Element))
  expect(markup).toContain('data-foreman-node-page="ready"')
})

it('does not crash on a controller whose methods need their receiver', () => {
  // The unbound-method variant: `Section` used to hand `form.getSnapshot` and `form.mutate` straight through, which
  // detaches them from the instance. This controller throws if `this` is undefined, so the render would fail.
  const { ctx, registered } = fakeContext(new Controller(ready))
  apply(ctx as never)
  const markup = renderToStaticMarkup(createElement(registered.find(e => e.name === 'settings.section')!
    .component as () => JSX.Element))
  expect(markup).toContain('data-node-save')
})

it('owns the whileServed watch on the injected fiber, not the outer one', () => {
  // `ctx.inject` starts a child plugin with its own fiber. Registering the watch on the outer context leaks the
  // settings page past the lifetime of the service it depends on.
  const { ctx, childEffects, outerEffects } = fakeContext(new Controller(ready))
  apply(ctx as never)
  expect(childEffects).toContain('dsh-foreman-node: settings page')
  expect(outerEffects).not.toContain('dsh-foreman-node: settings page')
})
