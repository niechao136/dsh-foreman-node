/**
 * The device's own tunnel to a hub it cannot reach directly.
 *
 * The hub listens on loopback only, on purpose: its ledger is the one thing worth protecting, and a publicly bound
 * port would make the device token the only thing between it and the internet. So a device on another machine
 * reaches it by opening a local port that `ssh -L` forwards to the hub's own loopback port.
 *
 * This class owns exactly one child process and nothing else. It does not know what the hub is for, does not build
 * frames, and does not retry the connection inside the tunnel — the NodeClient above it does that. Its whole job is
 * "there is a port on localhost that reaches the hub, and it stays that way", reported as a state a page can show.
 */
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { connect } from 'node:net'
import type { SshConfig } from './index.ts'

/** Where the tunnel is, in the only terms a person needs: not yet, trying, working, broken. */
export type TunnelState = 'idle' | 'connecting' | 'connected' | 'failed'

/** The minimum of a spawned process this class uses, so a test never starts a real ssh. */
export interface TunnelChild {
  killed: boolean
  kill(signal?: NodeJS.Signals): boolean
  on(event: 'exit', listener: (code: number | null) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  stderr?: { on(event: 'data', listener: (chunk: Buffer) => void): unknown } | null
}

export type SpawnTunnel = (argv: readonly string[]) => TunnelChild

/** Resolves whether something accepts a TCP connection on a local port. */
export type ProbePort = (port: number) => Promise<boolean>

export interface TunnelInput {
  ssh: SshConfig
  spawn?: SpawnTunnel
  probe?: ProbePort
  /** Called on every state change, so the page and the log see the same transitions the client acts on. */
  onState?: (state: TunnelState, failure?: string) => void
  log?: (text: string) => void
  /** Delay before the first retry, in milliseconds; doubles each time up to `maxRetryMs`. */
  retryMs?: number
  maxRetryMs?: number
}

/** How long to wait for the local port to start answering before calling the attempt a failure. */
const READY_TIMEOUT_MS = 10_000
/** How often to ask whether the port answers yet. */
const READY_POLL_MS = 200
/** How much of ssh's stderr to keep: enough for the reason, not enough to grow without bound. */
const STDERR_KEEP = 2_048
/** `-N` forks no command, `-T` allocates no terminal: this process exists only to carry the forward. */
export const TUNNEL_FLAGS = ['-N', '-T'] as const
/**
 * The options that make a failure a failure.
 *
 * `BatchMode=yes` refuses to prompt, because nothing is there to answer and a prompt would hang forever.
 * `ExitOnForwardFailure=yes` makes a forward that cannot be set up kill the process instead of leaving a live ssh
 * that forwards nothing — the failure that would otherwise only show up as "the hub is offline".
 * The keepalives let a dead link be noticed rather than waiting for a TCP timeout nobody is watching.
 */
export const TUNNEL_OPTIONS = ['-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30',
  '-o', 'ServerAliveCountMax=3'] as const

/** The argv of the forwarding process, in order, exactly as the tests pin it. */
export function tunnelArgs(ssh: SshConfig): string[] {
  return ['ssh', ...TUNNEL_FLAGS, ...TUNNEL_OPTIONS, '-p', String(ssh.port), '-i', ssh.keyPath,
    '-L', `${ssh.localPort}:127.0.0.1:${ssh.remotePort}`, `${ssh.user}@${ssh.host}`]
}

/**
 * Turns ssh's own words into something a person can act on.
 *
 * Both of these would otherwise read as a bare "the tunnel stopped", and both have a specific fix. Reprinting the
 * ssh text is not enough: it names the mechanism, not the move.
 */
export function explain(ssh: SshConfig, stderr: string): string {
  const said = stderr.trim().split('\n').slice(-3).join(' ').trim()
  const tail = said === '' ? '' : ` (ssh said: ${said})`
  if (/Permission denied \(publickey/.test(stderr)) {
    return `the hub refused this key; if it has a passphrase, add it to ssh-agent or pick a key without one${tail}`
  }
  if (/Address already in use|bind \[.*\]:\d+: Address already in use|Could not request local forwarding/.test(stderr)) {
    return `local port ${ssh.localPort} is already in use; close whatever holds it, or set a different localPort${tail}`
  }
  if (/Could not resolve hostname/.test(stderr)) {
    return `the hub machine ${ssh.host} could not be resolved; check the host name${tail}`
  }
  if (/Host key verification failed/.test(stderr)) {
    return `the hub machine's host key is not in this machine's known_hosts; connect once from a terminal to accept it${tail}`
  }
  return `the tunnel to ${ssh.host} stopped${said === '' ? '' : `: ${said}`}`
}

/** The default spawn: a real ssh, with stderr piped because that is where the reason lives. */
const realSpawn: SpawnTunnel = argv => nodeSpawn(argv[0]!, argv.slice(1),
  { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }) as unknown as ChildProcess & TunnelChild

/** The default probe: can something be connected to on this local port right now? */
const realProbe: ProbePort = port => new Promise(resolve => {
  const socket = connect({ host: '127.0.0.1', port })
  const done = (result: boolean) => { socket.destroy(); resolve(result) }
  socket.setTimeout(2_000, () => done(false))
  socket.once('connect', () => done(true))
  socket.once('error', () => done(false))
})

/**
 * Keeps one forwarding process alive, reporting what it is doing.
 *
 * A retry is always a *new* process: an ssh that exited cannot be revived, and reusing the object would report a
 * state no process is in. `stop()` is idempotent and leaves nothing behind, including a pending retry timer.
 */
export class Tunnel {
  private current: TunnelState = 'idle'
  private lastFailure: string | undefined
  private child: TunnelChild | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  /** A generation counter, so a late callback from a superseded attempt cannot overwrite the current state. */
  private generation = 0
  private retryMs: number
  private readonly maxRetryMs: number
  private readonly spawn: SpawnTunnel
  private readonly probe: ProbePort

  constructor(private readonly input: TunnelInput) {
    this.spawn = input.spawn ?? realSpawn
    this.probe = input.probe ?? realProbe
    this.retryMs = input.retryMs ?? 1_000
    this.maxRetryMs = input.maxRetryMs ?? 60_000
  }

  state(): TunnelState { return this.current }
  /** Why the last attempt failed, already rewritten into something a person can act on. */
  failure(): string | undefined { return this.lastFailure }

  /** Start the first attempt, or do nothing if one is already running. */
  start(): void {
    if (this.current === 'connecting' || this.current === 'connected') return
    this.attempt()
  }

  /** End the process and any pending retry; safe to call more than once. */
  stop(): void {
    this.generation++
    if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined }
    const child = this.child
    this.child = undefined
    if (child !== undefined && !child.killed) child.kill('SIGTERM')
    this.set('idle')
  }

  /** One attempt: spawn, wait for the local port, then either stay connected or fail and schedule a retry. */
  private attempt(): void {
    const generation = ++this.generation
    this.set('connecting')
    const argv = tunnelArgs(this.input.ssh)
    let stderr = ''
    let settled = false
    let child: TunnelChild
    try { child = this.spawn(argv) }
    catch (error) { this.fail(generation, `could not start ssh: ${String(error)}`); return }
    this.child = child
    const collect = (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_KEEP) }
    child.stderr?.on('data', collect)
    child.on('error', (error: Error) => { if (!settled) { settled = true; this.fail(generation, `could not start ssh: ${error.message}`) } })
    child.on('exit', code => {
      if (settled || generation !== this.generation) return
      settled = true
      // A clean exit still means the tunnel is gone; only its wording differs.
      this.fail(generation, code === null || code === 0 ? `the tunnel to ${this.input.ssh.host} closed` : explain(this.input.ssh, stderr))
    })
    void this.waitReady(generation, () => settled, () => { settled = true })
  }

  /** Poll the local port until it answers or the attempt is superseded; a first answer means the forward works. */
  private async waitReady(generation: number, settled: () => boolean, markSettled: () => void): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (generation !== this.generation || settled()) return
      if (await this.probe(this.input.ssh.localPort)) {
        if (generation !== this.generation || settled()) return
        markSettled()
        // The forward works, so the retry delay starts over: one good minute should not be followed by a long wait.
        this.retryMs = this.input.retryMs ?? 1_000
        this.lastFailure = undefined
        this.set('connected')
        return
      }
      await new Promise(resolve => setTimeout(resolve, READY_POLL_MS))
    }
    if (generation !== this.generation || settled()) return
    markSettled()
    this.fail(generation, `the tunnel to ${this.input.ssh.host} did not start listening on port ${this.input.ssh.localPort}`
      + ` within ${READY_TIMEOUT_MS / 1000} seconds`)
  }

  /** Record a failure, release the process, and schedule the next attempt with a growing delay. */
  private fail(generation: number, message: string): void {
    if (generation !== this.generation) return
    this.lastFailure = message
    const child = this.child
    this.child = undefined
    if (child !== undefined && !child.killed) child.kill('SIGKILL')
    this.set('failed', message)
    this.input.log?.(`dsh-foreman-node tunnel: ${message}; retrying in ${Math.round(this.retryMs / 1000)}s`)
    const delay = this.retryMs
    this.retryMs = Math.min(this.retryMs * 2, this.maxRetryMs)
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (generation !== this.generation) return
      this.attempt()
    }, delay)
    // A pending retry must not be the only thing keeping the host process alive.
    this.timer.unref?.()
  }

  private set(state: TunnelState, failure?: string): void {
    this.current = state
    this.input.onState?.(state, failure)
  }
}
