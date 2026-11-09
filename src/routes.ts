/**
 * The device's loopback routes: what keys exist, whether a given one reaches a given host, what address this
 * machine's page is on, and whether the hub can take the port it would publish.
 *
 * These exist because the configuration page is a web page: it cannot read `~/.ssh`, cannot start ssh, and cannot
 * ask the process what port it was given. The device process can, so it answers all of them and the page renders
 * the answers. Nothing here writes configuration — the page saves through DSH's own configuration form — and
 * nothing here reads a private key or keeps a session open.
 *
 * They are registered by the caller through `ctx.inject(['webServer'], …)` rather than listed in `inject`, and that is
 * deliberate: a device with no web UI (a headless or CLI DSH) must still take work. It simply has no configuration
 * page, which is a missing convenience, not a broken device.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { spawn } from 'node:child_process'
import { listKeys, type SshKey } from './keys.ts'
import type { SshConfig } from './config.ts'

/** What one authentication test found. `ok` false is a normal answer, not an error. */
export interface TestResult { ok: boolean; output: string }

/**
 * Runs one command and reports its exit status with its output; injectable so a test never starts ssh.
 *
 * `input` is written to the child's stdin, which is how the port-check script reaches the hub without being
 * re-quoted by a login shell on the way.
 */
export type RunCommand = (argv: readonly string[], input?: string) => Promise<{ code: number | null; output: string }>

/** The connection the page is testing, exactly the four fields it collects. */
export interface TestInput { host: string; port: number; user: string; keyPath: string }

/**
 * What the page shows a person as "here is your page".
 *
 * The token is part of the answer because both addresses need it and neither can be built without it: this process
 * mints one per launch, and the page has no other way to learn it. It stays inside the same-origin guard the rest of
 * these routes live behind, so it is shown to the page that is editing this machine's configuration and nothing else.
 *
 * The port is the web server's own, read at request time: DSH is given one by the operating system at startup, so it
 * is never a value anyone could have written into the configuration.
 */
export interface AccessAnswer {
  /** The port this machine's DSH was actually given, or undefined before the web server is listening. */
  localPort: number | undefined
  /** The scheme the web server serves, so the page builds `https://` on a TLS-terminated host. */
  protocol: 'http:' | 'https:'
  /** The `?token=…` value this process accepts, or undefined on a host with no connection service. */
  token: string | undefined
}

/**
 * One port check, answered by the hub itself.
 *
 * `port` is the answer to "can the hub listen there", and `clientAliveInterval` is a second question asked in the
 * same round trip because it is about the same connection: a hub that never probes an idle link keeps a published
 * port bound to a device that has gone away, and the operator cannot tell that from the page unless it is shown.
 */
export interface PortCheckAnswer {
  port: 'busy' | 'free' | 'unknown'
  /** The hub's own `ClientAliveInterval`, in seconds; 0 when it is not configured at all. */
  clientAliveInterval: number
  /** ssh's own words, or the script's, when something went wrong; empty on a clean run. */
  output: string
}

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

/**
 * The shell the hub runs to answer the two questions this page cannot answer from here.
 *
 * It has to be one round trip: every extra ssh is another key exchange against a machine that may be slow, and the
 * operator is waiting on a button. Both answers are printed with a fixed prefix so a parser never has to understand
 * the hub's `ss` output — only the lines it produced itself.
 *
 * `ss` is asked first because it is present on the Linux hosts this runs against and reports listening sockets
 * without needing privileges. The `netstat` and `lsof` fallbacks cover a hub that has neither; when all three are
 * missing the answer is `unknown` rather than a guess, because "free" would be a lie this page acts on.
 */
export function portCheckScript(remotePort: number): string {
  return [
    `p=${remotePort}`,
    'if command -v ss >/dev/null 2>&1; then',
    '  if ss -H -ltn 2>/dev/null | grep -qE "[:.]${p}([[:space:]]|$)"; then echo "PORT=busy"; else echo "PORT=free"; fi',
    'elif command -v netstat >/dev/null 2>&1; then',
    '  if netstat -an 2>/dev/null | grep -qE "[.:]${p}[[:space:]].*LISTEN"; then echo "PORT=busy"; else echo "PORT=free"; fi',
    'elif command -v lsof >/dev/null 2>&1; then',
    '  if lsof -nP -iTCP:${p} -sTCP:LISTEN >/dev/null 2>&1; then echo "PORT=busy"; else echo "PORT=free"; fi',
    'else echo "PORT=unknown"; fi',
    // `sshd -T` prints the effective configuration and needs root on most hosts, so the file is read as well and
    // whichever answered is what the page shows. A commented-out directive is absent from both, which is the case
    // this check exists to surface.
    'c=""',
    'if command -v sshd >/dev/null 2>&1; then c=$(sshd -T 2>/dev/null | awk \'tolower($1)=="clientaliveinterval"{print $2}\' | tail -1); fi',
    'if [ -z "$c" ]; then c=$(awk \'tolower($1)=="clientaliveinterval"{print $2}\' /etc/ssh/sshd_config 2>/dev/null | tail -1); fi',
    'echo "CLIENTALIVE=${c:-0}"',
  ].join('\n')
}

/**
 * The argv of one port check: run `portCheckScript` on the hub through `sh`.
 *
 * The script goes in on stdin rather than as an argument. ssh joins its remaining arguments into one command string
 * and hands it to the hub's login shell, so a script passed that way would be quoted, re-quoted, and still be one
 * `$(...)` away from being mangled — and this script contains quoting of its own. `sh -s` is a single word with no
 * expansion in it, and stdin carries the rest byte for byte.
 */
export function portCheckArgs({ host, port, user, keyPath }: TestInput): string[] {
  return ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=accept-new',
    '-p', String(port), '-i', keyPath, `${user}@${host}`, 'sh -s']
}

/** Reads the script's two answers out of its output, defaulting to "could not tell" for each. */
export function parsePortCheck(output: string): PortCheckAnswer {
  const port = /^PORT=(busy|free|unknown)$/m.exec(output)?.[1]
  const interval = /^CLIENTALIVE=(\d+)$/m.exec(output)?.[1]
  return {
    port: port === 'busy' || port === 'free' ? port : 'unknown',
    clientAliveInterval: interval === undefined ? 0 : Number(interval),
    output: output.replace(/^(PORT|CLIENTALIVE)=.*$/gm, '').trim(),
  }
}

/** The default runner: a real ssh, resolving to its exit status either way. */
const realRun: RunCommand = (argv, input) => new Promise(resolve => {
  const child = spawn(argv[0]!, argv.slice(1), { stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    windowsHide: true })
  let output = ''
  const collect = (chunk: Buffer) => { output = (output + chunk.toString('utf8')).slice(-OUTPUT_KEEP) }
  child.stdout?.on('data', collect)
  child.stderr?.on('data', collect)
  // The port-check script travels on stdin; every other command ignores it. Written and closed here rather than
  // left open, because ssh's `sh -s` waits for EOF before it runs anything.
  if (input !== undefined) {
    child.stdin?.on('error', () => {})
    child.stdin?.end(input)
  }
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
/** The loopback names a host header may carry; DSH's desktop build normalizes`::1` and `localhost` to each other. */
const LOOPBACK = ['127.0.0.1', 'localhost', '::1', '[::1]']

export function sameOrigin(req: Pick<IncomingMessage, 'headers'>, port: number, protocol = 'http:'): boolean {
  const host = req.headers.host
  if (host === undefined) return false
  // `host:port` for IPv4 and names, `[::1]:port` for a bracketed IPv6 literal.
  const match = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(host)
  if (match === null) return false
  const [, name, seen] = match
  // A request addressed to another host is a DNS-rebinding attempt, whatever its Origin says.
  if (!LOOPBACK.includes(name!) || Number(seen) !== port) return false
  // The scheme comes from the service: a TLS-terminated DSH sends `https://` and would otherwise be refused here.
  return req.headers['x-orchestrator-request'] === '1'
    && (req.headers.origin === undefined || req.headers.origin === `${protocol}//${host}`)
}

/** The prefix both routes live under; it never collides with the hub's `/orchestrator`. */
export const NODE_PREFIX = '/foreman-node'

export interface RouteHost {
  /** The web server service: the only thing this module needs from the host. */
  register(route: { kind: 'prefix'; path: string
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }): () => void
  /** The port the web server listens on, used by the same-origin check. */
  port: number
  /** The scheme the web server serves, so a TLS-terminated host's `https://` origin is accepted. */
  protocol?: string
}

/**
 * Registers the routes and returns their disposer.
 *
 * `listKeys` and `run` are injectable so tests can answer without a filesystem or a child process; production passes
 * a directory and the real runner. `access` is a callback rather than a value because the port it reports is the
 * one the web server was given at startup, and the token it carries is this process's own — both belong to whoever
 * mounted these routes, which is the only code that can see them.
 */
export function registerNodeRoutes(host: RouteHost, directory: string, run: RunCommand = realRun,
  access?: () => AccessAnswer): () => void {
  return host.register({ kind: 'prefix', path: NODE_PREFIX, handler: async (req, res) => {
    // The guard runs before routing: an unauthenticated caller learns nothing about what exists here.
    if (!sameOrigin(req, host.port, host.protocol)) { json(res, 403, { error: 'Same-origin request required' }); return }
    const url = new URL(req.url ?? '/', 'http://localhost')
    const method = req.method ?? 'GET'
    try {
      if (url.pathname === `${NODE_PREFIX}/api/keys` && method === 'GET') {
        const keys: SshKey[] = listKeys(directory)
        json(res, 200, { keys, directory })
        return
      }
      if (url.pathname === `${NODE_PREFIX}/api/access` && method === 'GET') {
        // No `access` means the caller mounted these routes without a connection service. The port is still known —
        // the web server has one — but nothing can mint a token, and the page says so rather than printing a link
        // that would land on the sign-in wall.
        const answer: AccessAnswer = access?.()
          ?? { localPort: host.port, protocol: (host.protocol === 'https:' ? 'https:' : 'http:'), token: undefined }
        json(res, 200, answer)
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
        // Only a key this machine already offers may be tested. The page can only pick from that list, so anything
        // else is either a stale form or a caller asking this process to run ssh against a path of its choosing;
        // neither is a reason to start a process.
        const keyPath = input.keyPath.trim()
        const known = listKeys(directory).find(key => key.path === keyPath)
        if (known === undefined) {
          json(res, 400, { error: `no key at ${keyPath}; the page lists the ones this machine has` })
          return
        }
        const result = await run(testArgs({ host: input.host.trim(), port, user: input.user.trim(), keyPath }))
        // A refused key is an answer the page shows, not a server error: 200 with `ok: false` and ssh's own words.
        json(res, 200, { ok: result.code === 0, output: result.output })
        return
      }
      if (url.pathname === `${NODE_PREFIX}/api/port` && method === 'POST') {
        const input = (await body(req)) as Partial<TestInput> & { remotePort?: unknown }
        if (typeof input.host !== 'string' || input.host.trim() === '' || typeof input.user !== 'string' || input.user.trim() === ''
          || typeof input.keyPath !== 'string' || input.keyPath.trim() === '') {
          json(res, 400, { error: 'host, user and keyPath are required' })
          return
        }
        const remotePort = input.remotePort
        if (typeof remotePort !== 'number' || !Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
          json(res, 400, { error: 'remotePort must be a port number' })
          return
        }
        const port = typeof input.port === 'number' && Number.isInteger(input.port) && input.port > 0 && input.port <= 65535 ? input.port : 22
        // The same whitelist as the test route: this process runs ssh only against a key it already offered, so a
        // caller cannot turn the route into "run ssh with a key of my choosing".
        const keyPath = input.keyPath.trim()
        const known = listKeys(directory).find(key => key.path === keyPath)
        if (known === undefined) {
          json(res, 400, { error: `no key at ${keyPath}; the page lists the ones this machine has` })
          return
        }
        const result = await run(portCheckArgs({ host: input.host.trim(), port, user: input.user.trim(), keyPath }),
          portCheckScript(remotePort))
        // A check that could not run is still a 200 with `unknown`: the page distinguishes "taken" from "could not
        // tell" and telling them apart is the point of the button.
        json(res, 200, result.code === 0
          ? parsePortCheck(result.output)
          : { port: 'unknown', clientAliveInterval: 0, output: result.output } satisfies PortCheckAnswer)
        return
      }
      json(res, 404, { error: 'Unknown operation' })
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  } })
}
