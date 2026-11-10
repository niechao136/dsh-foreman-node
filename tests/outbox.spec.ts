import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { FrameOutbox } from '../src/outbox.ts'
import { FOREMAN_PROTOCOL_VERSION, encodeFrame, type AckFrame, type ReportFrame } from '../src/protocol.ts'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'outbox-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const report = (id: string, summary = 'done'): ReportFrame => ({ v: FOREMAN_PROTOCOL_VERSION, type: 'report', frameId: id,
  assignmentId: 'a1', state: 'ready', summary })
const ack = (id: string): AckFrame => ({ v: FOREMAN_PROTOCOL_VERSION, type: 'ack', frameId: id, of: 'input:1' })

it('keeps a report the socket refused, and replays it on the next connection', () => {
  const file = join(dir, 'outbox.jsonl')
  const outbox = new FrameOutbox(file)
  outbox.add(report('report:1'))
  expect(outbox.size).toBe(1)
  // Nothing goes out: the replay keeps what the socket refuses and stops there.
  expect(outbox.flush(() => false)).toBe(0)
  expect(outbox.size).toBe(1)
  // The next connection delivers it, in order.
  const sent: string[] = []
  expect(outbox.flush(frame => { sent.push(frame.frameId); return true })).toBe(1)
  expect([sent, outbox.size]).toEqual([['report:1'], 0])
})

it('repays a queued report across a restart, which is the point of keeping it on disk', () => {
  const file = join(dir, 'outbox.jsonl')
  new FrameOutbox(file).add(report('report:1', 'the job finished while the network was down'))
  // A new process reads the same file, as a restarted plugin does.
  const reopened = new FrameOutbox(file)
  expect(reopened.size).toBe(1)
  const played: string[] = []
  reopened.flush(frame => { played.push((frame as ReportFrame).summary); return true })
  expect(played).toEqual(['the job finished while the network was down'])
})

it('queues an ack as well, because the hub clears the ticket\'s undelivered inputs from it', () => {
  const outbox = new FrameOutbox(join(dir, 'outbox.jsonl'))
  outbox.add(ack('ack:1'))
  expect(outbox.size).toBe(1)
})

it('does not queue a frame that describes the connection rather than the work', () => {
  const outbox = new FrameOutbox(join(dir, 'outbox.jsonl'))
  outbox.add({ v: FOREMAN_PROTOCOL_VERSION, type: 'heartbeat', frameId: 'heartbeat:1', deviceId: 'd', running: 0 })
  outbox.add({ v: FOREMAN_PROTOCOL_VERSION, type: 'hello', frameId: 'hello:1', deviceId: 'd', token: 't', version: '1',
    roots: [], running: [] })
  expect(outbox.size).toBe(0)
})

it('replaces a repeat of the same frame id instead of queueing it twice', () => {
  const outbox = new FrameOutbox(join(dir, 'outbox.jsonl'))
  outbox.add(report('report:1', 'first'))
  outbox.add(report('report:1', 'corrected'))
  expect(outbox.size).toBe(1)
  const played: string[] = []
  outbox.flush(frame => { played.push((frame as ReportFrame).summary); return true })
  expect(played).toEqual(['corrected'])
})

it('keeps the queue in memory when no file is configured, which is what a read-only device uses', () => {
  const outbox = new FrameOutbox(undefined)
  outbox.add(report('report:1'))
  expect(outbox.flush(() => false)).toBe(0)
  expect(outbox.size).toBe(1)
})

it('survives a truncated last line from a crash, keeping the frames before it', () => {
  const file = join(dir, 'outbox.jsonl')
  writeFileSync(file, `${encodeFrame(report('report:1'))}\n${encodeFrame(report('report:2')).slice(0, 40)}`)
  const outbox = new FrameOutbox(file)
  expect(outbox.size).toBe(1)
  // The rewrite drops the unreadable tail, so the next load is clean.
  expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(1)
})
