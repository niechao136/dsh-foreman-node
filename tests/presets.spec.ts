/**
 * The preset list the page's picker is built from.
 *
 * The field used to be a free-text box, so a name that the host does not have could only be discovered when a job
 * arrived and `session.ts` fell back to `workspace-write`. These tests pin the two decisions that keep the dropdown
 * honest: a saved value the host no longer offers stays selected, and a host that cannot be asked still answers
 * something usable.
 */
import { expect, it } from 'vitest'
import { BUILT_IN_PRESETS, builtInAnswer, presetChoices } from '../src/presets.ts'

it('offers the three presets a composition always has when there is no catalog', () => {
  const answer = builtInAnswer()
  expect(answer.source).toBe('built-in')
  expect(answer.defaultPreset).toBe('workspace-write')
  expect(answer.options.map(option => option.value)).toEqual(BUILT_IN_PRESETS.map(option => option.value))
  // The page renders these as a picker, so a missing label would show a blank row.
  expect(answer.options.every(option => option.name.trim() !== '')).toBe(true)
})

it('keeps the saved preset selected and adds nothing when the host offers it', () => {
  const choice = presetChoices('read-only', builtInAnswer())
  expect(choice.unknown).toBeUndefined()
  expect(choice.options.map(option => option.value)).toEqual(BUILT_IN_PRESETS.map(option => option.value))
})

it('keeps a saved preset the host no longer offers, and reports it', () => {
  // Blanking the picker here would rewrite the field on the next save: a device configured under a preset the host
  // has since dropped must still show what it is actually running under.
  const choice = presetChoices('workspace-write-never-ask', { options: [{ value: 'workspace-write',
    name: 'workspace-write' }], defaultPreset: 'workspace-write', source: 'host' })
  expect(choice.unknown).toBe('workspace-write-never-ask')
  expect(choice.options[0]).toEqual({ value: 'workspace-write-never-ask', name: 'workspace-write-never-ask' })
  expect(choice.options.map(option => option.value)).toContain('workspace-write')
})

it('treats an empty saved value as "unset" rather than as an unknown preset', () => {
  // Empty means the schema default, and `editsOf` skips the field for it, so there is nothing to warn about.
  const choice = presetChoices('   ', builtInAnswer())
  expect(choice.unknown).toBeUndefined()
  expect(choice.options).toHaveLength(BUILT_IN_PRESETS.length)
})

it('uses the host default rather than the built-in one when a catalog answered', () => {
  const choice = presetChoices('read-only', { options: [{ value: 'read-only', name: 'read-only' }],
    defaultPreset: 'danger-full-access', source: 'host' })
  expect(choice.defaultPreset).toBe('danger-full-access')
})
