/**
 * The device's outbound connection to its hub.
 *
 * The direction is deliberate: a device dials out, so a machine behind NAT or a company firewall can take work. The
 * connection is never the device's to command — it reports what it holds, sends frames the hub asked for, and
 * reconnects with exponential backoff on its own.
 *
 * A frame is never built here by hand: the protocol module owns every shape, so the device and the hub cannot drift.
 * Nothing in this file writes a ledger, reads a policy, or opens a database — a device has none of those.
 */
import { FOREMAN_PROTOCOL_VERSION, FrameDedupe, encodeFrame, parseFrame, type Frame, type HeartbeatFrame, type HelloFrame,
  type ReportFrame, type Root, type AcceptedFrame, type AckFrame } from './protocol.ts'
import { FrameOutbox } from './outbox.ts'

/** What a socket has to offer; the global `WebSocket` satisfies it, and tests supply an object that does too. */
export interface SocketLike {
  readyState: number
  send(data: string): void
  close(): void
  addEventListener(type: 'open' | 'close' | 'error', listener: () => void): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
}

/** Opens a socket; injectable so tests never touch the network. */
export type Connect = (url: string) => SocketLike

export interface NodeClientInput {
  /** The hub's stable address, such as `wss://foreman.example.com`. */
  url: string
  deviceId: string
  /** The device token; sent in the hello and nowhere else. */
  token: string
  version: string
  /** The projects this device can work on, as its own absolute paths. Declared once and re-declared on every hello. */
  roots: () => Root[]
  /** The assignments this device currently holds. Reported on every hello so the hub aligns instead of guessing. */
  running: () => string[]
  /** Handles frames the hub sends. */
  onFrame: (frame: Frame) => void
  /** Milliseconds before the first reconnect; doubles up to `maxReconnectMs`. */
  reconnectMs?: number
  maxReconnectMs?: number
  connect?: Connect
  /** The heartbeat interval; a device that says nothing looks offline to the hub, which turns its work blocked. */
  heartbeatMs?: number
  log?: (text: string) => void
  /** Frame ids the device has already acted on, so a redelivered frame does nothing twice. */
  dedupe?: FrameDedupe
  /**
   * Where reports wait while the socket is closed.
   *
   * A report is the only way the hub learns what a job did, and a job often finishes exactly when the connection is
   * down. Without a queue that fact is lost and the ticket waits until `hubIdleMs` reports it `blocked` as "device
   * offline" — while the work is done. Empty keeps the queue in memory, which tests use.
   */
  outboxFile?: string
}

const OPEN = 1

/** A counter for frame ids; unique within one connection is enough, since the hub drops repeats by id. */
let counter = 0
/** A fresh frame id. Time-based so two processes do not collide, with a counter so two frames in one millisecond differ. */
export const nextFrameId = (prefix: string): string => `${prefix}:${Date.now().toString(36)}:${(counter++).toString(36)}`

/**
 * Keeps one connection to the hub open, reconnecting with backoff.
 *
 * The class owns the socket's lifecycle and nothing else: what a frame means is the plugin's business, and what
 * happens when the connection is refused is the hub's. `start` and `stop` are idempotent.
 */
export class NodeClient {
  private socket?: SocketLike
  private stopped = false
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private heartbeatTimer?: ReturnType<typeof setInterval>
  private delay: number
  private readonly dedupe: FrameDedupe
  private readonly connect: Connect
  private readonly log: (text: string) => void
  /** Reports the hub has not confirmed yet; replayed on every connection, oldest first. */
  private readonly outbox: FrameOutbox

  constructor(private readonly input: NodeClientInput) {
    this.delay = input.reconnectMs ?? 1_000
    this.dedupe = input.dedupe ?? new FrameDedupe(new Set())
    this.connect = input.connect ?? (url => new WebSocket(url) as unknown as SocketLike)
    this.log = input.log ?? (() => {})
    this.outbox = new FrameOutbox(input.outboxFile, this.log)
  }

  /** How many reports still wait to reach the hub; a device with a growing queue cannot reach it. */
  get queued(): number { return this.outbox.size }

  /** Open the connection, or do nothing if it is already open or opening. */
  start(): void {
    if (this.stopped || this.socket !== undefined) return
    this.open()
  }

  /** Close the connection and stop reconnecting; a late socket event does nothing. */
  stop(): void {
    this.stopped = true
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer)
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer)
    this.socket?.close()
    this.socket = undefined
  }

  /** Send a frame now if the connection is open. Returns whether it went out, so a caller can retry later. */
  send(frame: Frame): boolean {
    if (this.socket === undefined || this.socket.readyState !== OPEN) return false
    try {
      this.socket.send(encodeFrame(frame))
      return true
    } catch (error) {
      this.log(`dsh-foreman-node could not send ${frame.type}: ${String(error)}`)
      return false
    }
  }

  /**
   * Report an outcome on an assignment, which is the only way a hub learns what a job did.
   *
   * The frame is queued before it is sent, so a report produced while the socket is closed is delivered by the next
   * connection instead of being lost. A `ready`/`blocked`/`failed` report is the final word on an assignment, and the
   * hub's `FrameDedupe` makes a replay harmless.
   */
  report(assignmentId: string, report: { state: 'progress' | 'ready' | 'blocked' | 'failed'; summary: string; question?: string }): void {
    const frame: ReportFrame = { v: FOREMAN_PROTOCOL_VERSION, type: 'report', frameId: nextFrameId('report'), assignmentId,
      state: report.state, summary: report.summary, ...(report.question === undefined ? {} : { question: report.question }) }
    this.outbox.add(frame)
    if (this.send(frame)) this.outbox.settle(frame.frameId)
  }

  /**
   * Send a frame the work depends on, queueing it first when it may need redelivery.
   *
   * Used for the `ack` of an input frame: the hub clears `ticket.undelivered` from it, so an ack lost to a closed
   * socket leaves a remote ticket unable to finish while it follows Threads.
   */
  sendDurable(frame: Frame): boolean {
    if (!FrameOutbox.durable(frame)) return this.send(frame)
    this.outbox.add(frame)
    const sent = this.send(frame)
    if (sent) this.outbox.settle(frame.frameId)
    return sent
  }

  /** Whether the connection is open right now. */
  connected(): boolean { return this.socket !== undefined && this.socket.readyState === OPEN }

  private open(): void {
    let socket: SocketLike
    try {
      socket = this.connect(this.input.url)
    } catch (error) {
      this.log(`dsh-foreman-node could not open ${this.input.url}: ${String(error)}`)
      this.scheduleReconnect()
      return
    }
    this.socket = socket
    socket.addEventListener('open', () => {
      if (this.stopped) return
      this.delay = this.input.reconnectMs ?? 1_000
      this.hello()
      this.startHeartbeat()
      // Everything the last connection could not carry goes out now, oldest first. The hub aligns from `hello` first,
      // so a report queued before the reconnect lands on a ledger that already knows the assignment exists.
      const sent = this.outbox.flush(frame => this.send(frame))
      if (sent > 0) this.log(`dsh-foreman-node delivered ${sent} queued frame(s)`)
    })
    socket.addEventListener('message', event => {
      if (this.stopped) return
      const text = typeof event.data === 'string' ? event.data : String(event.data)
      this.receive(text)
    })
    socket.addEventListener('error', () => {
      // A socket error is followed by a close; reconnecting there keeps one path.
      this.log('dsh-foreman-node connection error')
    })
    socket.addEventListener('close', () => {
      if (this.stopped) return
      if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer)
      this.socket = undefined
      this.scheduleReconnect()
    })
  }

  private hello(): void {
    const frame: HelloFrame = { v: FOREMAN_PROTOCOL_VERSION, type: 'hello', frameId: nextFrameId('hello'), deviceId: this.input.deviceId,
      token: this.input.token, version: this.input.version, roots: this.input.roots(), running: this.input.running() }
    this.send(frame)
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = setInterval(() => {
      const frame: HeartbeatFrame = { v: FOREMAN_PROTOCOL_VERSION, type: 'heartbeat', frameId: nextFrameId('heartbeat'),
        deviceId: this.input.deviceId, running: this.input.running().length }
      this.send(frame)
    }, this.input.heartbeatMs ?? 15_000)
    this.heartbeatTimer.unref?.()
  }

  private receive(text: string): void {
    let frame: Frame
    try {
      frame = parseFrame(text)
    } catch (error) {
      // A frame this build cannot read is a hub speaking another protocol: say so in the log and keep the socket,
      // because a dropped connection would only make the same misreading happen again.
      this.log(`dsh-foreman-node refused a frame: ${String(error)}`)
      return
    }
    if (!this.dedupe.take(frame.frameId)) return
    if (frame.type === 'ack') return
    if (frame.type === 'error') {
      this.log(`dsh-foreman-node was refused by the hub: ${frame.reason}`)
      return
    }
    this.input.onFrame(frame)
  }

  /** Acknowledge a frame once its side effect is done, so the hub can stop resending it. */
  ack(frame: Frame): void {
    const ack: AckFrame = { v: FOREMAN_PROTOCOL_VERSION, type: 'ack', frameId: nextFrameId('ack'), of: frame.frameId }
    // The hub clears the ticket's undelivered Inputs from this ack, so an ack lost to a closed socket would leave a
    // remote ticket unable to finish. It is queued like a report for that reason.
    this.sendDurable(ack)
  }

  /** Tell the hub a frame's work reached its Session, which is what lets it mark the assignment started. */
  accepted(assignmentId: string): void {
    const frame: AcceptedFrame = { v: FOREMAN_PROTOCOL_VERSION, type: 'accepted', frameId: nextFrameId('accepted'), assignmentId }
    this.send(frame)
  }

  private scheduleReconnect(): void {
    if (this.stopped) return
    const wait = this.delay
    // Back off exponentially, but never past the cap: a hub down for an hour must not delay a reconnect by an hour.
    this.delay = Math.min(this.delay * 2, this.input.maxReconnectMs ?? 60_000)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      if (!this.stopped) this.open()
    }, wait)
    this.reconnectTimer.unref?.()
    this.log(`dsh-foreman-node reconnecting in ${wait} ms`)
  }
}
