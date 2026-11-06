import { expect, it, vi } from 'vitest'
import { JobSessions } from '../src/session.ts'
import { foremanReportTool } from '../src/report-tool.ts'
import { parseFrame } from '../src/protocol.ts'

/**
 * A host that behaves like DSH for the parts a job touches: `resolveAgent` fails until `create` has run, `create`
 * records the Session, and permissions are recorded rather than applied. A simpler fake cannot tell "creates once"
 * from "creates on every call", which is the property the first test exists to pin.
 */
const ctx = () => {
  const created: string[] = []
  const presets: { session: unknown; preset: string }[] = []
  const existing = new Set<string>()
  const fake = {
    workspaceRegistry: { create: async (cwd: string) => ({ id: cwd, attachSession: async () => {} }) },
    sessionController: {
      resolveAgent: async (sessionId: string) => existing.has(sessionId)
        ? { agent: { id: sessionId, session: { id: sessionId }, inbox: { nextTurn: [], nextStep: [] }, ctx: fakeCtx() } }
        : { error: { code: 'session/not-found' } },
      create: async ({ sessionId }: { sessionId: string }) => { created.push(sessionId); existing.add(sessionId) },
      rename: async () => {},
    },
    permissionPresets: { set: (session: unknown, preset: string) => { presets.push({ session, preset }) } },
    logger: { warn: vi.fn() },
    sessionPersistence: { flush: async () => {}, open: async () => ({ read: async () => ({ events: [] }), [Symbol.asyncDispose]: async () => {} }) },
  }
  return { created, presets, fake: fake as never }
}

const fakeCtx = () => ({ tools: { register: () => ({ dispose: () => {} }) } })

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
