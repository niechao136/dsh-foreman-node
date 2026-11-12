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

import type { ReportDetail } from './protocol.ts'

/** What a device may report; the same set the protocol's `NodeReportState` names. */
export const REPORT_STATES = ['progress', 'ready', 'blocked', 'failed'] as const
export type ReportState = typeof REPORT_STATES[number]

/** A report as the tool's caller gives it. */
export interface DeviceReport {
  state: ReportState
  summary: string
  /** One question a person must answer; paired with `state: 'blocked'` in practice. */
  question?: string
  /**
   * What the job did, summarised. The caller attaches it rather than the model: the model writes the summary, but the
   * counts and paths come from the Session's own history, so they cannot be embellished in the report text.
   */
  detail?: ReportDetail
}

/** The host a tool reports through: the client that owns the connection, or a test. */
export interface ReportHost {
  report(assignmentId: string, report: DeviceReport): void
}

/** The parts of a tool definition DSH registers: name, description, JSON Schema, and the executor. */
export interface DeviceTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute(args: Record<string, unknown>, execution: { signal: AbortSignal }): Promise<unknown>
}

/** The JSON Schema a model sees, which is also what `execute` validates against. */
const PARAMETERS: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['state', 'summary'],
  properties: {
    state: { type: 'string', enum: [...REPORT_STATES], description: 'progress while working, ready when the result is in, blocked when a person must act, failed when the work cannot be done.' },
    summary: { type: 'string', minLength: 1, description: 'What was done, or what is needed, in one or two sentences.' },
    question: { type: 'string', minLength: 1, description: 'One concrete question for a person, with state=blocked.' },
  },
}

/** Thrown for arguments this tool refuses; the model sees the message and can correct itself. */
class ReportRefusal extends Error {
  constructor(message: string) { super(message); this.name = 'ReportRefusal' }
}

/** Validate the arguments to a report, refusing `dropped`, an unknown state, or an empty summary. */
export function readReport(args: Record<string, unknown>): DeviceReport {
  const state = args['state']
  if (typeof state !== 'string') throw new ReportRefusal('state must be a string')
  if (state === 'dropped') {
    throw new ReportRefusal('a device may not report dropped: deciding that work should not be done is the hub\'s judgement, so report blocked instead')
  }
  if (!(REPORT_STATES as readonly string[]).includes(state)) {
    throw new ReportRefusal(`state must be one of ${REPORT_STATES.join(', ')}, not ${state}`)
  }
  const summary = typeof args['summary'] === 'string' ? args['summary'].trim() : ''
  if (summary === '') throw new ReportRefusal('summary must say what was done or what is needed')
  const question = typeof args['question'] === 'string' ? args['question'].trim() : undefined
  if (args['question'] !== undefined && (question === undefined || question === '')) {
    throw new ReportRefusal('question must be a question when given')
  }
  return { state: state as ReportState, summary, ...(question === undefined ? {} : { question }) }
}

/**
 * Build the `foreman_report` tool for one assignment.
 *
 * The assignment id is bound here rather than passed by the model: a job Session reports on the assignment it was
 * started for, and a model should not be able to name a different one.
 */
export function foremanReportTool(host: ReportHost, assignmentId: string): DeviceTool {
  return {
    name: 'foreman_report',
    description: 'Report this job to the foreman: progress, ready, blocked or failed, with a one-sentence summary and, when a person must answer, one question.',
    parameters: PARAMETERS,
    async execute(args) {
      host.report(assignmentId, readReport(args))
      return { reported: true }
    },
  }
}
