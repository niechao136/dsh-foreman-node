/**
 * The device-side plugin entry.
 *
 * It is deliberately thin: one connection out to the hub, one job Session per assignment, one report tool per job.
 * It imports no domain core, opens no database, and reads no policy, because a device holds no ledger — the hub is
 * the only place work is recorded, and this side's job is to do it and say what happened.
 */
import type { Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-tools'
import { NodeClient } from './client.ts'
import { JobSessions } from './session.ts'
import type { Frame } from './protocol.ts'

/** Version reported in the hello, so the hub can tell which device build is talking. */
export const VERSION = '0.1.0'

/** One project this device can work on: the hub's logical name and this machine's own absolute path. */
export interface NodeRoot { project: string; path: string }

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
export const Config: Schemastery<NodeConfig> = s.object({
  url: s.string().default('').description('The hub\'s address, such as wss://foreman.example.com. The device dials out to it.'),
  deviceId: s.string().default('').description('This device\'s id, as registered on the hub with `Devices.add`.'),
  token: s.string().default('').role('secret').description('This device\'s token; it is sent in the hello frame and nowhere else.'),
  roots: s.array(s.object({ project: s.string().required(), path: s.string().required() })).default([])
    .description('Projects this device can work on: a logical name and this machine\'s own absolute path, kept verbatim.'),
  heartbeatMs: s.natural().default(15_000).description('How often to tell the hub this device is alive, in milliseconds.'),
  reconnectMs: s.natural().default(1_000).description('Delay before the first reconnect attempt, in milliseconds.'),
})

/**
 * What this configuration still needs before the device can dial its hub, or undefined when it is complete.
 *
 * A missing value is reported by name so an operator can fill it in without reading the source; a value that is only
 * whitespace counts as missing, because a device that dials a blank address retries forever and looks merely offline.
 */
export function missingConfiguration(config: NodeConfig): string | undefined {
  const missing: string[] = []
  if (config.url.trim() === '') missing.push('url')
  if (config.deviceId.trim() === '') missing.push('deviceId')
  if (config.token.trim() === '') missing.push('token')
  if (missing.length === 0) return undefined
  return `dsh-foreman-node is not configured yet: ${missing.join(', ')} ` +
    `missing. Set them on the dsh-foreman-node row in the profile patch (the hub prints the token when you register the device).`
}

export const name = 'dsh-foreman-node'
/** DSH services a job needs; all are the host's own, and none is a foreman one. */
export const inject = ['sessionController', 'sessionPersistence', 'workspaceRegistry', 'permissionPresets', 'tools', 'agents']

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
export async function apply(ctx: Context, config: NodeConfig): Promise<void> {
  const missing = missingConfiguration(config)
  if (missing !== undefined) {
    ctx.logger.info('%s', missing)
    return
  }
  const jobs = new JobSessions(ctx)
  const client = new NodeClient({
    url: config.url,
    deviceId: config.deviceId,
    token: config.token,
    version: VERSION,
    roots: () => config.roots.map(root => ({ project: root.project, path: root.path })),
    running: () => jobs.running(),
    heartbeatMs: config.heartbeatMs,
    reconnectMs: config.reconnectMs,
    log: text => ctx.logger.warn('%s', text),
    onFrame: frame => { void receive(ctx, jobs, client, frame) },
  })
  client.start()
  ctx.effect(() => () => { client.stop() })
  ctx.logger.info('dsh-foreman-node %s is dialling %s as %s', VERSION, config.url, config.deviceId)
}

/**
 * Handle one frame from the hub.
 *
 * `assign` creates or reuses the job Session and delivers the task; `input` steers more text into the same Session;
 * `stop` ends the job. Each is acknowledged so the hub stops resending it, and each is idempotent on this side, so a
 * redelivery after a dropped ack does no harm.
 */
async function receive(ctx: Context, jobs: JobSessions, client: NodeClient, frame: Frame): Promise<void> {
  try {
    if (frame.type === 'assign') {
      // The report tool is attached by `ensure`, which is why it needs the client: a job that cannot report back
      // would leave the hub waiting with no way to learn what happened.
      const sessionId = await jobs.ensure({ assignmentId: frame.assignmentId, directory: frame.directory, title: `job ${frame.assignmentId}` },
        (assignmentId, report) => client.report(assignmentId, report))
      await jobs.deliver(sessionId, frame.text, frame.frameId)
      client.accepted(frame.assignmentId)
      client.ack(frame)
      return
    }
    if (frame.type === 'input') {
      const sessionId = `job-${frame.assignmentId}`
      await jobs.deliver(sessionId, frame.text, frame.frameId)
      client.ack(frame)
      return
    }
    if (frame.type === 'stop') {
      // The job's Session is left in place: a person may still want to read what it did.
      jobs.forget(frame.assignmentId)
      client.ack(frame)
    }
    // Heartbeats and acks need no answer; a hello is the hub's own, which this side never sends.
  } catch (error) {
    // A frame that cannot be applied is reported blocked rather than swallowed: silence would leave the hub waiting.
    ctx.logger.warn('dsh-foreman-node could not apply a %s frame: %s', frame.type, String(error))
    if (frame.type === 'assign' || frame.type === 'input') {
      client.report(frame.assignmentId, { state: 'blocked', summary: `this device could not start the job: ${String(error)}` })
    }
  }
}

export { NodeClient } from './client.ts'
export { JobSessions } from './session.ts'
export { foremanReportTool, REPORT_STATES } from './report-tool.ts'
export type { Frame, Root, FrameAttachment } from './protocol.ts'
