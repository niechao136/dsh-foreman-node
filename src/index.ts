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
import { configured, EXPOSE_DEFAULTS, SSH_DEFAULTS, type NodeConfig, type NodeRoot, type SshConfig } from './config.ts'
import { Expose } from './expose.ts'
import { registerNodeRoutes, type AccessAnswer, type RouteHost } from './routes.ts'
import { builtInAnswer, FALLBACK_PRESET, type PresetAnswer, type PresetOption } from './presets.ts'
import { Tunnel } from './tunnel.ts'
import { JobSessions } from './session.ts'
import type { Frame } from './protocol.ts'

/**
 * DSH's loader publishes this when a save changes only volatile values.
 *
 * Declared here rather than imported from `@deepseek-ai/dsh-loader`: the device package depends on nothing but the
 * host's own session services, and an install that pulled the loader in would be depending on the composition root
 * to tell it about its own configuration. The event carries the changed paths; this plugin rebuilds on any of them.
 */
declare module '@deepseek-ai/cordis' {
  interface Events {
    'loader/volatile-update'(paths: readonly (readonly string[])[]): void
  }
}

/**
 * Version reported in the hello, so the hub can tell which device build is talking.
 *
 * Kept beside `package.json` rather than derived from it: the hello has to survive a profile whose package metadata
 * is missing, and a device that cannot say what it is would be rejected. `tests/version.spec.ts` pins the two
 * together, because this constant silently drifted three releases behind.
 */
export const VERSION = '0.6.0'

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
  // Every field here is volatile for the same reason as the top level: `isVolatilePath` walks into this object, so a
  // non-volatile child makes the whole section unwritable and the page reports "could not save". Marked per field
  // rather than on the object, which would replace this block's default with `{}`.
  ssh: s.object({
    enabled: s.boolean().default(false).volatile().description('Reach the hub through an SSH tunnel this device starts itself.'),
    host: s.string().default('').volatile().description('The hub machine, such as 203.0.113.10 or its ~/.ssh/config alias.'),
    // min(1), not just natural(): an empty port box becomes 0, and 0 is a port the tunnel would happily dial.
    port: s.natural().min(1).max(65535).default(22).volatile().description('The hub machine\'s SSH port.'),
    user: s.string().default('').volatile().description('The SSH user on the hub machine.'),
    keyPath: s.string().default('').volatile().description('The private key this device authenticates with; the page lists these from ~/.ssh.'),
    remotePort: s.natural().min(1).max(65535).default(8790).volatile().description('The port the hub listens on, on the hub machine.'),
    localPort: s.natural().min(1).max(65535).default(8790).volatile().description('The local port the tunnel listens on; the device dials this.'),
  }).default({ enabled: false, host: '', port: 22, user: '', keyPath: '', remotePort: 8790, localPort: 8790 })
    .description('How to reach the hub when it is not directly reachable: a tunnel this device opens and keeps open.'),
  // Same per-field volatility as `ssh`, and the same reason: `isVolatilePath` walks into the block, so one
  // unmarked child makes the whole section unwritable and the page reports "could not save".
  expose: s.object({
    enabled: s.boolean().default(false).volatile()
      .description('Publish this machine\'s own DSH page on the hub, so a browser there can open it.'),
    remotePort: s.natural().min(1).max(65535).default(13100).volatile()
      .description('The port the hub should listen on, on its own loopback. Use the check button: a port the hub already has makes the forward fail on every attempt.'),
  }).default({ enabled: false, remotePort: 13100 })
    .description('Publishing this machine\'s web page on the hub. Off by default: a device takes work without it.'),
  jobPreset: s.string().default('workspace-write').volatile()
    .description('The permission preset a job runs under. Use one that keeps the workspace boundary and never asks, because nobody is at this machine to answer.'),
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
 * The parts of the device that are built from configuration and torn down when it changes.
 *
 * They are one object rather than three locals because the thing that changes is the configuration and all three
 * read it: a save that reconnected the tunnel but left the client dialling the old address would look like a hub
 * that stopped answering. `stop` is idempotent so a rebuild and a disposal can both call it.
 */
interface Running {
  jobs: JobSessions
  client: NodeClient
  tunnel: Tunnel | undefined
  expose: Expose | undefined
  stop(): void
}

/**
 * Start the device.
 *
 * A package that has just been installed has its row in the profile patch with no values in it yet. Activating
 * cleanly and saying what is still missing keeps the whole profile healthy; throwing here is what made a fresh
 * install report the profile as broken.
 *
 * The plugin returns once the connection is attempted, not once it succeeds: a device must boot and stay usable
 * while its hub is unreachable, and the client keeps retrying in the background.
 *
 * Everything built from `con` is rebuilt when `con` changes, which is why the work lives in `start`. Every field is
 * volatile, so DSH commits a save into these references and emits `loader/volatile-update` instead of restarting the
 * plugin — the page's "restart DSH" line was true only because nothing listened. A save that arrives while the
 * device is still unconfigured must also start it, which is the case a page in a fresh profile produces.
 */
export async function apply(ctx: Context, raw: ConfigInput): Promise<void> {
  // The configuration references themselves: every field is volatile, so this object holds live references and
  // `configured` reads the current values out of them at the moment a run starts.
  const con = raw
  // The configuration page has to work on a device that is not configured yet — that is precisely when someone opens
  // it — so the routes go up before the check below, not after it. `webServer` is injected optionally rather than
  // listed in `inject`: a headless or CLI DSH has no web server and must still take work, losing only the page.
  ctx.inject(['webServer'], child => {
    // The service shape is declared locally rather than imported from `@deepseek-ai/dsh-host-webserver`: the device
    // package stays thin, and this plugin needs two members of that service, not its whole surface.
    const host = (child as unknown as { webServer: RouteHost }).webServer
    child.effect(() => registerNodeRoutes(host, sshDirectory(), undefined, () => accessOf(child, host),
      () => presetsOf(child)))
  })
  let running: Running | undefined
  const stop = (): void => { running?.stop(); running = undefined }
  const start = (): void => {
    stop()
    const config = configured(con as unknown as object)
    const missing = missingConfiguration(config)
    if (missing !== undefined) {
      ctx.logger.info('%s', missing)
      return
    }
    running = run(ctx, config)
  }
  start()
  // A save does not restart this plugin: every field is volatile, so DSH commits the new values into `con` and tells
  // the owning fiber which paths changed. Rebuilding here is what makes a save take effect without a restart — and it
  // is the only notification that arrives, because the ordinary update path is exactly the one DSH skips for a
  // volatile-only change. `internal/update` is therefore not listened to: it never fires for this plugin, and
  // reacting to it would restart the device a second time on any change that did.
  ctx.on('loader/volatile-update', () => { start() })
  ctx.effect(() => stop)
}

/** Build, start and describe one run of the device from a complete configuration. */
function run(ctx: Context, config: NodeConfig): Running {
  const jobs = new JobSessions(ctx, config.jobPreset)
  const client = new NodeClient({
    url: hubUrlOf(config),
    deviceId: config.deviceId,
    token: config.token,
    version: VERSION,
    roots: () => config.roots.map(root => ({ project: root.project, path: root.path })),
    running: () => jobs.running(),
    heartbeatMs: config.heartbeatMs,
    reconnectMs: config.reconnectMs,
    outboxFile: outboxFile(),
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
  // Publishing this machine's page is the other direction and its own process. A hub that refuses the port costs
  // the device its page, never its work, so this is started beside the connection and not in front of it.
  const expose = config.expose.enabled
    ? new Expose({ ssh: config.ssh, remotePort: config.expose.remotePort, localPort: () => ctx.get('webServer')?.port,
      log: text => ctx.logger.warn('%s', text),
      onState: (state, failure) => {
        ctx.logger.info('dsh-foreman-node expose: %s', failure === undefined ? state : `${state} (${failure})`)
      } })
    : undefined
  expose?.start()
  ctx.logger.info('dsh-foreman-node %s is dialling %s as %s', VERSION, hubUrlOf(config), config.deviceId)
  return { jobs, client, tunnel, expose, stop: () => { expose?.stop(); tunnel?.stop(); client.stop() } }
}

/**
 * The port, scheme and token this machine's page can be opened with.
 *
 * The token is asked of the connection service rather than read from anywhere: it is minted per process, held
 * privately, and `authenticatedUrl` already knows how to put it in a URL while preserving the authority and mount.
 * Reading a credential file or a log would be a second, worse implementation of the same thing — and on a host with
 * no connection service (headless, CLI) there is no token at all, which is what `token: undefined` reports.
 */
export function accessOf(child: Context, host: RouteHost): AccessAnswer {
  const protocol = host.protocol === 'https:' ? 'https:' : 'http:'
  const port = ctxPort(child) ?? (typeof host.port === 'number' ? host.port : undefined)
  const token = (() => {
    try {
      const url = child.get('connection')?.authenticatedUrl?.(`${protocol}//127.0.0.1:${String(port ?? 0)}`)
      return typeof url === 'string' ? new URL(url).searchParams.get('token') ?? undefined : undefined
    } catch { return undefined }
  })()
  return { localPort: port, protocol, token }
}

/**
 * The permission presets this host would accept, for the page's picker.
 *
 * Read from the host's own catalog rather than listed here: a profile patch adds presets (`read-only` in this
 * workspace's patch) and the composition contributes others, so a list kept in this package would drift from what
 * `permissionPresets.set` actually takes. A host whose service is missing or throwing answers with the built-in
 * table, because a page with a short list is better than a page whose picker never loads — and a name this list does
 * not have still reaches the job and falls back there, not here.
 */
export function presetsOf(child: Context): PresetAnswer {
  try {
    const catalog = child.get('permissionPresets')?.catalog?.()
    if (catalog === undefined || !Array.isArray(catalog.options) || catalog.options.length === 0) return builtInAnswer()
    // Copied field by field: the catalog's objects are the service's own and the answer is serialized to the page.
    const options: PresetOption[] = []
    for (const option of catalog.options) {
      if (typeof option?.value !== 'string' || option.value.trim() === '') continue
      options.push({ value: option.value, name: typeof option.name === 'string' ? option.name : option.value,
        ...(typeof option.description === 'string' ? { description: option.description } : {}) })
    }
    if (options.length === 0) return builtInAnswer()
    const defaultPreset = typeof catalog.defaultPreset === 'string' && catalog.defaultPreset.trim() !== ''
      ? catalog.defaultPreset
      : FALLBACK_PRESET
    return { options, defaultPreset, source: 'host' }
  } catch { return builtInAnswer() }
}

/** The web server's own port, read defensively: a service that is not there yet must not break the page. */
function ctxPort(ctx: Context): number | undefined {
  try {
    const port = (ctx.get('webServer') as { port?: unknown } | undefined)?.port
    return typeof port === 'number' && Number.isInteger(port) && port > 0 ? port : undefined
  } catch { return undefined }
}

/** The directory the key list reads; `~/.ssh` on a machine where the current user is the one configuring it. */
export function sshDirectory(): string {
  return join(homedir(), '.ssh')
}

/**
 * Where reports wait while the hub is unreachable.
 *
 * Under the DSH home rather than a temp directory: the queue must outlive a restart, because the whole point is that a
 * report produced while the connection was down still reaches the hub. `DSH_HOME` is where the host keeps everything
 * else this profile owns, and a device that runs under a service account gets the same path consistently.
 */
export function outboxFile(): string {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'state', 'foreman-node', 'outbox.jsonl')
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

export { configured, SSH_DEFAULTS, EXPOSE_DEFAULTS, type NodeConfig, type NodeRoot, type SshConfig, type ExposeConfig } from './config.ts'
export { Expose, exposeArgs, explainExpose, forwardRefused } from './expose.ts'
export { NodeClient } from './client.ts'
export { Tunnel, tunnelArgs } from './tunnel.ts'
export { listKeys } from './keys.ts'
export { registerNodeRoutes, testArgs, portCheckArgs, portCheckScript, parsePortCheck, type AccessAnswer, type PortCheckAnswer } from './routes.ts'
export { JobSessions } from './session.ts'
export { foremanReportTool, REPORT_STATES } from './report-tool.ts'
export type { Frame, Root, FrameAttachment } from './protocol.ts'
