/**
 * The foreman protocol: one JSON frame per WebSocket text message, versioned by `v`.
 *
 * This file is the only definition of a frame. `dsh-foreman` (the hub) depends on
 * this package and imports it, so the two sides cannot drift; nothing here may
 * import a DSH service, the core domain, or a database.
 */

/** Bumped whenever a frame's shape changes incompatibly; a peer on another version is refused at handshake. */
export const FOREMAN_PROTOCOL_VERSION = 1

/** Largest frame accepted, in bytes of UTF-8. A larger one is refused, never truncated. */
export const MAX_FRAME_BYTES = 256 * 1024

/** A project a device can work on: the hub's logical name and the device's own absolute path. */
export interface Root {
  /** The project name both sides agree on; the hub never sees the device path before a job is assigned. */
  project: string
  /** An absolute path on the device. Kept verbatim, including spaces and non-ASCII characters. */
  path: string
}

/** A file travelling with a task, base64-encoded. The device writes it where its job session can read it. */
export interface FrameAttachment {
  id: string
  mediaType?: string
  name?: string
  bytes: string
}

/**
 * What a device may report. `dropped` is deliberately absent: deciding that work
 * should not be done is a judgement, and a device has none.
 */
export type NodeReportState = 'progress' | 'ready' | 'blocked' | 'failed'

interface Base {
  v: number
  frameId: string
}

/**
 * Optional behaviours a peer may implement, so a device that is one release behind still connects.
 *
 * `v` stays for frames that genuinely cannot be understood across versions. Everything additive is negotiated here
 * instead, because a device that sits switched off for a month must not come back to a hub it can never talk to again
 * — the whole point of a fleet is that machines are updated one at a time.
 */
export const CAPABILITIES = [
  /** A `report` may carry a structured `detail`. */
  'report.detail',
  /** The device answers `read` frames with a page of its transcript. */
  'read.transcript',
  /** A device understands `assign` frames whose text carries completion criteria. */
  'assign.criteria',
] as const
export type Capability = typeof CAPABILITIES[number]

/** First frame a device sends on every connection; it states what it is running so the hub can align, rather than guess. */
export interface HelloFrame extends Base {
  type: 'hello'
  deviceId: string
  token: string
  version: string
  /** What this device can do beyond the baseline; absent from an older device, which the hub treats as none. */
  capabilities?: Capability[]
  roots: Root[]
  running: string[]
}

export interface HeartbeatFrame extends Base {
  type: 'heartbeat'
  deviceId: string
  running: number
}

/** A task for the device. `text` is finished on the hub side: no resource pointer, no hub path. */
export interface AssignFrame extends Base {
  type: 'assign'
  assignmentId: string
  ticketId: string
  /** An absolute path on the device, already mapped through its declared roots. */
  directory: string
  text: string
  attachments: FrameAttachment[]
  permissionPreset: string
}

export interface InputFrame extends Base {
  type: 'input'
  assignmentId: string
  text: string
  attachments: FrameAttachment[]
}

export interface StopFrame extends Base {
  type: 'stop'
  assignmentId: string
  reason: string
}

export interface AcceptedFrame extends Base {
  type: 'accepted'
  assignmentId: string
}

/**
 * What a job actually did, summarised for a hub that never sees the job's Session.
 *
 * A device keeps the whole transcript locally; sending it to the hub would grow the router's context with a
 * per-device log it cannot index. This carries the facts a person needs to judge a remote ticket — was it tests, was
 * it the environment, what did it touch — and is bounded so a runaway job cannot blow the frame cap.
 */
export interface ReportDetail {
  /** Model turns the job took. */
  steps?: number
  /** Tool names the job called, how often, and how many of those failed. */
  tools?: { name: string; calls: number; failures: number }[]
  /** Repo-relative paths the job changed, capped at `MAX_DETAIL_FILES`. */
  changedFiles?: string[]
  /** How many changed paths the cap left out. */
  changedOverflow?: number
  /** The last error the job hit, cut to `MAX_DETAIL_ERROR` characters. */
  lastError?: string
  /** Counts from the project's own test command, when the job ran one. */
  tests?: { passed: number; failed: number }
}

/** Most changed paths one report names; the rest are counted, not listed. */
export const MAX_DETAIL_FILES = 20
/** Longest `lastError` a report carries, in characters. */
export const MAX_DETAIL_ERROR = 500

export interface ReportFrame extends Base {
  type: 'report'
  assignmentId: string
  state: NodeReportState
  summary: string
  question?: string
  /** Structured summary of what the job did; optional so a device that cannot compute it still reports. */
  detail?: ReportDetail
}

export interface AckFrame extends Base {
  type: 'ack'
  /** The `frameId` of the frame being acknowledged. */
  of: string
}

/** Sent by the hub before it closes a connection it refuses, so the device can log why. */
export interface ErrorFrame extends Base {
  type: 'error'
  reason: string
}

/**
 * The hub asking for part of a finished job's transcript.
 *
 * The device keeps the whole history; the report carries only a summary. When a person needs the detail — "what did
 * it actually try before it gave up" — the hub asks for a page of it instead of having the device push everything up
 * front. `offset` is a character offset into the rendered text, so both sides paginate the same way the hub's own
 * `resources` do.
 */
export interface ReadFrame extends Base {
  type: 'read'
  /** Correlates the answer; the device echoes it in `part`. */
  requestId: string
  assignmentId: string
  resource: 'transcript'
  offset: number
  /** Characters requested; the device clamps to `MAX_READ_CHARS` and to the frame cap. */
  limit: number
}

/** The device's answer to a `ReadFrame`: one page of rendered text. */
export interface PartFrame extends Base {
  type: 'part'
  requestId: string
  /** The whole text's length, so the hub knows whether more remains. */
  total: number
  /** Character offset this page starts at. */
  offset: number
  text: string
  /** Why the page could not be produced, when it could not be. */
  error?: string
}

/** Most characters one `part` page carries, so a page always fits inside `MAX_FRAME_BYTES`. */
export const MAX_READ_CHARS = 4000

export type Frame =
  | HelloFrame | HeartbeatFrame | AssignFrame | InputFrame | StopFrame
  | AcceptedFrame | ReportFrame | AckFrame | ErrorFrame | ReadFrame | PartFrame

/** A frame the receiver cannot accept: wrong version, unknown type, malformed JSON, or over the size cap. */
export class FrameError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FrameError'
  }
}

const TYPES = new Set(['hello', 'heartbeat', 'assign', 'input', 'stop', 'accepted', 'report', 'ack', 'error', 'read', 'part'])

export function encodeFrame(frame: Frame): string {
  return JSON.stringify(frame)
}

/**
 * Parses one frame, refusing anything this build cannot honour.
 * @throws FrameError for oversized text, malformed JSON, another protocol version, or an unknown type.
 */
export function parseFrame(text: string): Frame {
  const size = Buffer.byteLength(text, 'utf8')
  if (size > MAX_FRAME_BYTES) throw new FrameError(`frame too large: ${size} bytes, limit ${MAX_FRAME_BYTES}`)
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new FrameError(`malformed frame: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof value !== 'object' || value === null) throw new FrameError('a frame must be a JSON object')
  const frame = value as Record<string, unknown>
  const version = frame['v']
  // The version is a major-only gate: it changes only for a frame shape that cannot be read across versions. Anything
  // additive travels as a capability in `hello`, so a device one release behind keeps working instead of being refused.
  if (version !== FOREMAN_PROTOCOL_VERSION) {
    throw new FrameError(`unsupported protocol version ${String(version)}; this build speaks ${FOREMAN_PROTOCOL_VERSION}`)
  }
  const type = frame['type']
  if (typeof type !== 'string' || !TYPES.has(type)) throw new FrameError(`unknown frame type ${String(type)}`)
  if (typeof frame['frameId'] !== 'string' || frame['frameId'] === '') throw new FrameError('a frame needs a frameId')
  return frame as unknown as Frame
}

/** Whether a peer that announced `capabilities` implements `capability`; an older peer announces none. */
export const supports = (capabilities: readonly Capability[] | undefined, capability: Capability): boolean =>
  (capabilities ?? []).includes(capability)
/** Remembers the frame ids a peer has already acted on, so a retried frame does nothing twice. */
export class FrameDedupe {
  constructor(private readonly seen: Set<string> = new Set()) {}
  /** Returns true the first time a frame id is seen, false for a repeat. */
  take(frameId: string): boolean {
    if (this.seen.has(frameId)) return false
    this.seen.add(frameId)
    return true
  }
}
