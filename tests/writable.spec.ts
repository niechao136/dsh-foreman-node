/**
 * Whether DSH will accept a write to this plugin's configuration.
 *
 * The page reported "could not save" on a real machine because one nested field was not volatile: `isVolatilePath`
 * walks the path, so `ssh.host` resolved to a child schema that had no volatile marker and the write was refused.
 * Every unit test passed at the time — none of them asked the question this file asks.
 */
import { expect, it } from 'vitest'
import { Config } from '../src/index.ts'

/** DSH's own rule, copied from `dsh-settings`: a path is writable only if an ancestor is volatile. */
function isVolatilePath(node: any, path: string[]): boolean {
  if (node.meta?.volatile) return true
  const [key, ...rest] = path
  const child = key === undefined ? undefined : node.dict?.[key]
  return child !== undefined && isVolatilePath(child, rest)
}

/** The paths the page writes, one per field it shows. */
const WRITTEN = [
  ['url'], ['deviceId'], ['token'], ['roots'], ['heartbeatMs'], ['reconnectMs'], ['jobPreset'],
  // `['ssh']` itself is not writable, and does not need to be: the page sends one `set` per field, and every leaf
  // below carries its own marker. Only a whole-block write would need the object marked, and that would replace the
  // block's default with `{}`.
  ['ssh', 'enabled'], ['ssh', 'host'], ['ssh', 'port'], ['ssh', 'user'], ['ssh', 'keyPath'],
  ['ssh', 'remotePort'], ['ssh', 'localPort'],
  // Same rule for the publishing block: one `set` per leaf, so each leaf needs the marker.
  ['expose', 'enabled'], ['expose', 'remotePort'],
]

it('accepts a write to every field the configuration page writes', () => {
  // A false here is the exact failure a person saw: the form fills in, the button is pressed, and nothing is saved.
  const refused = WRITTEN.filter(path => !isVolatilePath(Config, path)).map(path => path.join('.'))
  expect(refused).toEqual([])
})

it('accepts a whole-section write, which is exempt from the per-field check', () => {
  // `write()` guards with `if (path.length && !isVolatilePath(...))`, so an empty path is never refused here. The
  // page sends `{ op: 'set', path: [], value }`, and the volumes it puts in that value are checked by `validatePaths`
  // instead — which is why every leaf above has to carry its own marker.
  expect(isVolatilePath(Config, [])).toBe(false)
  expect([].length).toBe(0)
})

/** DSH's `validatePaths`: a whole-section write is checked key by key, recursing into plain objects. */
function validatePaths(value: Record<string, unknown>, node: any, path: string[] = []): string[] {
  const refused: string[] = []
  for (const [key, child] of Object.entries(value)) {
    const target = [...path, key]
    if (isVolatilePath(Config, target)) continue
    const field = node.dict?.[key]
    if (child !== null && typeof child === 'object' && !Array.isArray(child) && field !== undefined) {
      refused.push(...validatePaths(child as Record<string, unknown>, field, target))
    } else refused.push(target.join('.'))
  }
  return refused
}

it('accepts the whole value the page actually saves, section write included', () => {
  // This is the shape `configOf` produces and the page sends as one `set` at path [].
  const value = {
    url: 'ws://127.0.0.1:8790', deviceId: 'laptop',
    roots: [{ project: 'dsh-foreman', path: 'F:\\dsh\\dsh-foreman' }],
    ssh: { enabled: true, host: '139.224.13.57', port: 22, user: 'root',
      keyPath: 'C:/Users/niech/.ssh/id_ed25519', remotePort: 8790, localPort: 8790 },
    expose: { enabled: true, remotePort: 13100 },
    jobPreset: 'workspace-write',
  }
  // A refusal here is exactly the "保存失败" a person saw on the real machine.
  expect(validatePaths(value, Config)).toEqual([])
})
