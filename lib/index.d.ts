import { Frame, FrameAttachment, FrameDedupe, Root } from "./protocol.js";
import { Context } from "@deepseek-ai/cordis";
import { Agent } from "@deepseek-ai/dsh-agent";
/** What a socket has to offer; the global `WebSocket` satisfies it, and tests supply an object that does too. */
interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open' | 'close' | 'error', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: {
    data: unknown;
  }) => void): void;
}
/** Opens a socket; injectable so tests never touch the network. */
type Connect = (url: string) => SocketLike;
interface NodeClientInput {
  /** The hub's stable address, such as `wss://foreman.example.com`. */
  url: string;
  deviceId: string;
  /** The device token; sent in the hello and nowhere else. */
  token: string;
  version: string;
  /** The projects this device can work on, as its own absolute paths. Declared once and re-declared on every hello. */
  roots: () => Root[];
  /** The assignments this device currently holds. Reported on every hello so the hub aligns instead of guessing. */
  running: () => string[];
  /** Handles frames the hub sends. */
  onFrame: (frame: Frame) => void;
  /** Milliseconds before the first reconnect; doubles up to `maxReconnectMs`. */
  reconnectMs?: number;
  maxReconnectMs?: number;
  connect?: Connect;
  /** The heartbeat interval; a device that says nothing looks offline to the hub, which turns its work blocked. */
  heartbeatMs?: number;
  log?: (text: string) => void;
  /** Frame ids the device has already acted on, so a redelivered frame does nothing twice. */
  dedupe?: FrameDedupe;
}
/**
 * Keeps one connection to the hub open, reconnecting with backoff.
 *
 * The class owns the socket's lifecycle and nothing else: what a frame means is the plugin's business, and what
 * happens when the connection is refused is the hub's. `start` and `stop` are idempotent.
 */
declare class NodeClient {
  private readonly input;
  private socket?;
  private stopped;
  private reconnectTimer?;
  private heartbeatTimer?;
  private delay;
  private readonly dedupe;
  private readonly connect;
  private readonly log;
  constructor(input: NodeClientInput);
  /** Open the connection, or do nothing if it is already open or opening. */
  start(): void;
  /** Close the connection and stop reconnecting; a late socket event does nothing. */
  stop(): void;
  /** Send a frame now if the connection is open. Returns whether it went out, so a caller can retry later. */
  send(frame: Frame): boolean;
  /** Report an outcome on an assignment, which is the only way a hub learns what a job did. */
  report(assignmentId: string, report: {
    state: 'progress' | 'ready' | 'blocked' | 'failed';
    summary: string;
    question?: string;
  }): void;
  /** Whether the connection is open right now. */
  connected(): boolean;
  private open;
  private hello;
  private startHeartbeat;
  private receive;
  /** Acknowledge a frame once its side effect is done, so the hub can stop resending it. */
  ack(frame: Frame): void;
  /** Tell the hub a frame's work reached its Session, which is what lets it mark the assignment started. */
  accepted(assignmentId: string): void;
  private scheduleReconnect;
}
/**
 * The `foreman_report` tool a device registers on a job Session.
 *
 * Reporting is a hard requirement rather than a convenience: in the domain, "waiting for a person" is a structured
 * fact that a report carries, and inferring it from a turn ending is an explicitly rejected approach. So a device
 * states outcomes through this tool and nothing else.
 *
 * `dropped` is not in its enum. Deciding that work should not be done is a judgement, a device has no judgement, and
 * the hub's ledger already refuses that state from a device (see the protocol). A device that believes the same thing
 * must report `blocked` and let a person decide.
 *
 * The schema is written as JSON Schema and validated here rather than through `zod`, so this package stays free of
 * runtime dependencies beyond the DSH services it is a peer plugin of.
 */
/** What a device may report; the same set the protocol's `NodeReportState` names. */
declare const REPORT_STATES: readonly ["progress", "ready", "blocked", "failed"];
type ReportState = typeof REPORT_STATES[number];
/** A report as the tool's caller gives it. */
interface DeviceReport {
  state: ReportState;
  summary: string;
  /** One question a person must answer; paired with `state: 'blocked'` in practice. */
  question?: string;
}
/** The host a tool reports through: the client that owns the connection, or a test. */
interface ReportHost {
  report(assignmentId: string, report: DeviceReport): void;
}
/** The parts of a tool definition DSH registers: name, description, JSON Schema, and the executor. */
interface DeviceTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>, execution: {
    signal: AbortSignal;
  }): Promise<unknown>;
}
/**
 * Build the `foreman_report` tool for one assignment.
 *
 * The assignment id is bound here rather than passed by the model: a job Session reports on the assignment it was
 * started for, and a model should not be able to name a different one.
 */
declare function foremanReportTool(host: ReportHost, assignmentId: string): DeviceTool;
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-foreman-node': {
      kind: 'dsh-foreman-node';
      form: 'relay';
    };
  }
}
interface EnsureInput {
  assignmentId: string;
  /** The absolute directory on this device; the hub mapped it through the device's declared roots. */
  directory: string;
  title: string;
}
/**
 * Keeps the device's job Sessions and delivers work into them.
 *
 * A Session is created only when it does not exist yet, so a redelivered `assign` reuses the Session and the work
 * already in it instead of starting a second one. Delivery is idempotent by request id: the hub retrying a frame
 * that it never saw acknowledged cannot append the task twice.
 */
declare class JobSessions {
  private readonly ctx;
  /** Jobs by assignment id, so `running()` reports what this device actually holds rather than what it was told. */
  private readonly jobs;
  /** Assignments whose Session already carries the report tool, so a redelivered assign registers it only once. */
  private readonly reported;
  constructor(ctx: Context);
  /**
   * Resolve or create the `job-<assignmentId>` Session in the given directory, attach its `foreman_report` tool, and
   * register it so a heartbeat counts it.
   *
   * The tool is attached here rather than left to the caller because it is the only way a device can say what
   * happened: without it a job Session's model has no `progress`/`ready`/`blocked`/`failed` channel, the hub waits
   * forever, and the whole design's "never infer state from session events" requirement is moot. Registration is
   * idempotent per assignment, so a redelivered `assign` does not stack a second tool on the same Session.
   *
   * @returns the Session id.
   */
  ensure(input: EnsureInput, onReport?: (assignmentId: string, report: DeviceReport) => void): Promise<string>;
  /**
   * Deliver a task into its job Session, once per request id.
   *
   * `queue` rather than `steer` on the first delivery: the job's task should start a turn, not interrupt one that is
   * already running. A redelivery finds the message already recorded and adds nothing.
   */
  deliver(sessionId: string, text: string, requestId: string): Promise<void>;
  /** Whether the Session already holds the delivery for `requestId`, in its live inbox or its stored history. */
  holds(agent: Agent, requestId: string): Promise<boolean>;
  /** The assignment ids this device currently holds a job for: what a heartbeat and a reconnected hello report. */
  running(): string[];
  /** Forget a job whose assignment the hub stopped, so this device stops reporting it as running. */
  forget(assignmentId: string): void;
  /** Attach the `foreman_report` tool to a job Session, disposed with it. */
  reportTools(agent: Agent, assignmentId: string, onReport: (assignmentId: string, report: DeviceReport) => void): void;
}
/** Version reported in the hello, so the hub can tell which device build is talking. */
declare const VERSION = "0.1.0";
/** One project this device can work on: the hub's logical name and this machine's own absolute path. */
interface NodeRoot {
  project: string;
  path: string;
}
/** What the `dsh-foreman-node` entry in a profile's patch configures. */
interface NodeConfig {
  /** The hub's stable address; the device dials out to it. Blank until someone fills it in. */
  url: string;
  /** This device's id, as registered on the hub with `Devices.add`. Blank until someone fills it in. */
  deviceId: string;
  /** This device's token; sent in the hello and nowhere else. Blank until someone fills it in. */
  token: string;
  /** The projects this device can work on. */
  roots: NodeRoot[];
  /** How often to tell the hub this device is alive, in milliseconds. */
  heartbeatMs: number;
  /** Delay before the first reconnect attempt, in milliseconds. */
  reconnectMs: number;
}
/**
 * Configuration of one device, from the `dsh-foreman-node` entry in the profile's patch.
 *
 * Everything is optional on purpose. A bundle patch inserts this row the moment the package is added to a profile,
 * so `apply` runs before anyone has filled the values in — and a schema that demanded them would turn the whole
 * profile red with "invalid config" on a fresh install. `apply` treats a blank address as "not configured yet":
 * it says what is missing and stops, instead of dialling nowhere or refusing to activate.
 *
 * The annotation names the schema type through the global `Schemastery` namespace rather than letting it be inferred:
 * an inferred type here names a `cosmokit` symbol the emitted declaration cannot reference portably.
 */
declare const Config: Schemastery<NodeConfig>;
/**
 * What this configuration still needs before the device can dial its hub, or undefined when it is complete.
 *
 * A missing value is reported by name so an operator can fill it in without reading the source; a value that is only
 * whitespace counts as missing, because a device that dials a blank address retries forever and looks merely offline.
 */
declare function missingConfiguration(config: NodeConfig): string | undefined;
declare const name = "dsh-foreman-node";
/** DSH services a job needs; all are the host's own, and none is a foreman one. */
declare const inject: string[];
/**
 * Start the device.
 *
 * A package that has just been installed has its row in the profile patch with no values in it yet. Activating
 * cleanly and saying what is still missing keeps the whole profile healthy; throwing here is what made a fresh
 * install report the profile as broken.
 *
 * The plugin returns once the connection is attempted, not once it succeeds: a device must boot and stay usable
 * while its hub is unreachable, and the client keeps retrying in the background.
 */
declare function apply(ctx: Context, config: NodeConfig): Promise<void>;
export { Config, type Frame, type FrameAttachment, JobSessions, NodeClient, NodeConfig, NodeRoot, REPORT_STATES, type Root, VERSION, apply, foremanReportTool, inject, missingConfiguration, name };