/**
 * This machine's own web port, published on the hub.
 *
 * The tunnel in `tunnel.ts` answers "how does this device reach the hub", which is a forward: a local port that
 * leads out. This is the other direction, and a different feature: someone on the hub wants to open this machine's
 * configuration page, and this machine is behind NAT, so it has no address to give them. `ssh -R` asks the hub to
 * listen on a port of its own loopback and carry what arrives back here.
 *
 * It is deliberately a separate class rather than a mode of `Tunnel`. The two differ in the one thing that decides
 * how a failure is noticed: a forward can be probed on a local port, a reverse forward cannot — the port it opens
 * belongs to the hub's loopback, which this machine cannot dial. Sharing one implementation would mean sharing a
 * readiness check that is wrong for one of them.
 *
 * Publishing is optional and its failure is contained: nothing here reports a state the job path depends on, so a
 * hub that refuses the port costs the device its page, not its work.
 */
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import type { SshConfig } from './config.ts'

/** Where the published port is, in the only terms a person needs: not yet, trying, working, broken. */
export type ExposeState = 'idle' | 'connecting' | 'connected' | 'failed'

/** The minimum of a spawned process this class uses, so a test never starts a real ssh. */
export interface ExposeChild {
  killed: boolean
  kill(signal?: NodeJS.Signals): boolean
  on(event: 'exit', listener: (code: number | null) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  stderr?: { on(event: 'data', listener: (chunk: Buffer) => void): unknown } | null
}

export type SpawnExpose = (argv: readonly string[]) => ExposeChild

export interface ExposeInput {
  ssh: SshConfig
  /** The port the hub should listen on, on its own loopback. */
  remotePort: number
  /**
   * This machine's web port, read at every attempt rather than captured once.
   *
   * The port is assigned by the operating system when DSH starts, so it is not a value anyone can write down: a
   * plugin that captured it at activation would keep publishing a port that stopped listening after the next
   * restart, and the forward would look healthy while carrying nothing. `undefined` means the web server is not up
   * yet, which is a reason to retry rather than a reason to give up.
   */
  localPort: () => number | undefined
  spawn?: SpawnExpose
  /** Called on every state change, so the page and the log see the same transitions. */
  onState?: (state: ExposeState, failure?: string) => void
  log?: (text: string) => void
  /** Delay before the first retry, in milliseconds; doubles each time up to `maxRetryMs`. */
  retryMs?: number
  maxRetryMs?: number
  /**
   * How long a process has to stay alive before the forward counts as working.
   *
   * A reverse forward offers nothing to probe, so "it did not fail immediately" is the whole of the evidence
   * available. `ExitOnForwardFailure=yes` makes a refused forward kill the process rather than leave a live ssh
   * carrying nothing, so a process still running after this long has a forward the hub accepted.
   */
  readyMs?: number
}

/** How long a live process must stay alive before its forward is believed. */
const READY_MS = 1_500
/** How long a stopped process may take to honour SIGTERM before it is killed. */
const STOP_GRACE_MS = 2_000
/** How much of ssh's stderr to keep: enough for the reason, not enough to grow without bound. */
const STDERR_KEEP = 2_048
/** `-N` forks no command, `-T` allocates no terminal: this process exists only to carry the forward. */
export const EXPOSE_FLAGS = ['-N', '-T'] as const
/**
 * The options that make a failure a failure.
 *
 * Same set as the forward tunnel, for the same reasons: no prompt (nothing can answer one), a forward that cannot
 * be set up kills the process instead of leaving a live ssh, and keepalives notice a dead link rather than waiting
 * for a TCP timeout nobody is watching. A kept-alive link also matters more here: while it stays up the hub holds
 * the port, so a silently dead connection keeps the port bound to a forward that carries nothing.
 */
export const EXPOSE_OPTIONS = ['-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30',
  '-o', 'ServerAliveCountMax=3'] as const

/**
 * The argv of the publishing process, in order, exactly as the tests pin it.
 *
 * The bind address is spelled `127.0.0.1` rather than left to ssh's default: a bare `-R port:host:hostport` asks
 * the hub to bind whatever its `GatewayPorts` says, and `GatewayPorts yes` would put this machine's page on the
 * hub's public interface — the hub's ledger is protected by listening on loopback only, and a page that edits the
 * device's configuration must not be the hole in that.
 */
export function exposeArgs(ssh: SshConfig, remotePort: number, localPort: number): string[] {
  return ['ssh', ...EXPOSE_FLAGS, ...EXPOSE_OPTIONS, '-p', String(ssh.port), '-i', ssh.keyPath,
    '-R', `127.0.0.1:${remotePort}:127.0.0.1:${localPort}`, `${ssh.user}@${ssh.host}`]
}

/**
 * Turns ssh's own words into something a person can act on.
 *
 * The interesting case is the one that is not an error: ssh warns that the remote port forward failed and then
 * keeps running, so a tunnel that publishes nothing looks exactly like a working one. Naming the port is the whole
 * value here, because the fix is the port and the person has to pick another.
 */
export function explainExpose(ssh: SshConfig, remotePort: number, stderr: string): string {
  const said = stderr.trim().split('\n').slice(-3).join(' ').trim()
  const tail = said === '' ? '' : ` (ssh said: ${said})`
  if (/remote port forwarding failed|Address already in use|Cannot listen to port|forwarding failed for listen port/i.test(stderr)) {
    return `the hub already has something on port ${remotePort}; pick another one and press the port check first${tail}`
  }
  if (/Permission denied \(publickey/.test(stderr)) {
    return `the hub refused this key; if it has a passphrase, add it to ssh-agent or pick a key without one${tail}`
  }
  if (/Could not resolve hostname/.test(stderr)) {
    return `the hub machine ${ssh.host} could not be resolved; check the host name${tail}`
  }
  if (/Host key verification failed/.test(stderr)) {
    return `the hub machine's host key is not in this machine's known_hosts; connect once from a terminal to accept it${tail}`
  }
  return `the published port on ${ssh.host} stopped${said === '' ? '' : `: ${said}`}`
}

/**
 * Whether ssh's own words say the remote forward was refused.
 *
 * Split out because ssh reports this on stderr and stays alive: the exit path would never run, so the streaming
 * handler has to recognise it while the process is still going.
 */
export function forwardRefused(stderr: string): boolean {
  return /remote port forwarding failed|Address already in use|Cannot listen to port|forwarding failed for listen port/i.test(stderr)
}

/** The default spawn: a real ssh, with stderr piped because that is where the reason lives. */
const realSpawn: SpawnExpose = argv => nodeSpawn(argv[0]!, argv.slice(1),
  { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }) as unknown as ChildProcess & ExposeChild

/**
 * Keeps one publishing process alive, reporting what it is doing.
 *
 * A retry is always a *new* process: an ssh that exited cannot be revived, and reusing the object would report a
 * state no process is in. `stop()` is idempotent and leaves nothing behind, including a pending retry timer.
 */
export class Expose {
  private current: ExposeState = 'idle'
  private lastFailure: string | undefined
  private child: ExposeChild | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  /** The pending escalation from SIGTERM to SIGKILL after `stop()`. */
  private killTimer: ReturnType<typeof setTimeout> | undefined
  /** The pending "has it stayed alive long enough" check for the current attempt. */
  private readyTimer: ReturnType<typeof setTimeout> | undefined
  /**
   * The child that has actually exited, if any.
   *
   * `ChildProcess.killed` means "a signal was sent", not "the process is gone", so it cannot answer "is it still
   * running" — and using it that way makes the SIGKILL escalation unreachable. The exit event is the only truth.
   */
  private exitedChild: ExposeChild | undefined
  /** A generation counter, so a late callback from a superseded attempt cannot overwrite the current state. */
  private generation = 0
  private retryMs: number
  private readonly maxRetryMs: number
  private readonly readyMs: number
  private readonly spawn: SpawnExpose

  constructor(private readonly input: ExposeInput) {
    this.spawn = input.spawn ?? realSpawn
    this.retryMs = input.retryMs ?? 1_000
    this.maxRetryMs = input.maxRetryMs ?? 60_000
    this.readyMs = input.readyMs ?? READY_MS
  }

  state(): ExposeState { return this.current }
  /** Why the last attempt failed, already rewritten into something a person can act on. */
  failure(): string | undefined { return this.lastFailure }

  /** Start the first attempt, or do nothing if one is already running. */
  start(): void {
    if (this.current === 'connecting' || this.current === 'connected') return
    this.attempt()
  }

  /**
   * End the process and any pending retry; safe to call more than once.
   *
   * SIGTERM first, then SIGKILL: an ssh that is slow to handle the polite signal would otherwise outlive the
   * plugin while the hub keeps its port bound to a forward that no longer carries anything, and the next
   * activation's first attempt would fail on a port the hub still believes is taken.
   */
  stop(): void {
    this.generation++
    this.clearTimers()
    const child = this.child
    this.child = undefined
    this.set('idle')
    if (child === undefined || this.exitedChild === child) return
    child.kill('SIGTERM')
    this.killTimer = setTimeout(() => {
      if (this.exitedChild !== child) child.kill('SIGKILL')
    }, STOP_GRACE_MS)
    this.killTimer.unref?.()
  }

  /** One attempt: ask for the local port, spawn, then wait out `readyMs` before believing the forward exists. */
  private attempt(): void {
    const generation = ++this.generation
    this.set('connecting')
    const localPort = this.input.localPort()
    if (localPort === undefined || !Number.isInteger(localPort) || localPort <= 0) {
      // Not a failure of the hub: the thing to publish is not there yet. The retry below is what turns a slow web
      // server into a working page instead of a plugin that gave up during startup.
      this.fail(generation, 'this machine has no DSH web port to publish yet; the web server is not listening')
      return
    }
    let stderr = ''
    let settled = false
    let child: ExposeChild
    try { child = this.spawn(exposeArgs(this.input.ssh, this.input.remotePort, localPort)) }
    catch (error) { this.fail(generation, `could not start ssh: ${String(error)}`); return }
    this.child = child
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_KEEP)
      // ssh warns about a refused remote forward and carries on running. Without this the device would report a
      // working port while the hub listens on nothing, which is the failure hardest to notice from the page.
      if (!settled && forwardRefused(stderr)) {
        settled = true
        this.fail(generation, explainExpose(this.input.ssh, this.input.remotePort, stderr))
      }
    })
    child.on('error', (error: Error) => {
      if (settled) return
      settled = true
      this.fail(generation, `could not start ssh: ${error.message}`)
    })
    child.on('exit', code => {
      // Recorded before the guards: `stop()` needs to know the process is gone even though the generation moved on.
      this.exitedChild = child
      if (settled || generation !== this.generation) return
      settled = true
      // A clean exit still means the published port is gone; only its wording differs.
      this.fail(generation, code === null || code === 0
        ? `the published port on ${this.input.ssh.host} closed`
        : explainExpose(this.input.ssh, this.input.remotePort, stderr))
    })
    this.readyTimer = setTimeout(() => {
      this.readyTimer = undefined
      if (settled || generation !== this.generation) return
      // Deliberately NOT settled: the exit that follows a working forward — a dropped link, a restarted hub — is
      // exactly the event that has to reach `fail` and schedule a retry. Settling here would leave a device that
      // publishes once and then silently stops, which is the hardest failure to notice.
      this.retryMs = this.input.retryMs ?? 1_000
      this.lastFailure = undefined
      this.set('connected')
    }, this.readyMs)
    this.readyTimer.unref?.()
  }

  /** Record a failure, release the process, and schedule the next attempt with a growing delay. */
  private fail(generation: number, message: string): void {
    if (generation !== this.generation) return
    this.lastFailure = message
    this.clearTimers()
    const child = this.child
    this.child = undefined
    if (child !== undefined && !child.killed) child.kill('SIGKILL')
    this.set('failed', message)
    this.input.log?.(`dsh-foreman-node expose: ${message}; retrying in ${Math.round(this.retryMs / 1000)}s`)
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

  private clearTimers(): void {
    if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined }
    if (this.killTimer !== undefined) { clearTimeout(this.killTimer); this.killTimer = undefined }
    if (this.readyTimer !== undefined) { clearTimeout(this.readyTimer); this.readyTimer = undefined }
  }

  private set(state: ExposeState, failure?: string): void {
    this.current = state
    this.input.onState?.(state, failure)
  }
}
