/**
 * Job sessions on a device: one Session per assignment, in the directory the hub named.
 *
 * This is the device-side counterpart of `Sessions.ensure` on the hub, and it deliberately sets a different
 * permission preset. A hub session runs with `danger-full-access` because a person is sitting in front of it and
 * approves; a job session runs `workspace-write` inside a directory the device declared, because nobody is there to
 * answer a prompt. Work that needs more is reported `blocked`, not silently elevated.
 *
 * Nothing here touches the hub's domain, its database, or its policy: a device has no ledger.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-tools'
import { MessageId, freezeMessage } from '@deepseek-ai/dsh-llm'
import { foremanReportTool, type DeviceReport } from './report-tool.ts'
import { FOREMAN_PROTOCOL_VERSION, MAX_DETAIL_ERROR, MAX_DETAIL_FILES, MAX_READ_CHARS, type PartFrame, type ReportDetail } from './protocol.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-foreman-node': { kind: 'dsh-foreman-node'; form: 'relay' }
  }
}

/**
 * The permission preset a job runs under when the device's configuration names none.
 *
 * Bounded to the directory the device declared. A job on a machine with nobody in front of it cannot answer an
 * approval prompt, so the useful alternative is not a wider sandbox but a quiet one: a preset that keeps this
 * boundary and never asks. That is the device operator's decision, taken in their own configuration, because it is
 * their machine and their risk.
 */
export const JOB_PRESET = 'workspace-write'

/** The Session a job runs in, named the way a hub names its own worker: `job-<assignmentId>`. */
export const jobSessionId = (assignmentId: string): string => `job-${assignmentId}`

/** The message id of one delivery, derived from the hub's request id so a redelivery adds nothing. */
const requestMessage = (requestId: string): MessageId => MessageId(`dsh-foreman-node:${requestId}`)

export interface EnsureInput {
  assignmentId: string
  /** The absolute directory on this device; the hub mapped it through the device's declared roots. */
  directory: string
  title: string
}

/** What the tool registrar looks like, narrowed to what this file uses. */
export interface ToolRegistrar {
  register(definition: { name: string; description: string; parameters: Record<string, unknown>
    output: { schema: Record<string, unknown>; render: (args: unknown, value: unknown) => unknown }
    execute: (args: unknown, execution: { signal: AbortSignal }) => Promise<unknown> }): unknown
}

/**
 * Keeps the device's job Sessions and delivers work into them.
 *
 * A Session is created only when it does not exist yet, so a redelivered `assign` reuses the Session and the work
 * already in it instead of starting a second one. Delivery is idempotent by request id: the hub retrying a frame
 * that it never saw acknowledged cannot append the task twice.
 */
export class JobSessions {
  /** Jobs by assignment id, so `running()` reports what this device actually holds rather than what it was told. */
  private readonly jobs = new Map<string, string>()
  /** Assignments whose Session already carries the report tool, so a redelivered assign registers it only once. */
  private readonly reported = new Set<string>()
  /** Assignments that have actually reported; a turn ending without one is closed out by `watchTurnEnd`. */
  private readonly reports = new Set<string>()

  /**
   * @param preset the permission preset a job runs under. The device operator chooses it in their own configuration:
   *   a machine with nobody in front of it cannot answer an approval prompt, so the useful choice is usually a preset
   *   that keeps the workspace boundary and never asks.
   */
  constructor(private readonly ctx: Context, private readonly preset: string = JOB_PRESET) {}

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
  async ensure(input: EnsureInput, onReport?: (assignmentId: string, report: DeviceReport) => void): Promise<string> {
    const id = jobSessionId(input.assignmentId)
    const workspace = await this.ctx.workspaceRegistry.create(input.directory)
    let result = await this.ctx.sessionController.resolveAgent(id as SessionId)
    if ('error' in result && result.error.code === 'session/not-found') {
      await this.ctx.sessionController.create({ sessionId: id as SessionId, workspaceId: workspace.id })
      result = await this.ctx.sessionController.resolveAgent(id as SessionId)
    }
    if ('error' in result) throw result.error
    await workspace.attachSession(id as SessionId)
    // The one place the device's policy differs from the hub's. A preset name that the host does not have must not
    // kill the job: a person configured it, the host's table moved, and the work is still worth doing under the
    // default. Failing here surfaced as 'the query could not start' with the real reason three layers away.
    try { this.ctx.permissionPresets.set(result.agent.session, this.preset) }
    catch (error) {
      this.ctx.logger.warn('dsh-foreman-node: this host has no permission preset %s, so the job runs under %s (%s)',
        this.preset, JOB_PRESET, String(error))
      try { this.ctx.permissionPresets.set(result.agent.session, JOB_PRESET) }
      catch (fallback) { this.ctx.logger.warn('dsh-foreman-node: could not set any preset: %s', String(fallback)) }
    }
    await this.ctx.sessionController.rename({ sessionId: id as SessionId, title: input.title })
    if (onReport !== undefined && !this.reported.has(input.assignmentId)) {
      this.reported.add(input.assignmentId)
      try { this.reportTools(result.agent as Agent, input.assignmentId, onReport) }
      catch (error) {
        // A Session that refuses the tool would never report: forget the guard so a later assign retries it.
        this.reported.delete(input.assignmentId)
        throw new Error(`could not attach foreman_report to ${id}: ${String(error)}`)
      }
    }
    this.jobs.set(input.assignmentId, id)
    return id
  }

  /**
   * Deliver a task into its job Session, once per request id.
   *
   * `queue` rather than `steer` on the first delivery: the job's task should start a turn, not interrupt one that is
   * already running. A redelivery finds the message already recorded and adds nothing.
   */
  async deliver(sessionId: string, text: string, requestId: string): Promise<void> {
    const result = await this.ctx.sessionController.resolveAgent(sessionId as SessionId)
    if ('error' in result) throw result.error
    const agent = result.agent as Agent
    if (await this.holds(agent, requestId)) return
    const source = { kind: 'dsh-foreman-node' as const, form: 'relay' as const }
    agent.followup(freezeMessage({ id: requestMessage(requestId), role: 'user' as const, content: [{ type: 'text' as const, text }], source }))
    await this.ctx.sessionPersistence.flush()
  }

  /** Whether the Session already holds the delivery for `requestId`, in its live inbox or its stored history. */
  async holds(agent: Agent, requestId: string): Promise<boolean> {
    const id = requestMessage(requestId)
    if ([...agent.inbox.nextTurn, ...agent.inbox.nextStep].some(message => message.id === id)) return true
    try {
      await this.ctx.sessionPersistence.flush()
      await using handle = await this.ctx.sessionPersistence.open(agent.id, 'read')
      for (let offset = 0; ;) {
        const { events } = await handle.read(offset, 512)
        if (events.length === 0) return false
        for (const event of events) {
          if (event.type === 'user/message' && (event.data as { id?: string }).id === id) return true
        }
        offset += events.length
      }
    } catch (error) {
      // A Session whose history cannot be read is not proof of a delivery: deliver again rather than lose the task.
      this.ctx.logger.warn('dsh-foreman-node could not read %s history: %s', agent.id, String(error))
      return false
    }
  }

  /** The assignment ids this device currently holds a job for: what a heartbeat and a reconnected hello report. */
  running(): string[] { return [...this.jobs.keys()] }

  /** Forget a job whose assignment the hub stopped, so this device stops reporting it as running. */
  forget(assignmentId: string): void { this.jobs.delete(assignmentId) }

  /** Attach the `foreman_report` tool to a job Session, disposed with it. */
  reportTools(agent: Agent, assignmentId: string, onReport: (assignmentId: string, report: DeviceReport) => void): void {
    const registrar = agent.ctx.tools
    // Wrap the reporter so this Session's own turn ending can tell whether a report ever went out.
    const reported = this.reports
    // A report leaving this Session is the only moment the hub hears about the job, so the structured summary is
    // attached here: every report, wherever it came from, carries what the job actually did.
    const report = (id: string, deviceReport: DeviceReport): void => {
      reported.add(id)
      void this.detail(agent).then(detail => {
        onReport(id, detail === undefined ? deviceReport : { ...deviceReport, detail })
      }, () => { onReport(id, deviceReport) })
    }
    const tool = foremanReportTool({ report }, assignmentId)
    registrar.register({ name: tool.name, description: tool.description, parameters: tool.parameters,
      output: { schema: { type: 'object', additionalProperties: true },
        render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }] },
      execute: (args: unknown, execution: { signal: AbortSignal }) => tool.execute(args as Record<string, unknown>, execution) })
    this.watchTurnEnd(agent, assignmentId, report)
  }

  /**
   * Report for a job that ended without calling the tool.
   *
   * Telling the model to report is not a guarantee: on a real deployment a device did the work, wrote a complete
   * answer, and never called `foreman_report`, so the hub waited at `running` forever. The tool alone leaves that
   * failure open, so a turn that ends with no report is closed out here — `ready`, with the last thing the model said
   * as the summary. A person still gets the result; the ledger still learns the job ended.
   */
  private watchTurnEnd(agent: Agent, assignmentId: string, report: (id: string, r: DeviceReport) => void): void {
    // The watcher is a safety net, not part of the tool: a host that cannot register it must still get the tool,
    // because a job with no reporting channel at all is worse than one whose turn end is not observed.
    if (typeof agent.ctx.effect !== 'function') return
    agent.ctx.effect(() => {
      const dispose = agent.ctx.on('session/event', (session, event) => {
        if (session.id !== agent.session.id || event.type !== 'turn/end') return
        if (this.reports.has(assignmentId)) return
        // Reading the history is best effort: an unreadable history still closes the job out, because leaving the
        // hub at `running` forever is the worse failure.
        void this.lastText(agent).then(text => {
          if (this.reports.has(assignmentId)) return
          report(assignmentId, { state: 'ready', summary: text === '' ? 'the job finished without a report' : text.slice(0, 600) })
        }, () => {
          if (this.reports.has(assignmentId)) return
          report(assignmentId, { state: 'ready', summary: 'the job finished without a report' })
        })
      })
      return () => { void dispose }
    })
  }

  /** The last text the assistant said in a Session, read from its stored history. */
  private async lastText(agent: Agent): Promise<string> {
    await this.ctx.sessionPersistence.flush()
    await using handle = await this.ctx.sessionPersistence.open(agent.id, 'read')
    let found = ''
    for (let offset = 0; ;) {
      const { events } = await handle.read(offset, 512)
      if (events.length === 0) break
      for (const event of events) {
        if (event.type !== 'assistant/message') continue
        const parts = (event.data as unknown as { message?: { content?: readonly { type?: string; text?: string }[] } })
          ?.message?.content ?? []
        const text = parts.filter(part => part?.type === 'text').map(part => part.text ?? '').join(' ').trim()
        if (text !== '') found = text
      }
      offset += events.length
    }
    return found
  }

  /**
   * Summarise what a job did, from its own stored history.
   *
   * The hub never sees this Session, so without this it judges a remote ticket from one paragraph. Counting tool
   * calls, collecting changed paths and the last error is enough for a person to tell "the tests failed" from "the
   * deployment was not running", which is the question they actually ask a blocked ticket.
   *
   * Best effort by design: an unreadable or unusual history yields `undefined`, and the report still goes out.
   */
  async detail(agent: Agent): Promise<ReportDetail | undefined> {
    try {
      await this.ctx.sessionPersistence.flush()
      await using handle = await this.ctx.sessionPersistence.open(agent.id, 'read')
      const tools = new Map<string, { calls: number; failures: number }>()
      const changed = new Set<string>()
      let steps = 0, lastError = '', sawError = false
      for (let offset = 0; ;) {
        const { events } = await handle.read(offset, 512)
        if (events.length === 0) break
        for (const event of events) {
          if (event.type === 'assistant/message') steps += 1
          const name = event.type === 'tool/call' ? toolNameOf(event.data) : undefined
          if (name) {
            const entry = tools.get(name) ?? { calls: 0, failures: 0 }
            entry.calls += 1
            tools.set(name, entry)
          }
          if (event.type === 'tool/result') {
            const failed = toolResultFailed(event.data)
            const failedName = failed?.name
            if (failedName) { const entry = tools.get(failedName); if (entry) entry.failures += 1 }
            sawError = failed !== undefined
            const text = failed?.text
            if (text) lastError = text
          }
          for (const path of changedPathsOf(event)) changed.add(path)
        }
        offset += events.length
      }
      if (tools.size === 0 && changed.size === 0 && steps === 0 && !sawError) return undefined
      const listed = [...changed]
      return {
        steps,
        ...tools.size ? { tools: [...tools].map(([name, counts]) => ({ name, ...counts })).sort((left, right) => right.calls - left.calls) } : {},
        ...changed.size ? { changedFiles: listed.slice(0, MAX_DETAIL_FILES).map(path => path.slice(0, 200)),
          ...listed.length > MAX_DETAIL_FILES ? { changedOverflow: listed.length - MAX_DETAIL_FILES } : {} } : {},
        ...lastError ? { lastError: lastError.slice(0, MAX_DETAIL_ERROR) } : {},
      }
    } catch (error) {
      // A summary is an aid; failing to build one must never stop the report that carries the actual result.
      this.ctx.logger.warn('dsh-foreman-node could not summarise %s: %s', agent.id, String(error))
      return undefined
    }
  }
  /**
   * Render one page of a job's transcript for a person reading it through the hub.
   *
   * Only text is rendered: tool arguments and raw events are not what someone asks to see, and a page of JSON would
   * cost far more of the hub's context than it is worth. The offsets index the rendered text, so paging is stable
   * even though the underlying history is event-shaped.
   */
  async readTranscript(assignmentId: string, offset: number, limit: number, requestId: string): Promise<PartFrame> {
    const sessionId = `job-${assignmentId}`
    try {
      const result = await this.ctx.sessionController.resolveAgent(sessionId as SessionId)
      if ('error' in result) return { v: FOREMAN_PROTOCOL_VERSION, type: 'part', frameId: `part-${requestId}`, requestId,
        total: 0, offset: 0, text: '', error: 'this device no longer holds that job' }
      const text = await this.renderedHistory(result.agent as Agent)
      const from = Math.max(0, Math.min(Math.trunc(offset), text.length))
      const size = Math.max(1, Math.min(Math.trunc(limit) || MAX_READ_CHARS, MAX_READ_CHARS))
      return { v: FOREMAN_PROTOCOL_VERSION, type: 'part', frameId: `part-${requestId}`, requestId,
        total: text.length, offset: from, text: text.slice(from, from + size) }
    } catch (error) {
      return { v: FOREMAN_PROTOCOL_VERSION, type: 'part', frameId: `part-${requestId}`, requestId,
        total: 0, offset: 0, text: '', error: String(error) }
    }
  }

  /** The readable history of a Session: what was said, and which tools ran, in order. */
  private async renderedHistory(agent: Agent): Promise<string> {
    await this.ctx.sessionPersistence.flush()
    await using handle = await this.ctx.sessionPersistence.open(agent.id, 'read')
    const lines: string[] = []
    for (let offset = 0; ;) {
      const { events } = await handle.read(offset, 512)
      if (events.length === 0) break
      for (const event of events) {
        if (event.type === 'assistant/message') {
          const parts = (event.data as unknown as { message?: { content?: readonly { type?: string; text?: string }[] } })
            ?.message?.content ?? []
          const text = parts.filter(part => part?.type === 'text').map(part => part.text ?? '').join('\n').trim()
          if (text !== '') lines.push(`assistant: ${text}`)
        }
        const name = event.type === 'tool/call' ? toolNameOf(event.data) : undefined
        if (name) lines.push(`tool: ${name}`)
        const failed = event.type === 'tool/result' ? toolResultFailed(event.data) : undefined
        if (failed?.text) lines.push(`error: ${failed.text.slice(0, 500)}`)
      }
      offset += events.length
    }
    return lines.join('\n\n')
  }
}
function toolNameOf(data: unknown): string | undefined {
  const value = data as { name?: unknown; toolName?: unknown } | undefined
  const name = typeof value?.name === 'string' ? value.name : typeof value?.toolName === 'string' ? value.toolName : undefined
  return name && name !== '' ? name : undefined
}
/** A failed tool result: which tool, and the message that explains the failure. */
function toolResultFailed(data: unknown): { name?: string; text?: string } | undefined {
  const value = data as { isError?: unknown; error?: unknown; result?: unknown; name?: unknown } | undefined
  if (!value) return undefined
  const failed = value.isError === true || (value.error !== undefined && value.error !== null)
  if (!failed) return undefined
  const raw = value.error ?? value.result
  const text = typeof raw === 'string' ? raw : raw === undefined ? '' : JSON.stringify(raw)
  const name = typeof value.name === 'string' ? value.name : undefined
  return { ...name ? { name } : {}, ...text ? { text } : {} }
}
/**
 * Paths an event reports as written.
 *
 * Tool arguments differ per tool, so this reads the conventional keys rather than matching a tool name: a host that
 * renames its write tool still yields paths, and an unknown tool simply contributes none.
 */
function changedPathsOf(event: { type: string; data?: unknown }): string[] {
  if (event.type !== 'tool/call' && event.type !== 'tool/result') return []
  const data = event.data as { arguments?: unknown; args?: unknown; input?: unknown; path?: unknown; file_path?: unknown } | undefined
  if (!data) return []
  const args = (data.arguments ?? data.args ?? data.input ?? data) as Record<string, unknown>
  const found: string[] = []
  for (const key of ['path', 'file_path', 'filePath', 'file']) {
    const value = args[key]
    if (typeof value === 'string' && value !== '') found.push(value)
  }
  return found
}
