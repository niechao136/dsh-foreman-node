/**
 * What the device's configuration page decides, as pure functions.
 *
 * The page itself is thin React: it renders these results and sends the field edits back through DSH's configuration
 * form. Keeping the decisions here — which keys to offer, what the address becomes, what to say about a failed test —
 * means they are provable without a DOM, which matters for a package this small.
 */
import type { NodeConfig, SshConfig } from '../index.ts'
import type { SshKey } from '../keys.ts'
import type { TestResult } from '../routes.ts'

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
export function emptyFields(config: NodeConfig): string[] {
  const empty: string[] = []
  if (config.ssh.enabled) {
    if (config.ssh.host.trim() === '') empty.push('ssh.host')
    if (config.ssh.port === 0) empty.push('ssh.port')
    if (config.ssh.user.trim() === '') empty.push('ssh.user')
    if (config.ssh.keyPath.trim() === '') empty.push('ssh.keyPath')
  } else if (config.url.trim() === '') empty.push('url')
  if (config.deviceId.trim() === '') empty.push('deviceId')
  if (config.token.trim() === '') empty.push('token')
  return empty
}

/**
 * What to say about one authentication test.
 *
 * A passphrase-protected key fails with the same words as a wrong one, so the message names both possibilities; the
 * other failures are ssh's own and are shown as they are, which is enough for someone who can read them.
 */
export function testMessage(result: TestResult): string {
  if (result.ok) return 'ok'
  if (/Permission denied \(publickey/.test(result.output)) return 'passphrase'
  if (/Could not resolve hostname/.test(result.output)) return 'unresolved'
  if (/timed out/i.test(result.output)) return 'timeout'
  return result.output.trim() === '' ? 'refused' : result.output
}

/** The values the page writes back, trimmed so a stray space does not become part of a token. */
export function configOf(draft: NodeConfig): Record<string, unknown> {
  return { url: draft.url.trim(), deviceId: draft.deviceId.trim(), token: draft.token.trim(),
    roots: draft.roots.map(root => ({ project: root.project.trim(), path: root.path.trim() })),
    ssh: { ...draft.ssh, host: draft.ssh.host.trim(), user: draft.ssh.user.trim(), keyPath: draft.ssh.keyPath.trim() } }
}

/** The SSH block a fresh page starts from, matching the schema's defaults so an untouched field is not a change. */
export const DEFAULT_SSH: SshConfig = { enabled: false, host: '', port: 22, user: '', keyPath: '', remotePort: 8790, localPort: 8790 }
