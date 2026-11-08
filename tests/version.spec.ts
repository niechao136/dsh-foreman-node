/**
 * The version this device announces.
 *
 * The hello frame carries `VERSION`, and the hub decides from it which device build is talking. It was a hand-kept
 * string that drifted three releases behind `package.json` without anything noticing: the field is only read by the
 * hub's logs, so a wrong value produced no symptom anyone would look for.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { VERSION } from '../src/index.ts'

it('announces the version the package actually is', () => {
  const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { version: string }
  expect(VERSION).toBe(manifest.version)
})
