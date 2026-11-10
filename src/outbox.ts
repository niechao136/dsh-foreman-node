/**
 * Reports that could not be sent yet, kept on disk until the hub has them.
 *
 * A device is the only one that ever knows what a job did, so a report that is dropped is a fact the ledger can never
 * recover. `send` returns false when the socket is closed, and a job often finishes exactly then — mid-reconnect, when
 * the laptop lid opened, when the network changed. Without a queue the hub waits at `running` until `hubIdleMs` turns
 * the ticket `blocked` with "device offline", while the device has already finished the work.
 *
 * The queue is a JSONL file, one frame per line: appended before the send is attempted, removed once it went out.
 * Replaying is safe because the hub dedupes by `frameId` per connection, and a frame already applied by an earlier
 * connection is dropped by the same check.
 *
 * Append-only with a compaction on load is enough at this size: a device holds one frame per unfinished report, and
 * reports are small. Nothing here parses a frame or knows what one means.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { encodeFrame, parseFrame, type Frame } from './protocol.ts'

/** The most frames kept: a device with more than this waiting is broken, and the oldest facts are the least useful. */
const LIMIT = 500

/**
 * The reports waiting to reach the hub, in the order they were produced.
 *
 * Only frames that carry a fact about work are queued — a `report` and the `ack` of an input frame. A heartbeat or a
 * `hello` describes the connection, not the work, and is rebuilt on the next connection anyway.
 */
export class FrameOutbox {
  private readonly frames: Frame[] = []

  /**
   * @param file where the queue lives; an empty path keeps it in memory only, which tests and a read-only device use.
   * @param log notes what was dropped, so a queue problem is visible rather than silent.
   */
  constructor(private readonly file: string | undefined, private readonly log: (text: string) => void = () => {}) {
    this.load()
  }

  /** How many frames wait; the plugin reports this so an operator can see a device that cannot reach its hub. */
  get size(): number { return this.frames.length }

  /** Whether a frame carries a fact about work, which is what must survive a disconnect. */
  static durable(frame: Frame): boolean {
    return frame.type === 'report' || frame.type === 'ack'
  }

  /**
   * Keep a frame until it is delivered.
   *
   * The same `frameId` replaces its earlier entry rather than adding a second one: a caller that re-reports the same
   * fact (a retry, or a turn ending after a report) must not grow the queue, and the hub would drop the duplicate.
   */
  add(frame: Frame): void {
    if (!FrameOutbox.durable(frame)) return
    const at = this.frames.findIndex(item => item.frameId === frame.frameId)
    if (at >= 0) this.frames[at] = frame
    else {
      this.frames.push(frame)
      if (this.frames.length > LIMIT) {
        const dropped = this.frames.splice(0, this.frames.length - LIMIT)
        this.log(`dsh-foreman-node dropped ${dropped.length} queued frame(s) over the limit of ${LIMIT}`)
      }
    }
    this.save()
  }

  /** Forget a frame the hub has acknowledged by id, or that went out in this connection. */
  settle(frameId: string): void {
    const at = this.frames.findIndex(item => item.frameId === frameId)
    if (at < 0) return
    this.frames.splice(at, 1)
    this.save()
  }

  /**
   * Send everything waiting, oldest first, and keep what the socket refuses.
   *
   * `deliver` returns whether the frame went out. A refused frame ends the replay: the socket closed mid-way, and
   * trying the rest against a closed socket only produces more log lines. The remaining frames stay for the next one.
   */
  flush(deliver: (frame: Frame) => boolean): number {
    let sent = 0
    for (const frame of [...this.frames]) {
      if (!deliver(frame)) break
      this.settle(frame.frameId)
      sent++
    }
    return sent
  }

  private load(): void {
    if (this.file === undefined || this.file === '') return
    let text: string
    try { text = readFileSync(this.file, 'utf8') }
    catch { return /* No queue yet is the normal first start. */ }
    let skipped = 0
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try { this.frames.push(parseFrame(line)) }
      catch { skipped++ /* A truncated last line from a crash; the fact is lost but the queue is not. */ }
    }
    if (skipped > 0) this.log(`dsh-foreman-node skipped ${skipped} unreadable queued frame(s)`)
    // Replay the file as a clean queue, so a crash mid-append cannot leave a corrupt line in the middle.
    this.save()
  }

  private save(): void {
    if (this.file === undefined || this.file === '') return
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      // Write beside the target and rename, so a crash leaves either the old queue or the new one, never half of one.
      const temporary = `${this.file}.tmp`
      writeFileSync(temporary, this.frames.map(frame => encodeFrame(frame)).join('\n') + (this.frames.length ? '\n' : ''))
      renameSync(temporary, this.file)
    } catch (error) { this.log(`dsh-foreman-node could not save its frame queue: ${String(error)}`) }
  }
}
