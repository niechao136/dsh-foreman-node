/**
 * Where the page registers itself.
 *
 * The move into the settings panel is invisible to the compiler: `plugins.row.config` and `settings.section` are both
 * legal slot names, and a page registered at the wrong one simply does not appear. This file drives `apply` against a
 * fake context and asserts what it asked the host for.
 */
import { expect, it } from 'vitest'
import { apply } from '../src/client/index.tsx'

/** A context that records slot work and resolves `ctx.inject` the way cordis does: the callback runs only when every named service is present. */
function fakeContext(services: string[]) {
  const registered: string[] = []
  const injected: string[][] = []
  const effects: string[] = []
  const ctx = {
    effect: (fn: () => unknown, label?: string) => {
      if (label !== undefined) effects.push(label)
      const off = fn()
      return typeof off === 'function' ? off : () => {}
    },
    locale: { register: () => () => {}, bind: () => () => '' },
    slots: {
      inject: (name: string, run: () => unknown) => { registered.push(name); run() },
      register: (options: { name: string }) => { registered.push(options.name); return () => {} },
    },
    inject: (deps: string[], run: (child: unknown) => void) => {
      injected.push(deps)
      if (deps.every(dep => services.includes(dep))) run(ctx)
    },
  }
  return { ctx, registered, injected, effects }
}

/** A `configForms` face that offers one namespace, as the settings provider does. */
const forms = () => ({
  get: () => ({ getSnapshot: () => ({ status: 'loading' }), subscribe: () => () => {}, mutate: async () => true }),
  whileServed: (namespaces: string[], register: () => unknown) => { register(); return () => {} },
})

/** Runs `apply` with `configForms` present. */
function withForms() {
  const fake = fakeContext(['configForms'])
  Object.assign(fake.ctx, { configForms: forms() })
  apply(fake.ctx as never)
  return fake
}

it('registers a page in the settings panel', () => {
  const { registered } = withForms()
  expect(registered).toContain('settings.section')
})

it('no longer registers a page inside the plugin manager', () => {
  // Two entries for one namespace is the arrangement that lets a save from one form overwrite the other's fields.
  expect(withForms().registered).not.toContain('plugins.row.config')
})

it('registers nothing when the host offers no configForms, so a headless device still boots', () => {
  const { ctx, registered, injected } = fakeContext([])
  apply(ctx as never)
  expect(injected).toContainEqual(['configForms'])
  expect(registered).toEqual([])
})

it('asks for configForms optionally, never as a hard dependency', () => {
  // Declaring it in the module-level `inject` parks the whole package on a service a headless profile never has.
  const { injected } = withForms()
  expect(injected).toContainEqual(['configForms'])
})
