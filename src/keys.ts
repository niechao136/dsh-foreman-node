/**
 * The SSH keys this machine already has, named so a person can pick one.
 *
 * A browser cannot list `~/.ssh`: the page runs in the DSH web UI, which has no filesystem. The device process does,
 * so the listing happens here and the page renders it. Nothing on this path reads a private key: the answer is a
 * filename, a path, and the comment from the public half, which is enough to tell one key from another and is all a
 * page needs.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

/** One key a person may choose: never its contents, only what tells it apart from the others. */
export interface SshKey {
  /** The filename, such as `id_ed25519`. */
  name: string
  /** Its absolute path, which is what the configuration stores. */
  path: string
  /** The trailing comment of the public half, usually `user@machine`; empty when it has none. */
  comment: string
}

/** The `.pub` file that sits beside a private key. */
const publicOf = (path: string): string => `${path}.pub`

/**
 * Lists the usable private keys in a directory.
 *
 * A key counts as usable only when its public half is beside it: that is how `ssh-keygen` writes them, and a private
 * key without one is either half-deleted or was never finished, so offering it would only fail later at the tunnel.
 * Anything unreadable is skipped rather than thrown, because a permissions problem on one file must not empty the list.
 */
export function listKeys(directory: string): SshKey[] {
  let names: string[]
  try { names = readdirSync(directory) } catch { return [] /* No ~/.ssh on this machine is a normal answer, not a failure. */ }
  const keys: SshKey[] = []
  for (const name of names.sort()) {
    if (!name.startsWith('id_') || name.endsWith('.pub')) continue
    const path = join(directory, name)
    if (!existsSync(publicOf(path))) continue
    let comment = ''
    try {
      // `ssh-ed25519 AAAAC3... user@host`: the comment is the third field, and it may be absent.
      const fields = readFileSync(publicOf(path), 'utf8').trim().split(/\s+/)
      comment = fields.slice(2).join(' ')
    } catch { comment = '' /* An unreadable comment costs a label, not the key. */ }
    keys.push({ name: basename(name), path, comment })
  }
  return keys
}
