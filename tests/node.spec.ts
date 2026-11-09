import { describe, expect, it, vi } from 'vitest'
import { JOB_PRESET, JobSessions } from '../src/session.ts'
import { foremanReportTool } from '../src/report-tool.ts'
import { parseFrame } from '../src/protocol.ts'
import { apply, accessOf, Config, configured, hubUrlOf, missingConfiguration, SSH_DEFAULTS } from '../src/index.ts'

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
  /** Listeners by event name, so a test can fire the one a save would fire. */
  const listeners = new Map<string, (() => void)[]>()
  const host = {
    logger: { info: vi.fn(), warn: vi.fn() },
    effect: (callback: () => () => void) => { effects.push(callback()) },
    on: (event: string, listener: () => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
      return () => {}
    },
    get: (name: string) => services[name],
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
  /** Fires every listener registered for one event, as DSH does after committing a volatile-only save. */
  const fire = (event: string, ...args: unknown[]) => { for (const listener of listeners.get(event) ?? []) listener(...args as []) }
  return { ctx: host as never, registered, injected, disposers, listeners, fire }
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

/**
 * What a save does.
 *
 * Every field is volatile, so DSH commits a save into the running references and emits `loader/volatile-update`
 * instead of restarting the plugin. Before this was listened to, the page had to tell people to restart DSH — the
 * values were already committed and nothing acted on them, so the device kept dialling the old address.
 */
describe('a save that changes configuration', () => {
  it('reconnects from the new values without a restart', async () => {
    const { ctx, fire } = hostFor({})
    const config = Config({ url: '', deviceId: 'd', token: 't' } as never) as unknown as Record<string, unknown>
    await apply(ctx, config as never)
    const info = (ctx as unknown as { logger: { info: ReturnType<typeof vi.fn> } }).logger.info
    // Unconfigured, so nothing was dialled yet: exactly the state a fresh profile is in when the page is opened.
    const before = info.mock.calls.map(call => call[2]).filter(value => typeof value === 'string')
    expect(before).not.toContain('wss://hub.example')
    // The save writes into the same references the plugin holds, then announces which paths moved.
    ;(config as { url: { get(): string } }).url = { get: () => 'wss://hub.example' }
    fire('loader/volatile-update', [['url']])
    const after = info.mock.calls.map(call => call[2]).filter(value => typeof value === 'string')
    expect(after).toContain('wss://hub.example')
  })

  it('stops what the old configuration started before starting the new one', async () => {
    // Two connections from one device would take every assignment twice; a replace must not leave the old one up.
    const { ctx, fire, disposers } = hostFor({})
    const config = Config({ url: 'ws://first.example', deviceId: 'd', token: 't' } as never) as unknown as Record<string, unknown>
    await apply(ctx, config as never)
    ;(config as { url: { get(): string } }).url = { get: () => 'ws://second.example' }
    fire('loader/volatile-update', [['url']])
    const info = (ctx as unknown as { logger: { info: ReturnType<typeof vi.fn> } }).logger.info
    const dialled = info.mock.calls.map(call => call[2]).filter(value => typeof value === 'string')
    expect(dialled).toEqual(['ws://first.example', 'ws://second.example'])
    // Disposal tears down whatever is current, not the first run.
    disposers()
  })
})

/** What the page is told about the address this machine can be opened at. */
describe('the address the page reports', () => {
  it('reports the web server port and the token, and asks the connection service for the URL', () => {
    // Neither value is in the configuration: the port is assigned at startup and the token is minted per process.
    const asked: string[] = []
    const child = { get: (name: string) => name === 'connection'
      ? { authenticatedUrl: (base: string) => { asked.push(base); return `${base}/?token=abc` } }
      : undefined }
    const answer = accessOf(child as never, { port: 65277, protocol: 'http:' } as never)
    expect(answer).toEqual({ localPort: 65277, protocol: 'http:', token: 'abc' })
    expect(asked).toEqual(['http://127.0.0.1:65277'])
  })

  it('reports the port with no token on a host that has no connection service', () => {
    // A headless DSH has a web server port and no browser auth; the page says the token is unavailable rather than
    // printing a link that lands on the sign-in wall.
    const answer = accessOf({ get: () => undefined } as never, { port: 65277 } as never)
    expect(answer).toMatchObject({ localPort: 65277, protocol: 'http:' })
    expect(answer.token).toBeUndefined()
  })

  it('carries the scheme through, so a TLS-terminated host builds an https address', () => {
    const child = { get: () => ({ authenticatedUrl: (base: string) => `${base}/?token=t` }) }
    expect(accessOf(child as never, { port: 443, protocol: 'https:' } as never))
      .toEqual({ localPort: 443, protocol: 'https:', token: 't' })
  })
})

describe('a job that ends without reporting', () => {
  /** A host whose Session records listeners, so a test can drive `turn/end` itself. */
  function hostFor(history: unknown[]) {
    const listeners: ((session: unknown, event: unknown) => void)[] = []
    type Execute = ((args: unknown, execution: unknown) => Promise<unknown>) | undefined
    const toolCtx: { execute: Execute; tools: { register: (d: { execute: Execute }) => { dispose: () => void } }
      effect: (fn: () => () => void) => () => void
      on: (name: string, listener: (session: unknown, event: unknown) => void) => () => void } = {
      execute: undefined,
      tools: { register: (definition: { execute: Execute }) => { toolCtx.execute = definition.execute; return { dispose: () => {} } } },
      effect: (fn: () => () => void) => { fn(); return () => {} },
      on: (name: string, listener: (session: unknown, event: unknown) => void) => {
        if (name === 'session/event') listeners.push(listener)
        return () => {}
      },
    }
    const ctx = {
      workspaceRegistry: { create: async (cwd: string) => ({ id: cwd, attachSession: async () => {} }), list: () => [], get: () => undefined },
      sessionController: {
        resolveAgent: async (sessionId: string) => ({ agent: { id: sessionId, session: { id: sessionId, header: {} },
          inbox: { nextTurn: [], nextStep: [] }, ctx: toolCtx } }),
        create: async () => {}, rename: async () => {},
      },
      permissionPresets: { set: () => {} },
      logger: { warn: vi.fn(), info: vi.fn() },
      sessionPersistence: { flush: async () => {},
        open: async () => ({ read: async (offset: number) => offset === 0 ? { events: history } : { events: [] },
          [Symbol.asyncDispose]: async () => {} }) },
    }
    return { ctx, listeners, toolCtx }
  }

  it('is closed out as ready with the last thing the model said', async () => {
    // A real device did thirty steps of work and never called foreman_report, so the hub waited at `running`
    // forever. The tool alone does not guarantee a call; the turn ending has to close the job out.
    const history = [
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'first thought' }] } } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'the projects are dsh-foreman and dsh-foreman-node' }] } } },
    ]
    const { ctx, listeners } = hostFor(history)
    const reported: { assignmentId: string; report: { state: string; summary: string } }[] = []
    const jobs = new JobSessions(ctx as never)
    const sessionId = await jobs.ensure({ assignmentId: 'a1', directory: '/w', title: 'job a1' },
      (assignmentId, report) => { reported.push({ assignmentId, report }) })
    for (const listener of listeners) listener({ id: sessionId }, { type: 'turn/end' })
    await vi.waitFor(() => expect(reported).toHaveLength(1))
    expect(reported[0]!.assignmentId).toBe('a1')
    expect(reported[0]!.report.state).toBe('ready')
    expect(reported[0]!.report.summary).toContain('the projects are dsh-foreman')
  })

  it('does not report again for a job that already reported through the tool', async () => {
    const { ctx, listeners, toolCtx } = hostFor([{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'done' }] } } }])
    const reported: { summary: string }[] = []
    const jobs = new JobSessions(ctx as never)
    const sessionId = await jobs.ensure({ assignmentId: 'a2', directory: '/w', title: 'job a2' },
      (_id, report) => { reported.push(report) })
    await toolCtx.execute!({ state: 'ready', summary: 'reported properly' }, { signal: new AbortController().signal })
    for (const listener of listeners) listener({ id: sessionId }, { type: 'turn/end' })
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(reported).toHaveLength(1)
    expect(reported[0]!.summary).toBe('reported properly')
  })
})

describe('the permission a job runs under', () => {
  it('uses the preset the device configured, not a hard-coded one', async () => {
    // A device has nobody in front of it, so a preset that asks stops the work instead of protecting it. The operator
    // chooses a quiet preset on their own machine; the plugin must honour it.
    const presets: string[] = []
    const ctx = {
      workspaceRegistry: { create: async (cwd: string) => ({ id: cwd, attachSession: async () => {} }), list: () => [], get: () => undefined },
      sessionController: { resolveAgent: async (sessionId: string) => ({ agent: { id: sessionId, session: { id: sessionId, header: {} },
        inbox: { nextTurn: [], nextStep: [] }, ctx: { tools: { register: () => ({ dispose: () => {} }) } } } }),
        create: async () => {}, rename: async () => {} },
      permissionPresets: { set: (_session: unknown, preset: string) => { presets.push(preset) } },
      logger: { warn: vi.fn(), info: vi.fn() },
      sessionPersistence: { flush: async () => {}, open: async () => ({ read: async () => ({ events: [] }), [Symbol.asyncDispose]: async () => {} }) },
    }
    const jobs = new JobSessions(ctx as never, 'workspace-write-never-ask')
    await jobs.ensure({ assignmentId: 'p1', directory: '/w', title: 'job p1' })
    expect(presets).toEqual(['workspace-write-never-ask'])
  })

  it('still defaults to workspace-write when the device names no preset', () => {
    expect(JOB_PRESET).toBe('workspace-write')
  })
})

it('falls back to the default preset when the configured one does not exist on this host', async () => {
  // A preset name is configuration, and configuration can be wrong: the host's table moved, or someone typed it.
  // That must not be the reason a job never starts — the work is still worth doing under the default.
  const presets: string[] = []
  const ctx = {
    workspaceRegistry: { create: async (cwd: string) => ({ id: cwd, attachSession: async () => {} }), list: () => [], get: () => undefined },
    sessionController: { resolveAgent: async (sessionId: string) => ({ agent: { id: sessionId, session: { id: sessionId, header: {} },
      inbox: { nextTurn: [], nextStep: [] }, ctx: { tools: { register: () => ({ dispose: () => {} }) } } } }),
      create: async () => {}, rename: async () => {} },
    permissionPresets: { set: (_s: unknown, preset: string) => {
      if (preset === 'does-not-exist') throw new Error('unknown preset')
      presets.push(preset) } },
    logger: { warn: vi.fn(), info: vi.fn() },
    sessionPersistence: { flush: async () => {}, open: async () => ({ read: async () => ({ events: [] }), [Symbol.asyncDispose]: async () => {} }) },
  }
  const jobs = new JobSessions(ctx as never, 'does-not-exist')
  await expect(jobs.ensure({ assignmentId: 'f1', directory: '/w', title: 'job f1' })).resolves.toBeTruthy()
  expect(presets).toEqual([JOB_PRESET])
})
