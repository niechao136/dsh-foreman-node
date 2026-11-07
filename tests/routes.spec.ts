/**
 * The device's two loopback routes, exercised against a fake web server.
 *
 * Every test injects the runner, so none starts ssh — and the same-origin guard is pinned here rather than left to
 * the integration, because a route that answers anyone on the machine is the one thing these must not do.
 */
import { expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerNodeRoutes, testArgs } from '../src/routes.ts'

type Handler = (req: never, res: never) => Promise<void>
/** Mount the routes on a fake web server and return a request helper. */
function serve(directory: string, run?: (argv: readonly string[]) => Promise<{ code: number | null; output: string }>) {
  let handler = async (_req: unknown, _res: unknown): Promise<void> => {}
  const host = { port: 3088, register: (route: { handler: (req: never, res: never) => Promise<void> }) => {
    handler = route.handler as unknown as (req: unknown, res: unknown) => Promise<void>
    return () => {}
  } }
  registerNodeRoutes(host as never, directory, run)
  const request = async (method: string, path: string, payload?: unknown,
    headers: Record<string, string | undefined> = {}) => {
    let status = 0, text = ''
    const chunks = payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))]
    const sent = Object.fromEntries(Object.entries({ host: '127.0.0.1:3088', 'x-orchestrator-request': '1', ...headers })
      .filter(([, value]) => value !== undefined))
    const req = { method, url: `/foreman-node/api/${path}`, headers: sent, async *[Symbol.asyncIterator]() { yield* chunks } }
    await handler(req, { writeHead: (code: number) => { status = code }, end: (data: string) => { text = data } })
    return { status, body: JSON.parse(text) as Record<string, unknown> }
  }
  return request
}

const keysDir = (files: Record<string, string>): string => {
  const directory = mkdtempSync(join(tmpdir(), 'foreman-routes-'))
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(directory, name), contents)
  return directory
}

it('answers which keys exist, and never their contents', async () => {
  const directory = keysDir({ id_ed25519: 'SECRET', 'id_ed25519.pub': 'ssh-ed25519 AAAAC3Nza me@laptop' })
  const response = await serve(directory)('GET', 'keys')
  expect(response.status).toBe(200)
  expect(response.body).toMatchObject({ directory, keys: [{ name: 'id_ed25519', comment: 'me@laptop' }] })
  expect(JSON.stringify(response.body)).not.toContain('SECRET')
})

it('reports a refused key as an answer, not as a server error', async () => {
  const directory = keysDir({ id_ed25519: 'P', 'id_ed25519.pub': 'ssh-ed25519 AAAA c' })
  const response = await serve(directory, async () => ({ code: 255, output: 'Permission denied (publickey).' }))(
    'POST', 'test', { host: 'h', port: 22, user: 'u', keyPath: join(directory, 'id_ed25519') })
  expect(response.status).toBe(200)
  expect(response.body).toEqual({ ok: false, output: 'Permission denied (publickey).' })
})

it('reports a working key as ok', async () => {
  const directory = keysDir({ id_ed25519: 'P', 'id_ed25519.pub': 'ssh-ed25519 AAAA c' })
  const response = await serve(directory, async () => ({ code: 0, output: '' }))('POST', 'test',
    { host: 'h', port: 22, user: 'u', keyPath: join(directory, 'id_ed25519') })
  expect(response.body).toEqual({ ok: true, output: '' })
})

it('asks for host, user and key before it runs anything', async () => {
  let ran = 0
  const run = async () => { ran++; return { code: 0, output: '' } }
  const request = serve(keysDir({}), run)
  expect((await request('POST', 'test', { host: '', user: 'u', keyPath: '/k' })).status).toBe(400)
  expect((await request('POST', 'test', { host: 'h', user: '', keyPath: '/k' })).status).toBe(400)
  expect((await request('POST', 'test', { host: 'h', user: 'u' })).status).toBe(400)
  expect(ran).toBe(0)
})

it('refuses to run ssh against a key this machine does not offer', async () => {
  let ran = 0
  const run = async () => { ran++; return { code: 0, output: '' } }
  const directory = keysDir({ id_ed25519: 'P', 'id_ed25519.pub': 'ssh-ed25519 AAAA c' })
  const response = await serve(directory, run)('POST', 'test', { host: 'h', user: 'u', keyPath: '/somewhere/else' })
  expect(response.status).toBe(400)
  // The point is that nothing was started: a caller must not talk this process into running ssh on any path.
  expect(ran).toBe(0)
})

it('refuses a request that did not come from the panel', async () => {
  const request = serve(keysDir({}))
  expect((await request('GET', 'keys', undefined, { 'x-orchestrator-request': undefined })).status).toBe(403)
  expect((await request('GET', 'keys', undefined, { origin: 'https://evil.example' })).status).toBe(403)
  // The page's own origin is allowed.
  expect((await request('GET', 'keys', undefined, { origin: 'http://127.0.0.1:3088' })).status).toBe(200)
})

it('refuses a request addressed to another host, which is how a rebinding attack arrives', async () => {
  expect((await serve(keysDir({}))('GET', 'keys', undefined, { host: 'evil.example:3088' })).status).toBe(403)
})

it('accepts the loopback names DSH may normalize to, and a TLS origin', async () => {
  const request = serve(keysDir({}))
  // The desktop build may bind ::1 and normalize the host header to whichever form it chose.
  expect((await request('GET', 'keys', undefined, { host: '[::1]:3088' })).status).toBe(200)
  expect((await request('GET', 'keys', undefined, { host: 'localhost:3088' })).status).toBe(200)
  // A port that is not this service's is still another host.
  expect((await request('GET', 'keys', undefined, { host: '127.0.0.1:9999' })).status).toBe(403)
})

it('answers unknown paths rather than pretending they work', async () => {
  expect((await serve(keysDir({}))('GET', 'nope')).status).toBe(404)
})

it('builds an authentication test that asks for nothing interactive', () => {
  expect(testArgs({ host: 'h', port: 2222, user: 'u', keyPath: '/k' })).toEqual(['ssh', '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=accept-new', '-p', '2222', '-i', '/k', 'u@h', 'true'])
})
