/**
 * The device's two loopback routes: what keys exist, and whether a given one reaches a given host.
 *
 * These exist because the configuration page is a web page: it cannot read `~/.ssh` and cannot start ssh. The device
 * process can, so it answers both and the page renders the answers. Nothing here writes configuration — the page
 * saves through DSH's own configuration form — and nothing here reads a private key or keeps a session open.
 *
 * They are registered by the caller through `ctx.inject(['webServer'], …)` rather than listed in `inject`, and that is
 * deliberate: a device with no web UI (a headless or CLI DSH) must still take work. It simply has no configuration
 * page, which is a missing convenience, not a broken device.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { spawn } from 'node:child_process'
import { listKeys, type SshKey } from './keys.ts'

/** What one authentication test found. `ok` false is a normal answer, not an error. */
export interface TestResult { ok: boolean; output: string }

/** Runs one command and reports its exit status with its output; injectable so a test never starts ssh. */
export type RunCommand = (argv: readonly string[]) => Promise<{ code: number | null; output: string }>

/** The connection the page is testing, exactly the four fields it collects. */
export interface TestInput { host: string; port: number; user: string; keyPath: string }

/** How long one authentication test may take before it is reported as a timeout. */
const TEST_TIMEOUT_MS = 15_000
/** How much of ssh's output to keep: the reason is at the end, and a page shows a few lines. */
const OUTPUT_KEEP = 2_048

/**
 * The argv of an authentication test.
 *
 * It asks for a command that does nothing (`true`) rather than opening a forward, because the question is only
 * "does this key authenticate", and `BatchMode=yes` keeps it from stopping to ask for a passphrase nobody can type.
 */
export function testArgs({ host, port, user, keyPath }: TestInput): string[] {
  return ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=accept-new',
    '-p', String(port), '-i', keyPath, `${user}@${host}`, 'true']
}

/** The default runner: a real ssh, resolving to its exit status either way. */
const realRun: RunCommand = argv => new Promise(resolve => {
  const child = spawn(argv[0]!, argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let output = ''
  const collect = (chunk: Buffer) => { output = (output + chunk.toString('utf8')).slice(-OUTPUT_KEEP) }
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)
  const timer = setTimeout(() => { output = `${output}\n(timed out after ${TEST_TIMEOUT_MS / 1000}s)`.trim(); child.kill('SIGKILL') }, TEST_TIMEOUT_MS)
  child.on('error', error => { clearTimeout(timer); resolve({ code: -1, output: `could not start ssh: ${error.message}` }) })
  child.on('exit', code => { clearTimeout(timer); resolve({ code, output: output.trim() }) })
})

/** Writes one JSON answer. */
function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff' })
  res.end(JSON.stringify(value))
}

/** Reads a JSON body, refusing anything larger than a form would send. */
async function body(req: IncomingMessage, maxBytes = 16 * 1024): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > maxBytes) throw new Error(`request exceeds ${maxBytes} bytes`)
    chunks.push(bytes)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
  catch { throw new Error('the request body is not JSON') }
}

/**
 * The same-origin guard the hub uses, for the same reason.
 *
 * The marker header alone proves nothing: any local process can send it. What the browser will not let another origin
 * do is send it *with* its own `Origin` intact, so an `Origin` that is present must be this page's. A request with no
 * `Origin` at all (a local tool, a test) is allowed and the marker still has to be there.
 */
export function sameOrigin(req: Pick<IncomingMessage, 'headers'>, port: number): boolean {
  const host = req.headers.host
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false
  return req.headers['x-orchestrator-request'] === '1'
    && (req.headers.origin === undefined || req.headers.origin === `http://${host}`)
}

/** The prefix both routes live under; it never collides with the hub's `/orchestrator`. */
export const NODE_PREFIX = '/foreman-node'

export interface RouteHost {
  /** The web server service: the only thing this module needs from the host. */
  register(route: { kind: 'prefix'; path: string
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }): () => void
  /** The port the web server listens on, used by the same-origin check. */
  port: number
}

/**
 * Registers the routes and returns their disposer.
 *
 * `listKeys` and `run` are injectable so tests can answer without a filesystem or a child process; production passes
 * a directory and the real runner.
 */
export function registerNodeRoutes(host: RouteHost, directory: string, run: RunCommand = realRun): () => void {
  return host.register({ kind: 'prefix', path: NODE_PREFIX, handler: async (req, res) => {
    // The guard runs before routing: an unauthenticated caller learns nothing about what exists here.
    if (!sameOrigin(req, host.port)) { json(res, 403, { error: 'Same-origin request required' }); return }
    const url = new URL(req.url ?? '/', 'http://localhost')
    const method = req.method ?? 'GET'
    try {
      if (url.pathname === `${NODE_PREFIX}/api/keys` && method === 'GET') {
        const keys: SshKey[] = listKeys(directory)
        json(res, 200, { keys, directory })
        return
      }
      if (url.pathname === `${NODE_PREFIX}/api/test` && method === 'POST') {
        const input = (await body(req)) as Partial<TestInput>
        if (typeof input.host !== 'string' || input.host.trim() === '' || typeof input.user !== 'string' || input.user.trim() === ''
          || typeof input.keyPath !== 'string' || input.keyPath.trim() === '') {
          json(res, 400, { error: 'host, user and keyPath are required' })
          return
        }
        const port = typeof input.port === 'number' && Number.isInteger(input.port) && input.port > 0 && input.port <= 65535 ? input.port : 22
        const result = await run(testArgs({ host: input.host.trim(), port, user: input.user.trim(), keyPath: input.keyPath.trim() }))
        // A refused key is an answer the page shows, not a server error: 200 with `ok: false` and ssh's own words.
        json(res, 200, { ok: result.code === 0, output: result.output })
        return
      }
      json(res, 404, { error: 'Unknown operation' })
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  } })
}
