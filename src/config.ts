/**
 * The device's configuration shape, with no Node imports.
 *
 * This module exists so the browser page and the Node plugin can share one definition. The page must not import
 * `index.ts`: that file pulls in `node:net`, `node:child_process` and the job-session code, and a browser bundle that
 * reaches them fails to load at boot — which is exactly how the first 0.2.0 build broke.
 */

/** One project this device can work on: the hub's logical name and this machine's own absolute path. */
export interface NodeRoot { project: string; path: string }

/**
 * How the device reaches a hub it cannot reach directly.
 *
 * The hub listens on loopback only — a deliberate constraint, because the ledger is the one thing worth protecting —
 * so a device on another machine reaches it through a tunnel. With `enabled` the device opens that tunnel itself and
 * dials its own end of it; `url` is then unused, not overridden, so switching back to a direct address restores it.
 */
export interface SshConfig {
  /** Open a tunnel to the hub instead of dialling `url` directly. */
  enabled: boolean
  /** The hub machine: an address or a `~/.ssh/config` alias. */
  host: string
  /** The hub machine's SSH port. */
  port: number
  /** The SSH user on the hub machine. */
  user: string
  /** The private key this device authenticates with. The configuration page lists these from `~/.ssh`. */
  keyPath: string
  /** The port the hub listens on, on the hub machine. */
  remotePort: number
  /** The local port the tunnel listens on; the device dials this. */
  localPort: number
}

/** What the `dsh-foreman-node` entry in a profile's patch configures. */
export interface NodeConfig {
  /** The hub's stable address; the device dials out to it. Blank until someone fills it in. */
  url: string
  /** This device's id, as registered on the hub with `Devices.add`. Blank until someone fills it in. */
  deviceId: string
  /** This device's token; sent in the hello and nowhere else. Blank until someone fills it in. */
  token: string
  /** The projects this device can work on. */
  roots: NodeRoot[]
  /** How often to tell the hub this device is alive, in milliseconds. */
  heartbeatMs: number
  /** Delay before the first reconnect attempt, in milliseconds. */
  reconnectMs: number
  /** How to reach a hub that is not directly reachable. */
  ssh: SshConfig
}

/** The SSH defaults, spread over whatever the host hands in, so a partial block is still complete. */
export const SSH_DEFAULTS: SshConfig = { enabled: false, host: '', port: 22, user: '', keyPath: '', remotePort: 8790, localPort: 8790 }

/** A volatile field arrives wrapped; this reads it either way, so callers do not have to know which. */
const valueOf = <T>(field: T | { get(): T } | undefined, fallback: T): T => {
  if (field === undefined) return fallback
  if (typeof field === 'object' && field !== null && 'get' in field && typeof (field as { get?: unknown }).get === 'function') {
    return (field as { get(): T }).get()
  }
  return field as T
}

/**
 * Unwrap a whole configuration: every field may be a volatile wrapper, a plain value, or absent.
 *
 * `Config` already applies defaults, so `apply` sees a complete object. This is for the paths that do not go through
 * the schema: the configuration page's read, and a `cordis.patch.yml` written before a field existed.
 */
/**
 * Unwrap the `ssh` block.
 *
 * Its fields are volatile for the same reason the top level is, so each may arrive wrapped. Reading them all through
 * `valueOf` keeps one unwrapping rule instead of two, and it means a plain partial block (an older patch file) works
 * just as well as a wrapped one.
 */
function unwrapSsh(block: unknown): Partial<SshConfig> {
  if (block === null || typeof block !== 'object') return {}
  const source = block as Record<string, unknown>
  return {
    enabled: valueOf(source['enabled'] as boolean, SSH_DEFAULTS.enabled),
    host: valueOf(source['host'] as string, SSH_DEFAULTS.host),
    port: valueOf(source['port'] as number, SSH_DEFAULTS.port),
    user: valueOf(source['user'] as string, SSH_DEFAULTS.user),
    keyPath: valueOf(source['keyPath'] as string, SSH_DEFAULTS.keyPath),
    remotePort: valueOf(source['remotePort'] as number, SSH_DEFAULTS.remotePort),
    localPort: valueOf(source['localPort'] as number, SSH_DEFAULTS.localPort),
  }
}

export function configured(config: object | undefined): NodeConfig {
  const source = (config ?? {}) as Record<string, unknown>
  return { url: valueOf(source['url'] as string, ''), deviceId: valueOf(source['deviceId'] as string, ''),
    token: valueOf(source['token'] as string, ''), roots: valueOf(source['roots'] as NodeRoot[], []),
    heartbeatMs: valueOf(source['heartbeatMs'] as number, 15_000), reconnectMs: valueOf(source['reconnectMs'] as number, 1_000),
    // `ssh` holds volatile fields too, so each one is unwrapped like the top level.
    ssh: { ...SSH_DEFAULTS, ...unwrapSsh(source['ssh']) } }
}
