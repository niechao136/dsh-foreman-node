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

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-foreman-node': { kind: 'dsh-foreman-node'; form: 'relay' }
  }
}

/** The permission preset a job runs under: bounded to the directory the device declared. */
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

  constructor(private readonly ctx: Context) {}

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
    // The one place the device's policy differs from the hub's: bounded, because no person is here to approve more.
    this.ctx.permissionPresets.set(result.agent.session, JOB_PRESET)
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
    const tool = foremanReportTool({ report: onReport }, assignmentId)
    registrar.register({ name: tool.name, description: tool.description, parameters: tool.parameters,
      output: { schema: { type: 'object', additionalProperties: true },
        render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }] },
      execute: (args: unknown, execution: { signal: AbortSignal }) => tool.execute(args as Record<string, unknown>, execution) })
  }
}
