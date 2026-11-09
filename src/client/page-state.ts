/**
 * What the device's configuration page decides, as pure functions.
 *
 * The page itself is thin React: it renders these results and sends the field edits back through DSH's configuration
 * form. Keeping the decisions here — which keys to offer, what the address becomes, what to say about a failed test —
 * means they are provable without a DOM, which matters for a package this small.
 */
import type { NodeConfig, SshConfig } from '../config.ts'
import { EXPOSE_DEFAULTS } from '../config.ts'
import type { SshKey } from '../keys.ts'
import type { PortCheckAnswer, TestResult } from '../routes.ts'

/** A key as one line of the picker: the filename and, when it has one, the comment that tells it apart. */
export function keyLabel(key: SshKey): string {
  return key.comment === '' ? key.name : `${key.name} · ${key.comment}`
}

/**
 * The address the device will dial, spelled out for the page.
 *
 * With the tunnel on this is the local end of it and `url` is not used — which is the point a person most easily
 * gets wrong, so the page says the address rather than leaving them to infer it.
 */
export function addressPreview(config: Pick<NodeConfig, 'url' | 'ssh'>): { address: string; derived: boolean } {
  return config.ssh.enabled
    ? { address: `ws://127.0.0.1:${config.ssh.localPort}`, derived: true }
    : { address: config.url, derived: false }
}

/**
 * The names of the fields that still have to be filled in, in the order the page shows them.
 *
 * This mirrors `missingConfiguration` for the page's benefit: the host reports the same thing in one sentence, and a
 * form that highlights the empty field is the difference between reading a sentence and fixing it.
 */
export function emptyFields(config: NodeConfig, tokenPresent = true): string[] {
  const empty: string[] = []
  if (config.ssh.enabled) {
    if (config.ssh.host.trim() === '') empty.push('ssh.host')
    if (config.ssh.port === 0) empty.push('ssh.port')
    if (config.ssh.user.trim() === '') empty.push('ssh.user')
    if (config.ssh.keyPath.trim() === '') empty.push('ssh.keyPath')
  } else if (config.url.trim() === '') empty.push('url')
  if (config.deviceId.trim() === '') empty.push('deviceId')
  // Publishing needs the same four connection details the tunnel does, whether or not the tunnel itself is on: the
  // reverse forward is its own ssh process against the same hub.
  if (config.expose?.enabled === true && !config.ssh.enabled) {
    if (config.ssh.host.trim() === '') empty.push('ssh.host')
    if (config.ssh.user.trim() === '') empty.push('ssh.user')
    if (config.ssh.keyPath.trim() === '') empty.push('ssh.keyPath')
  }
  // The token is a secret: it never reaches the page, so an absent value means "already stored", not "missing".
  // A page that asked for it here would nag about a field it cannot see and cannot show.
  if (!tokenPresent) empty.push('token')
  return empty
}

/**
 * What to say about one authentication test.
 *
 * A passphrase-protected key fails with the same words as a wrong one, so the message names both possibilities; the
 * other failures are ssh's own and are shown as they are, which is enough for someone who can read them.
 */
/** Whether the page should ask for a token: only when nothing is stored yet. */
export function needsToken(config: Pick<NodeConfig, 'token'>): boolean {
  return typeof config.token !== 'string' || config.token.trim() === ''
}

export function testMessage(result: TestResult): string {
  if (result.ok) return 'ok'
  if (/Permission denied \(publickey/.test(result.output)) return 'passphrase'
  if (/Could not resolve hostname/.test(result.output)) return 'unresolved'
  if (/timed out/i.test(result.output)) return 'timeout'
  return result.output.trim() === '' ? 'refused' : result.output
}

/** One field write, in the shape DSH's configuration form takes. */
export interface Edit { op: 'set'; path: (string | number)[]; value: unknown }

/**
 * The edits the page sends, one `set` per field it actually holds.
 *
 * This is deliberately not one `set` at the root. A root write replaces the whole section, and the page never
 * receives the token — the host strips it as a secret — so a root write erased the stored token on every save and
 * left the device unable to authenticate. It did exactly that on a real machine: one save took the device offline.
 *
 * Writing only the fields this page holds leaves every other key untouched, the token included. An empty token box
 * means "keep whatever is stored", and that is one value the page cannot read at all.
 */
export function editsOf(draft: NodeConfig): Edit[] {
  const edits: Edit[] = [
    { op: 'set', path: ['url'], value: draft.url.trim() },
    { op: 'set', path: ['deviceId'], value: draft.deviceId.trim() },
    { op: 'set', path: ['roots'], value: draft.roots.map(root => ({ project: root.project.trim(), path: root.path.trim() })) },
  ]
  // The ssh block is written field by field: a whole-block set would replace its default with the page's view.
  for (const key of ['enabled', 'host', 'port', 'user', 'keyPath', 'remotePort', 'localPort'] as const) {
    const value = draft.ssh[key]
    edits.push({ op: 'set', path: ['ssh', key], value: typeof value === 'string' ? value.trim() : value })
  }
  // The same rule for `expose`, and for the same reason: a whole-block set would replace its default with `{}`.
  // Defaults are applied here too, because a section saved before this block existed has no `expose` at all and the
  // page must still write a complete one rather than `undefined` into the patch.
  const expose = { ...DEFAULT_EXPOSE, ...draft.expose }
  edits.push({ op: 'set', path: ['expose', 'enabled'], value: expose.enabled })
  edits.push({ op: 'set', path: ['expose', 'remotePort'], value: expose.remotePort })
  // `jobPreset` has always been in the schema and has never had a field on this page, so the only way to set it was
  // to edit the profile's patch by hand. An empty box means "whatever the schema defaults to", not "unset it".
  const preset = typeof draft.jobPreset === 'string' ? draft.jobPreset.trim() : ''
  if (preset !== '') edits.push({ op: 'set', path: ['jobPreset'], value: preset })
  const token = typeof draft.token === 'string' ? draft.token.trim() : ''
  if (token !== '') edits.push({ op: 'set', path: ['token'], value: token })
  return edits
}

/** The SSH block a fresh page starts from, matching the schema's defaults so an untouched field is not a change. */
export const DEFAULT_SSH: SshConfig = { enabled: false, host: '', port: 22, user: '', keyPath: '', remotePort: 8790, localPort: 8790 }

/** The publishing block a fresh page starts from, for the same reason. */
export const DEFAULT_EXPOSE = EXPOSE_DEFAULTS

/**
 * The two addresses this machine's page can be opened at.
 *
 * They answer different questions and a page that showed one for both would send people to a dead link half the
 * time: `local` is the port DSH was actually given on this machine and is the only one that opens here, while
 * `published` is what someone on the hub types because that port exists on the hub's loopback, not on this one.
 *
 * `token` is appended when the device process could mint one. Without a connection service it is undefined, and the
 * URLs are still useful as a checklist — they are just not one-click.
 */
export function accessAddresses(input: { localPort: number | undefined; protocol: 'http:' | 'https:'
  token: string | undefined; expose: { enabled: boolean; remotePort: number } }): { local?: string; published?: string } {
  const suffix = input.token === undefined ? '/' : `/?token=${input.token}`
  const local = input.localPort === undefined ? undefined : `${input.protocol}//127.0.0.1:${input.localPort}${suffix}`
  const published = input.expose?.enabled === true ? `http://127.0.0.1:${input.expose.remotePort}${suffix}` : undefined
  return { local, published }
}

/**
 * Whether the port check found the port free, taken, or could not tell.
 *
 * The third answer is kept apart from the second on purpose: a check that could not run is not permission to save,
 * and a page that collapsed the two would send people to a hub that already holds the port.
 */
export function portVerdict(answer: PortCheckAnswer): 'busy' | 'free' | 'unknown' {
  return answer.port
}

/**
 * Whether the hub needs to be told to enable its SSH keepalive.
 *
 * A hub with `ClientAliveInterval 0` never probes an idle connection, so a device that loses its network leaves the
 * published port bound on the hub until TCP gives up — minutes to hours, during which every reconnect attempt fails
 * on a port the hub still thinks it holds. This is reported rather than fixed: the file belongs to the hub's
 * administrator, and a device that edited sshd configuration on another machine would be a worse problem than the
 * one it solved.
 */
export function keepaliveMissing(answer: PortCheckAnswer): boolean {
  return answer.clientAliveInterval <= 0
}

