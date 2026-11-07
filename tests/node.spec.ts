import { describe, expect, it, vi } from 'vitest'
import { JobSessions } from '../src/session.ts'
import { foremanReportTool } from '../src/report-tool.ts'
import { parseFrame } from '../src/protocol.ts'
import { apply, Config, configured, hubUrlOf, missingConfiguration, SSH_DEFAULTS } from '../src/index.ts'

/**
 * A host that behaves like DSH for the parts a job touches: `resolveAgent` fails until `create` has run, `create`
 * records the Session, and permissions are recorded rather than applied. A simpler fake cannot tell "creates once"
 * from "creates on every call", which is the property the first test exists to pin.
 */
const ctx = () => {
  const created: string[] = []
  const presets: { session: unknown; preset: string }[] = []
  const existing = new Set<string>()
  // Tools a job Session registers, shared with the test so it can assert what was attached and call it.
  const registered: { name: string; execute?: (args: unknown, execution: { signal: AbortSignal }) => Promise<unknown> }[] = []
  const sessionCtx = { tools: { register: (definition: { name: string; execute?: typeof registered[number]['execute'] }) => {
    registered.push(definition)
    return { dispose: () => {} }
  } } }
  const fake = {
    workspaceRegistry: { create: async (cwd: string) => ({ id: cwd, attachSession: async () => {} }) },
    sessionController: {
      resolveAgent: async (sessionId: string) => existing.has(sessionId)
        ? { agent: { id: sessionId, session: { id: sessionId }, inbox: { nextTurn: [], nextStep: [] }, ctx: sessionCtx } }
        : { error: { code: 'session/not-found' } },
      create: async ({ sessionId }: { sessionId: string }) => { created.push(sessionId); existing.add(sessionId) },
      rename: async () => {},
    },
    permissionPresets: { set: (session: unknown, preset: string) => { presets.push({ session, preset }) } },
    logger: { warn: vi.fn() },
    sessionPersistence: { flush: async () => {}, open: async () => ({ read: async () => ({ events: [] }), [Symbol.asyncDispose]: async () => {} }) },
  }
  return { created, presets, registered, fake: fake as never }
}

it('creates one job session per assignment and reuses it on a redelivery', async () => {
  const { created, fake } = ctx()
  const jobs = new JobSessions(fake)
  const first = await jobs.ensure({ assignmentId: 'a1', directory: '/w/shop', title: 'job a1' })
  const second = await jobs.ensure({ assignmentId: 'a1', directory: '/w/shop', title: 'job a1' })
  expect([first, second, created]).toEqual(['job-a1', 'job-a1', ['job-a1']])
})

it('restricts the job session to workspace-write, never danger-full-access', async () => {
  const { presets, fake } = ctx()
  const jobs = new JobSessions(fake)
  await jobs.ensure({ assignmentId: 'a1', directory: '/w/shop', title: 'job a1' })
  expect(presets.map(entry => entry.preset)).toEqual(['workspace-write'])
})

it('reports what it holds and forgets a job the hub stopped', async () => {
  const { fake } = ctx()
  const jobs = new JobSessions(fake)
  await jobs.ensure({ assignmentId: 'a1', directory: '/w/shop', title: 'job a1' })
  expect(jobs.running()).toEqual(['a1'])
  jobs.forget('a1')
  expect(jobs.running()).toEqual([])
})

it('attaches the foreman_report tool to the job session, once per assignment', async () => {
  const { registered, fake } = ctx()
  const jobs = new JobSessions(fake)
  const report = vi.fn()
  await jobs.ensure({ assignmentId: 'a1', directory: '/w/shop', title: 'job a1' }, report)
  await jobs.ensure({ assignmentId: 'a1', directory: '/w/shop', title: 'job a1' }, report)
  expect(registered.map(definition => definition.name)).toEqual(['foreman_report'])
})

it('reports through the registered tool with the device state', async () => {
  const { registered, fake } = ctx()
  const sent: unknown[] = []
  const jobs = new JobSessions(fake)
  await jobs.ensure({ assignmentId: 'a1', directory: '/w/shop', title: 'job a1' },
    (assignmentId, report) => sent.push({ assignmentId, report }))
  await registered[0]!.execute!({ state: 'ready', summary: 'done' }, { signal: new AbortController().signal })
  expect(sent).toEqual([{ assignmentId: 'a1', report: { state: 'ready', summary: 'done' } }])
})

it('turns a foreman_report call into a report with the device state', async () => {
  const sent: unknown[] = []
  const tool = foremanReportTool({ report: (assignmentId, report) => sent.push({ assignmentId, report }) }, 'a1')
  await tool.execute({ state: 'blocked', summary: 'need the VPN', question: 'Should I turn the VPN on?' }, { signal: new AbortController().signal })
  expect(sent).toEqual([{ assignmentId: 'a1', report: { state: 'blocked', summary: 'need the VPN', question: 'Should I turn the VPN on?' } }])
})

it('refuses a dropped state from a device', async () => {
  const tool = foremanReportTool({ report: vi.fn() }, 'a1')
  await expect(tool.execute({ state: 'dropped', summary: 'x' }, { signal: new AbortController().signal })).rejects.toThrow(/dropped/)
})

it('refuses an empty summary', async () => {
  const tool = foremanReportTool({ report: vi.fn() }, 'a1')
  await expect(tool.execute({ state: 'ready', summary: '   ' }, { signal: new AbortController().signal })).rejects.toThrow(/summary/)
})

it('offers no dropped option to the model at all', () => {
  const parameters = foremanReportTool({ report: vi.fn() }, 'a1').parameters as { properties: { state: { enum: string[] } } }
  expect(parameters.properties.state.enum).toEqual(['progress', 'ready', 'blocked', 'failed'])
})

it('round-trips a frame the way the hub will read it', () => {
  const frame = { v: 1, type: 'report' as const, frameId: 'f1', assignmentId: 'a1', state: 'ready' as const, summary: 'ok' }
  expect(parseFrame(JSON.stringify(frame))).toEqual(frame)
})

/**
 * The device package is installed on a machine that may not have a hub yet. A bundle patch inserts the row the
 * moment the package is added to a profile, so `apply` runs with whatever config exists — including none at all.
 * Refusing to activate there turns the whole profile red with "invalid config", which is what a fresh install saw.
 */
describe('a device with no configuration yet', () => {
  it('does not require a hub address, a device id or a token to activate', () => {
    const parsed = configured(Config({} as never))
    expect(parsed.url).toBe('')
    expect(parsed.deviceId).toBe('')
    expect(parsed.token).toBe('')
  })

  it('says what is missing, and names the command that fills it in', () => {
    expect(missingConfiguration(configured(Config({} as never)))).toMatch(/dsh-foreman-node is not configured yet/)
    expect(missingConfiguration(configured(Config({} as never)))).toMatch(/url/)
  })

  it('reports nothing missing once the three values are there', () => {
    expect(missingConfiguration(configured(Config({ url: 'wss://hub.example.com', deviceId: 'laptop', token: 'tok' } as never)))).toBeUndefined()
  })

  it('still treats a blank address as unconfigured, so a half-filled row does not dial nowhere', () => {
    expect(missingConfiguration(configured(Config({ url: '   ', deviceId: 'laptop', token: 'tok' } as never)))).toMatch(/url/)
  })
})

/**
 * The address the device dials is not always the one written in `url`: with the tunnel on, the device reaches the hub
 * through a port it listens on itself, so dialling `url` would go straight past the tunnel. These four cases pin which
 * address wins and what still has to be filled in for each.
 */
describe('the address the device dials', () => {
  /** A full config from the schema's own defaults, so a field added later cannot make this helper stale. */
  const config = (overrides: Record<string, unknown> = {}) => configured(Config(overrides as never))

  it('derives the tunnel address from the local port when the tunnel is on', () => {
    const parsed = configured(Config({ url: 'wss://ignored.example', ssh: { enabled: true, localPort: 8790 } } as never))
    expect(hubUrlOf(parsed)).toBe('ws://127.0.0.1:8790')
  })

  it('uses the configured address when the tunnel is off', () => {
    const parsed = configured(Config({ url: 'wss://foreman.example', ssh: { enabled: false } } as never))
    expect(hubUrlOf(parsed)).toBe('wss://foreman.example')
  })

  it('reports a missing address only when the tunnel is off', () => {
    expect(missingConfiguration(configured(Config({ url: '', ssh: { enabled: false } } as never)))).toMatch(/url/)
    expect(missingConfiguration(configured(Config({ url: '', ssh: { enabled: true } } as never)))).not.toMatch(/url/)
  })

  it('still requires a host, a user and a key when the tunnel is on', () => {
    const missing = missingConfiguration(configured(Config({ url: '', ssh: { enabled: true, host: '', user: '', keyPath: '' } } as never)))
    expect(missing).toMatch(/ssh\.host/)
    expect(missing).toMatch(/ssh\.user/)
    expect(missing).toMatch(/ssh\.keyPath/)
  })
})

/**
 * A host for `apply`: enough of a Cordis context to record what the plugin asks for, plus whatever services the test
 * wants present. `inject` runs its callback only when the named service is there, which is exactly the behaviour the
 * device relies on to stay alive without a web server.
 */
function hostFor(services: Record<string, unknown> = {}) {
  const registered: string[] = []
  const effects: (() => void)[] = []
  const injected: string[][] = []
  const host = {
    logger: { info: vi.fn(), warn: vi.fn() },
    effect: (callback: () => () => void) => { effects.push(callback()) },
    inject: (names: string[], callback: (child: unknown) => void) => {
      injected.push(names)
      if (names.every(name => services[name] !== undefined)) {
        callback({ ...host, ...Object.fromEntries(names.map(name => [name, services[name]])) })
      }
    },
    ...services,
  }
  // The web server service is passed through so `registerNodeRoutes` sees a port and a register function.
  if (services['webServer'] !== undefined) {
    (services['webServer'] as { register: (route: { path: string }) => () => void }).register = (route) => {
      registered.push(route.path)
      return () => {}
    }
  }
  const disposers = () => { for (const dispose of effects) dispose() }
  return { ctx: host as never, registered, injected, disposers }
}

describe('starting the device', () => {
  it('registers its routes even when the device has nothing configured yet', async () => {
    const { ctx, registered } = hostFor({ webServer: { port: 3088 } })
    await apply(ctx, Config({ url: '', deviceId: '', token: '' } as never))
    // A fresh install opens the page to become configured, so the page must answer before there is any config.
    expect(registered).toEqual(['/foreman-node'])
  })

  it('asks for the web server optionally rather than requiring it', async () => {
    const { ctx, injected, registered } = hostFor({})
    await apply(ctx, Config({ url: 'ws://hub', deviceId: 'd', token: 't' } as never))
    expect(injected).toEqual([['webServer']])
    // Without a web server there is no page, but the device itself is unaffected.
    expect(registered).toEqual([])
  })

  it('dials the tunnel address rather than the configured one when the tunnel is on', async () => {
    const { ctx } = hostFor({})
    // A blank host/user/key is refused before dialling, so this reads the address the log reports.
    const config = Config({ url: 'wss://ignored.example', deviceId: 'd', token: 't',
      ssh: { enabled: true, host: 'h', user: 'u', keyPath: '/k', localPort: 8790 } } as never)
    await apply(ctx, config)
    // The plugin logs `'… dialling %s as %s', version, url, id`, so the address is the third argument.
    const info = (ctx as unknown as { logger: { info: ReturnType<typeof vi.fn> } }).logger.info
    const dialled = info.mock.calls.map(call => call[2]).filter(value => typeof value === 'string')
    expect(dialled).toContain('ws://127.0.0.1:8790')
    expect(dialled).not.toContain('wss://ignored.example')
  })
})
