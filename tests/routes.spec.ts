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
import { parsePortCheck, portCheckArgs, portCheckScript, registerNodeRoutes, testArgs } from '../src/routes.ts'
import type { AccessAnswer } from '../src/routes.ts'

type Handler = (req: never, res: never) => Promise<void>
/** Mount the routes on a fake web server and return a request helper. */
function serve(directory: string, run?: (argv: readonly string[], input?: string) => Promise<{ code: number | null; output: string }>,
  access?: () => AccessAnswer) {
  let handler = async (_req: unknown, _res: unknown): Promise<void> => {}
  const host = { port: 3088, register: (route: { handler: (req: never, res: never) => Promise<void> }) => {
    handler = route.handler as unknown as (req: unknown, res: unknown) => Promise<void>
    return () => {}
  } }
  registerNodeRoutes(host as never, directory, run, access)
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

it('answers the port, scheme and token the page needs to build an address', async () => {
  // All three come from the running process: the port is assigned at startup and the token is minted per launch, so
  // neither is something the configuration could hold or the page could read for itself.
  const response = await serve(keysDir({}), undefined,
    () => ({ localPort: 65277, protocol: 'http:', token: 'abc' }))('GET', 'access')
  expect(response.body).toEqual({ localPort: 65277, protocol: 'http:', token: 'abc' })
})

it('still reports the port when nothing can mint a token, rather than a link to the sign-in wall', async () => {
  // A host with no connection service has no token, and the page says so instead of printing a URL that would fail.
  const response = await serve(keysDir({}))('GET', 'access')
  expect(response.body).toMatchObject({ localPort: 3088, protocol: 'http:' })
  expect((response.body as { token?: unknown }).token).toBeUndefined()
})

it('answers whether the hub can take the port, and whether it keeps idle links alive', async () => {
  const directory = keysDir({ id_ed25519: 'P', 'id_ed25519.pub': 'ssh-ed25519 AAAA c' })
  const seen: (readonly string[])[] = []
  const inputs: (string | undefined)[] = []
  const response = await serve(directory, async (argv, input) => {
    seen.push(argv)
    inputs.push(input)
    return { code: 0, output: 'PORT=busy\nCLIENTALIVE=0\n' }
  })('POST', 'port', { host: 'h', port: 22, user: 'u', keyPath: join(directory, 'id_ed25519'), remotePort: 13100 })
  expect(response.body).toMatchObject({ port: 'busy', clientAliveInterval: 0 })
  // The script travels on stdin: ssh would otherwise re-quote it through the hub's login shell.
  expect(inputs[0]).toContain('13100')
  expect(seen[0]!.at(-1)).toBe('sh -s')
})

it('keeps "could not tell" apart from "free", because only one of them is permission to save', async () => {
  const directory = keysDir({ id_ed25519: 'P', 'id_ed25519.pub': 'ssh-ed25519 AAAA c' })
  const request = serve(directory, async () => ({ code: 255, output: 'Permission denied (publickey).' }))
  const response = await request('POST', 'port',
    { host: 'h', user: 'u', keyPath: join(directory, 'id_ed25519'), remotePort: 13100 })
  expect(response.status).toBe(200)
  expect(response.body).toMatchObject({ port: 'unknown', output: 'Permission denied (publickey).' })
})

it('refuses a port check with no port, and never runs ssh for one', async () => {
  let ran = 0
  const directory = keysDir({ id_ed25519: 'P', 'id_ed25519.pub': 'ssh-ed25519 AAAA c' })
  const request = serve(directory, async () => { ran++; return { code: 0, output: '' } })
  const missing = await request('POST', 'port', { host: 'h', user: 'u', keyPath: join(directory, 'id_ed25519') })
  expect(missing.status).toBe(400)
  const wild = await request('POST', 'port',
    { host: 'h', user: 'u', keyPath: join(directory, 'id_ed25519'), remotePort: 70000 })
  expect(wild.status).toBe(400)
  expect(ran).toBe(0)
})

it('reads both answers out of the script output and drops the markers', () => {
  expect(parsePortCheck('PORT=free\nCLIENTALIVE=30\n')).toEqual({ port: 'free', clientAliveInterval: 30, output: '' })
  // A script that printed nothing is not a device that reported "free".
  expect(parsePortCheck('')).toMatchObject({ port: 'unknown', clientAliveInterval: 0 })
  expect(parsePortCheck('PORT=busy\nCLIENTALIVE=0\nsome warning').output).toBe('some warning')
})

it('asks the hub about the chosen port, and reads the keepalive from the effective configuration', () => {
  const script = portCheckScript(13100)
  expect(script).toContain('13100')
  // `sshd -T` is the effective configuration, so an `Include`d file is covered; the file is the fallback.
  expect(script).toContain('sshd -T')
  expect(script).toContain('sshd_config')
  expect(portCheckArgs({ host: 'h', port: 2222, user: 'u', keyPath: '/k' })).toEqual(['ssh', '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=accept-new', '-p', '2222', '-i', '/k', 'u@h', 'sh -s'])
})
