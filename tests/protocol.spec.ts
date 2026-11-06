import { expect, it } from 'vitest'
import { FOREMAN_PROTOCOL_VERSION, FrameDedupe, FrameError, MAX_FRAME_BYTES, encodeFrame, parseFrame } from '../src/protocol.ts'

const assign = { v: FOREMAN_PROTOCOL_VERSION, type: 'assign' as const, frameId: 'f1', assignmentId: 'a1', ticketId: 't1',
  directory: 'D:\\工作\\我的 项目', text: 'do it', attachments: [], permissionPreset: 'workspace-write' }

it('round-trips a frame through JSON and keeps a non-ASCII path byte-for-byte', () => {
  expect(parseFrame(encodeFrame(assign))).toEqual(assign)
})

it('refuses a frame from a different protocol version with a readable reason', () => {
  const bad = JSON.stringify({ ...assign, v: 2 })
  expect(() => parseFrame(bad)).toThrow(FrameError)
  expect(() => parseFrame(bad)).toThrow(/protocol version 2/)
})

it('refuses a frame over the size cap instead of truncating it', () => {
  const huge = { ...assign, attachments: [{ id: 'x', bytes: 'a'.repeat(MAX_FRAME_BYTES) }] }
  expect(() => parseFrame(encodeFrame(huge))).toThrow(/too large/)
})

it('refuses malformed JSON and an unknown frame type', () => {
  expect(() => parseFrame('{nope')).toThrow(/malformed/)
  expect(() => parseFrame(JSON.stringify({ ...assign, type: 'nonsense' }))).toThrow(/unknown frame type/)
})

it('refuses a frame with no frameId', () => {
  const { frameId: _drop, ...rest } = assign
  expect(() => parseFrame(JSON.stringify(rest))).toThrow(/frameId/)
})

it('takes each frameId once', () => {
  const dedupe = new FrameDedupe(new Set())
  expect([dedupe.take('f1'), dedupe.take('f1'), dedupe.take('f2')]).toEqual([true, false, true])
})
