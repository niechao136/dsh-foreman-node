/**
 * The permission presets a job can run under, as one definition the host route and the page share.
 *
 * The page used to offer a free-text box here, which meant a typo was only found when a job arrived: `session.ts`
 * then warned and fell back to `workspace-write`, so the page said one thing and the device did another. The list a
 * person picks from has to be the host's own catalog — which lives behind a service only the device process can
 * reach — so this module holds the two pieces both sides need: the shape the route answers with, and the built-in
 * table to fall back on when the service is not there.
 *
 * No Node imports, deliberately: the page imports this file, and reaching `node:*` from the browser bundle is what
 * broke the first 0.2.0 build.
 */

/** One selectable preset, shaped like the host's own `PresetOption` so the route needs no translation. */
export interface PresetOption {
  /** The value written into the configuration: a preset key the host knows. */
  value: string
  /** The label shown in the picker. */
  name: string
  /** One sentence on what the value means, when the host has one. */
  description?: string
}

/** What `GET /foreman-node/api/presets` answers. */
export interface PresetAnswer {
  /** Every preset this host can run a job under, in the host's own order. */
  options: PresetOption[]
  /** The preset that applies when the field is left empty. */
  defaultPreset: string
  /** Where the list came from: the host's catalog, or the built-in table in this file. */
  source: 'host' | 'built-in'
}

/**
 * The presets shipped with DSH, for a host whose catalog cannot be read.
 *
 * These three are the ones the composition always contributes; a profile patch may add more. Offering a shorter list
 * than the host actually has hides a choice, which is why the route prefers the catalog whenever it can read one.
 */
export const BUILT_IN_PRESETS: readonly PresetOption[] = [
  { value: 'read-only', name: 'read-only',
    description: 'Read anything, write nothing. A job that has to change a file stops and asks.' },
  { value: 'workspace-write', name: 'workspace-write',
    description: 'Write inside the workspace and permitted temporary directories; wider retries require approval.' },
  { value: 'danger-full-access', name: 'danger-full-access',
    description: 'Full file access without approval prompts.' },
]

/** The preset the schema defaults to, and the one a job falls back to when the configured name is unknown. */
export const FALLBACK_PRESET = 'workspace-write'

/** The answer for a host with no readable catalog. */
export function builtInAnswer(): PresetAnswer {
  return { options: BUILT_IN_PRESETS.map(option => ({ ...option })), defaultPreset: FALLBACK_PRESET,
    source: 'built-in' }
}

/**
 * The list to put in the picker, keeping a saved value the host does not offer.
 *
 * The saved value matters more than the list: a device already running under a preset that the host's table no longer
 * carries must not open an empty picker, because the next save from an empty picker would rewrite that field. It stays
 * selected, and `unknown` tells the page to say so rather than pretend it was a free choice.
 */
export function presetChoices(saved: string, answer: PresetAnswer | undefined): {
  options: PresetOption[]
  unknown: string | undefined
  defaultPreset: string
} {
  const base = answer ?? builtInAnswer()
  const value = saved.trim()
  const known = base.options.some(option => option.value === value)
  const unknown = value !== '' && !known ? value : undefined
  return {
    options: unknown === undefined ? [...base.options] : [{ value: unknown, name: unknown }, ...base.options],
    unknown,
    defaultPreset: base.defaultPreset,
  }
}
