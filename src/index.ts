/**
 * The device-side plugin entry.
 *
 * It is deliberately thin: one connection out to the hub, one job Session per assignment, one report tool per job.
 * It imports no domain core, opens no database, and reads no policy, because a device holds no ledger — the hub is
 * the only place work is recorded, and this side's job is to do it and say what happened.
 */
import type { Context, Volatile } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-tools'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { NodeClient } from './client.ts'
import { configured, SSH_DEFAULTS, type NodeConfig, type NodeRoot, type SshConfig } from './config.ts'
import { registerNodeRoutes, type RouteHost } from './routes.ts'
import { Tunnel } from './tunnel.ts'
import { JobSessions } from './session.ts'
import type { Frame } from './protocol.ts'

/** Version reported in the hello, so the hub can tell which device build is talking. */
export const VERSION = '0.2.0'

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
const ConfigSchema = s.object({
  url: s.string().default('').volatile().description('The hub\'s address, such as wss://foreman.example.com. The device dials out to it.'),
  deviceId: s.string().default('').volatile().description('This device\'s id, as registered on the hub with `Devices.add`.'),
  token: s.string().default('').role('secret').volatile().description('This device\'s token; it is sent in the hello frame and nowhere else.'),
  roots: s.array(s.object({ project: s.string().required(), path: s.string().required() })).default([]).volatile()
    .description('Projects this device can work on: a logical name and this machine\'s own absolute path, kept verbatim.'),
  heartbeatMs: s.natural().default(15_000).volatile().description('How often to tell the hub this device is alive, in milliseconds.'),
  reconnectMs: s.natural().default(1_000).volatile().description('Delay before the first reconnect attempt, in milliseconds.'),
  // Every field carries a default, and the object itself does too: a `cordis.patch.yml` written before this block
  // existed has no `ssh` key, and a schema that demanded one would report the whole profile invalid on upgrade.
  ssh: s.object({
    enabled: s.boolean().default(false).description('Reach the hub through an SSH tunnel this device starts itself.'),
    host: s.string().default('').description('The hub machine, such as 203.0.113.10 or its ~/.ssh/config alias.'),
    // min(1), not just natural(): an empty port box becomes 0, and 0 is a port the tunnel would happily dial.
    port: s.natural().min(1).max(65535).default(22).description('The hub machine\'s SSH port.'),
    user: s.string().default('').description('The SSH user on the hub machine.'),
    keyPath: s.string().default('').description('The private key this device authenticates with; the page lists these from ~/.ssh.'),
    remotePort: s.natural().min(1).max(65535).default(8790).description('The port the hub listens on, on the hub machine.'),
    localPort: s.natural().min(1).max(65535).default(8790).description('The local port the tunnel listens on; the device dials this.'),
  }).default({ enabled: false, host: '', port: 22, user: '', keyPath: '', remotePort: 8790, localPort: 8790 })
    .description('How to reach the hub when it is not directly reachable: a tunnel this device opens and keeps open.'),
})
/**
 * Why every field is volatile.
 *
 * Not for hot reload: it is the switch that makes the entry visible to DSH's settings system at all. `dsh-settings`
 * skips every plugin entry whose `volatileForm(schema)` is undefined, and that only finds fields reachable through a
 * volatile ancestor. Without it the configuration page has no form to render and sits on "reading configuration"
 * forever — no fields, no test button, no save.
 *
 * A volatile field arrives wrapped, so its value is read with `.get()`; `configured()` is what unwraps a whole
 * `NodeConfig` for the code that would rather not know. Marking the object instead of each field is not an option:
 * `.volatile()` on the object replaces every default with `{}`, so `Config({})` loses all of them.
 */

/**
 * What `apply` actually receives: every field wrapped, since each one is volatile.
 *
 * Declared as an alias rather than inferred so the plugin's public signature does not name a `schemastery` symbol the
 * emitted declaration cannot reference portably.
 */
export type ConfigInput = { [K in keyof NodeConfig]: NodeConfig[K] | Volatile<NodeConfig[K]> }

/**
 * The schema, asserted rather than annotated.
 *
 * An annotation makes the declaration portable but cannot express what a volatile field does to a field's type, so the
 * mismatch moves into the annotation. The assertion keeps the published `.d.ts` free of `schemastery` internals and
 * puts the shape in one place; `configured()` is what re-establishes the real types at every read.
 */
const Typed = ConfigSchema as unknown as Schemastery<NodeConfig>
export { Typed as Config }

/**
 * What this configuration still needs before the device can dial its hub, or undefined when it is complete.
 *
 * A missing value is reported by name so an operator can fill it in without reading the source; a value that is only
 * whitespace counts as missing, because a device that dials a blank address retries forever and looks merely offline.
 */
/**
 * The address this device dials.
 *
 * With the tunnel on, that is the local end of it: `url` names the hub at its own address, which the tunnel exists to
 * make reachable, so dialling `url` would bypass the tunnel entirely and look like an offline device. Keeping the two
 * cases in one function is what stops `apply` from picking the wrong one.
 */
export function hubUrlOf(config: NodeConfig): string {
  return config.ssh.enabled ? `ws://127.0.0.1:${config.ssh.localPort}` : config.url
}

export function missingConfiguration(config: NodeConfig): string | undefined {
  const missing: string[] = []
  // The address is only required when there is no tunnel: with one, the device dials its local end and `url` is unused.
  if (config.ssh.enabled) {
    if (config.ssh.host.trim() === '') missing.push('ssh.host')
    if (config.ssh.user.trim() === '') missing.push('ssh.user')
    if (config.ssh.keyPath.trim() === '') missing.push('ssh.keyPath')
  } else if (config.url.trim() === '') missing.push('url')
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
export async function apply(ctx: Context, raw: ConfigInput): Promise<void> {
  // Every field is volatile, so `raw` holds wrappers; everything below wants plain values.
  const config = configured(raw)
  // The configuration page has to work on a device that is not configured yet — that is precisely when someone opens
  // it — so the routes go up before the check below, not after it. `webServer` is injected optionally rather than
  // listed in `inject`: a headless or CLI DSH has no web server and must still take work, losing only the page.
  ctx.inject(['webServer'], child => {
    // The service shape is declared locally rather than imported from `@deepseek-ai/dsh-host-webserver`: the device
    // package stays thin, and this plugin needs two members of that service, not its whole surface.
    const host = (child as unknown as { webServer: RouteHost }).webServer
    child.effect(() => registerNodeRoutes(host, sshDirectory()))
  })
  const missing = missingConfiguration(config)
  if (missing !== undefined) {
    ctx.logger.info('%s', missing)
    return
  }
  const jobs = new JobSessions(ctx)
  const client = new NodeClient({
    url: hubUrlOf(config),
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
  // With a tunnel, the client waits for the local port to answer before dialling it: a client that starts early spends
  // its first attempts on a port nothing is listening on, which reads in the log like the hub being down.
  const tunnel = config.ssh.enabled
    ? new Tunnel({ ssh: config.ssh, log: text => ctx.logger.warn('%s', text),
      onState: (state, failure) => {
        ctx.logger.info('dsh-foreman-node tunnel: %s', failure === undefined ? state : `${state} (${failure})`)
        if (state === 'connected') client.start()
      } })
    : undefined
  if (tunnel === undefined) client.start()
  else tunnel.start()
  ctx.effect(() => () => { tunnel?.stop(); client.stop() })
  ctx.logger.info('dsh-foreman-node %s is dialling %s as %s', VERSION, hubUrlOf(config), config.deviceId)
}

/** The directory the key list reads; `~/.ssh` on a machine where the current user is the one configuring it. */
export function sshDirectory(): string {
  return join(homedir(), '.ssh')
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

export { configured, SSH_DEFAULTS, type NodeConfig, type NodeRoot, type SshConfig } from './config.ts'
export { NodeClient } from './client.ts'
export { Tunnel, tunnelArgs } from './tunnel.ts'
export { listKeys } from './keys.ts'
export { registerNodeRoutes, testArgs } from './routes.ts'
export { JobSessions } from './session.ts'
export { foremanReportTool, REPORT_STATES } from './report-tool.ts'
export type { Frame, Root, FrameAttachment } from './protocol.ts'
