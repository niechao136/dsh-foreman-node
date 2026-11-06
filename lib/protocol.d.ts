/**
 * The foreman protocol: one JSON frame per WebSocket text message, versioned by `v`.
 *
 * This file is the only definition of a frame. `dsh-foreman` (the hub) depends on
 * this package and imports it, so the two sides cannot drift; nothing here may
 * import a DSH service, the core domain, or a database.
 */
/** Bumped whenever a frame's shape changes incompatibly; a peer on another version is refused at handshake. */
declare const FOREMAN_PROTOCOL_VERSION = 1;
/** Largest frame accepted, in bytes of UTF-8. A larger one is refused, never truncated. */
declare const MAX_FRAME_BYTES: number;
/** A project a device can work on: the hub's logical name and the device's own absolute path. */
interface Root {
  /** The project name both sides agree on; the hub never sees the device path before a job is assigned. */
  project: string;
  /** An absolute path on the device. Kept verbatim, including spaces and non-ASCII characters. */
  path: string;
}
/** A file travelling with a task, base64-encoded. The device writes it where its job session can read it. */
interface FrameAttachment {
  id: string;
  mediaType?: string;
  name?: string;
  bytes: string;
}
/**
 * What a device may report. `dropped` is deliberately absent: deciding that work
 * should not be done is a judgement, and a device has none.
 */
type NodeReportState = 'progress' | 'ready' | 'blocked' | 'failed';
interface Base {
  v: number;
  frameId: string;
}
/** First frame a device sends on every connection; it states what it is running so the hub can align, rather than guess. */
interface HelloFrame extends Base {
  type: 'hello';
  deviceId: string;
  token: string;
  version: string;
  roots: Root[];
  running: string[];
}
interface HeartbeatFrame extends Base {
  type: 'heartbeat';
  deviceId: string;
  running: number;
}
/** A task for the device. `text` is finished on the hub side: no resource pointer, no hub path. */
interface AssignFrame extends Base {
  type: 'assign';
  assignmentId: string;
  ticketId: string;
  /** An absolute path on the device, already mapped through its declared roots. */
  directory: string;
  text: string;
  attachments: FrameAttachment[];
  permissionPreset: string;
}
interface InputFrame extends Base {
  type: 'input';
  assignmentId: string;
  text: string;
  attachments: FrameAttachment[];
}
interface StopFrame extends Base {
  type: 'stop';
  assignmentId: string;
  reason: string;
}
interface AcceptedFrame extends Base {
  type: 'accepted';
  assignmentId: string;
}
interface ReportFrame extends Base {
  type: 'report';
  assignmentId: string;
  state: NodeReportState;
  summary: string;
  question?: string;
}
interface AckFrame extends Base {
  type: 'ack';
  /** The `frameId` of the frame being acknowledged. */
  of: string;
}
/** Sent by the hub before it closes a connection it refuses, so the device can log why. */
interface ErrorFrame extends Base {
  type: 'error';
  reason: string;
}
type Frame = HelloFrame | HeartbeatFrame | AssignFrame | InputFrame | StopFrame | AcceptedFrame | ReportFrame | AckFrame | ErrorFrame;
/** A frame the receiver cannot accept: wrong version, unknown type, malformed JSON, or over the size cap. */
declare class FrameError extends Error {
  constructor(message: string);
}
declare function encodeFrame(frame: Frame): string;
/**
 * Parses one frame, refusing anything this build cannot honour.
 * @throws FrameError for oversized text, malformed JSON, another protocol version, or an unknown type.
 */
declare function parseFrame(text: string): Frame;
/** Remembers the frame ids a peer has already acted on, so a retried frame does nothing twice. */
declare class FrameDedupe {
  private readonly seen;
  constructor(seen?: Set<string>);
  /** Returns true the first time a frame id is seen, false for a repeat. */
  take(frameId: string): boolean;
}
export { AcceptedFrame, AckFrame, AssignFrame, ErrorFrame, FOREMAN_PROTOCOL_VERSION, Frame, FrameAttachment, FrameDedupe, FrameError, HeartbeatFrame, HelloFrame, InputFrame, MAX_FRAME_BYTES, NodeReportState, ReportFrame, Root, StopFrame, encodeFrame, parseFrame };