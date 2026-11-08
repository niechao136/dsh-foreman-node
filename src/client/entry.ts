/**
 * The settings entry's identity.
 *
 * `ENTRY_ID` is load-bearing in a way the type system cannot see: `configForms.get(entryId)` looks a form up by the
 * id the profile patch gives the `dsh-foreman-node` row, so a rename here leaves the page subscribed to a namespace
 * the Host never publishes. The symptom is a page stuck on "reading configuration" with no error anywhere, which is
 * why `tests/bundle.spec.ts` reads the real `cordis.patch.yml` and compares.
 */

/** The profile patch row this page edits, which is also the settings namespace it subscribes to. */
export const ENTRY_ID = 'dsh-foreman-node'

/**
 * Where the entry sits in the settings navigation.
 *
 * External tools cluster here: `dsh-config-manager` takes 60 and the built-in Plugins section takes 15. Sitting at 55
 * keeps this page beside the other operational pages instead of inside the built-in group.
 */
export const ENTRY_ORDER = 55

/**
 * The id of the row this package's own bundle patch declares.
 *
 * Reading it back out of the file is the only way to notice a rename on the patch side before someone opens a page
 * that silently edits nothing. A bundle patch nests its rows under `insert`, so the first `- id:` in the document is
 * this package's row; the regex deliberately does not try to parse YAML.
 */
export function assertEntryId(patchText: string): string | undefined {
  return /- id:\s*([A-Za-z0-9_-]+)/.exec(patchText)?.[1]
}
