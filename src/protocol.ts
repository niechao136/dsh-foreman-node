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

/** First frame a device sends on every connection; it states what it is running so the hub can align, rather than guess. */
export interface HelloFrame extends Base {
  type: 'hello'
  deviceId: string
  token: string
  version: string
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

export interface ReportFrame extends Base {
  type: 'report'
  assignmentId: string
  state: NodeReportState
  summary: string
  question?: string
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

export type Frame =
  | HelloFrame | HeartbeatFrame | AssignFrame | InputFrame | StopFrame
  | AcceptedFrame | ReportFrame | AckFrame | ErrorFrame

/** A frame the receiver cannot accept: wrong version, unknown type, malformed JSON, or over the size cap. */
export class FrameError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FrameError'
  }
}

const TYPES = new Set(['hello', 'heartbeat', 'assign', 'input', 'stop', 'accepted', 'report', 'ack', 'error'])

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
  if (version !== FOREMAN_PROTOCOL_VERSION) {
    throw new FrameError(`unsupported protocol version ${String(version)}; this build speaks ${FOREMAN_PROTOCOL_VERSION}`)
  }
  const type = frame['type']
  if (typeof type !== 'string' || !TYPES.has(type)) throw new FrameError(`unknown frame type ${String(type)}`)
  if (typeof frame['frameId'] !== 'string' || frame['frameId'] === '') throw new FrameError('a frame needs a frameId')
  return frame as unknown as Frame
}

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
