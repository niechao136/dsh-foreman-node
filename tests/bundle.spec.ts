/**
 * What the browser bundle is allowed to require.
 *
 * The first 0.2.0 build failed to boot with `dsh-foreman-node: import failed`, because the client page imported a
 * value from the Node entry and the bundle ended up requiring `@deepseek-ai/dsh-llm` — a module a browser has no way
 * to resolve. Nothing in the unit tests noticed, because they never load the bundle the way the host does.
 *
 * This test reads the built file and pins the shape: a browser bundle may require React and nothing else.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { assertEntryId, ENTRY_ID } from '../src/client/entry.ts'

const bundlePath = join(import.meta.dirname, '..', 'lib', 'client.js')

it('requires nothing but react from the client bundle', () => {
  // A missing bundle means `pnpm build` has not run; that is a build-order problem, not a pass.
  if (!existsSync(bundlePath)) throw new Error(`${bundlePath} is missing: run the build before this test`)
  const source = readFileSync(bundlePath, 'utf8')
  const required = [...source.matchAll(/require\("([^"]+)"\)/g)].map(match => match[1]!)
  expect([...new Set(required)].sort()).toEqual(['react', 'react/jsx-runtime'])
})

it('wraps itself in the loader the host expects', () => {
  const source = readFileSync(bundlePath, 'utf8')
  expect(source).toContain('window.__ModuleLoader__.load')
  expect(source).toContain('"dsh-foreman-node"')
})

it('never reaches for a Node-only module', () => {
  const source = readFileSync(bundlePath, 'utf8')
  // A browser bundle that touches these loads nowhere.
  for (const forbidden of ['node:net', 'node:child_process', 'node:fs', 'node:os', 'node:path']) {
    expect(source).not.toContain(forbidden)
  }
})

it('keeps the settings entry named after the row the profile actually declares', () => {
  // A mismatch here has no compile-time symptom and no runtime error: the page would simply stay on "reading
  // configuration" forever, because `configForms` keys forms by the patch row's id.
  const patch = readFileSync(join(import.meta.dirname, '..', 'cordis.patch.yml'), 'utf8')
  expect(assertEntryId(patch)).toBe(ENTRY_ID)
})

it('no longer registers the plugin-manager page it used to mount', () => {
  // The slot name survives in the bundle only as a string constant; a leftover registration would mean two forms
  // editing one namespace, which is the arrangement that lets a save from one overwrite the other's fields.
  const source = readFileSync(bundlePath, 'utf8')
  expect(source).not.toContain('plugins.row.config')
})
