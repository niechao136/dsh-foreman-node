/**
 * Publishing this machine's page on the hub: what argv it builds, when it is allowed to call itself connected, and
 * what it says when the hub refuses the port. Every test injects the spawn, so nothing here starts ssh.
 *
 * The readiness rule is the reason this file exists. A reverse forward offers no local port to probe, so the only
 * evidence available is "the process did not fail", and the interesting failure is the one ssh does *not* exit on:
 * it warns that the remote forward was refused and keeps running. Both are pinned here.
 */
import { describe, expect, it, vi } from 'vitest'
import { Expose, explainExpose, exposeArgs, forwardRefused, type ExposeChild } from '../src/expose.ts'
import type { SshConfig } from '../src/config.ts'

const ssh = (overrides: Partial<SshConfig> = {}): SshConfig =>
  ({ enabled: true, host: 'hub.example', port: 22, user: 'me', keyPath: '/home/me/.ssh/id_ed25519',
    remotePort: 8790, localPort: 8790, ...overrides })

type FakeChild = ExposeChild & { killed: boolean; emitExit(code: number | null): void; say(text: string): void }
/** A child that records what was written to it and can report stderr and an exit on demand. */
function fakeChild(): FakeChild {
  const exits: ((code: number | null) => void)[] = []
  const errors: ((error: Error) => void)[] = []
  const stderr: ((chunk: Buffer) => void)[] = []
  const child: FakeChild = {
    killed: false,
    emitExit(code) { for (const listener of exits) listener(code) },
    say(text) { for (const listener of stderr) listener(Buffer.from(text)) },
    kill() { child.killed = true; return true },
    on(event: string, listener: never) {
      if (event === 'exit') exits.push(listener)
      if (event === 'error') errors.push(listener)
      return child
    },
    stderr: { on(event: string, listener: never) {
      if (event === 'data') stderr.push(listener as (chunk: Buffer) => void)
      return child.stderr
    } },
  }
  return child
}

describe('the ssh command the publisher runs', () => {
  it('binds the hub port to the hub loopback only, and forwards to this machine web port', () => {
    // `GatewayPorts yes` on the hub would otherwise put this machine's configuration page on a public interface:
    // the hub's ledger is protected by listening on loopback only, and this must not be the hole in that.
    expect(exposeArgs(ssh({ port: 2222, keyPath: '/k' }), 13100, 65277)).toEqual(['ssh', '-N', '-T',
      '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3',
      '-p', '2222', '-i', '/k', '-R', '127.0.0.1:13100:127.0.0.1:65277', 'me@hub.example'])
  })

  it('reads the local port at every attempt, so a restarted DSH is republished on its new port', async () => {
    // The OS assigns the port, so capturing it once would keep publishing a port that stopped listening.
    const seen: number[] = []
    let port = 65277
    const tunnel = new Expose({ ssh: ssh(), remotePort: 13100, localPort: () => port, retryMs: 5, readyMs: 5,
      spawn: argv => { seen.push(Number(argv[argv.indexOf('-R') + 1]!.split(':')[3])); return fakeChild() }, log: () => {} })
    tunnel.start()
    await vi.waitFor(() => expect(seen).toEqual([65277]))
    port = 65371
    tunnel.stop()
    tunnel.start()
    await vi.waitFor(() => expect(seen).toEqual([65277, 65371]))
  })
})

describe('a publish that works', () => {
  it('reaches connected only after the process has stayed alive', async () => {
    const states: string[] = []
    const tunnel = new Expose({ ssh: ssh(), remotePort: 13100, localPort: () => 65277, readyMs: 10,
      spawn: () => fakeChild(), onState: state => states.push(state) })
    tunnel.start()
    expect(tunnel.state()).toBe('connecting')
    await vi.waitFor(() => expect(tunnel.state()).toBe('connected'))
    expect(states).toEqual(['connecting', 'connected'])
  })

  it('retries when there is no web port yet, instead of reporting the hub as broken', async () => {
    // A device boots before its web server is listening; that is a reason to wait, not a reason to give up.
    let spawns = 0
    let port: number | undefined
    const tunnel = new Expose({ ssh: ssh(), remotePort: 13100, localPort: () => port, retryMs: 5, readyMs: 5,
      spawn: () => { spawns++; return fakeChild() }, log: () => {} })
    tunnel.start()
    await vi.waitFor(() => expect(tunnel.state()).toBe('failed'))
    expect(spawns).toBe(0)
    port = 65277
    await vi.waitFor(() => expect(tunnel.state()).toBe('connected'))
  })
})

describe('a publish that fails', () => {
  it('names the occupied hub port rather than reprinting the forward error', async () => {
    // ssh refuses the remote forward and keeps running: without reading stderr this reads as a working port.
    const child = fakeChild()
    const tunnel = new Expose({ ssh: ssh(), remotePort: 13100, localPort: () => 65277, retryMs: 5, readyMs: 1_000,
      spawn: () => child, log: () => {} })
    tunnel.start()
    child.say('Warning: remote port forwarding failed for listen port 13100\n')
    await vi.waitFor(() => expect(tunnel.state()).toBe('failed'))
    expect(tunnel.failure()).toContain('13100')
    expect(tunnel.failure()).toContain('another one')
  })

  it('recognises the refusal from stderr alone, because the process stays alive', () => {
    expect(forwardRefused('Warning: remote port forwarding failed for listen port 13100')).toBe(true)
    expect(forwardRefused('bind [127.0.0.1]:13100: Address already in use')).toBe(true)
    expect(forwardRefused('')).toBe(false)
  })

  it('does not call an attempt a failure just because it is slow to settle, before the deadline', async () => {
    const tunnel = new Expose({ ssh: ssh(), remotePort: 13100, localPort: () => 65277, readyMs: 1_000,
      spawn: () => fakeChild(), log: () => {} })
    tunnel.start()
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(tunnel.state()).toBe('connecting')
    tunnel.stop()
  })

  it('retries after a failure instead of giving up', async () => {
    let spawns = 0
    const tunnel = new Expose({ ssh: ssh(), remotePort: 13100, localPort: () => 65277, retryMs: 5, readyMs: 5,
      spawn: () => { spawns++; return fakeChild() }, log: () => {} })
    tunnel.start()
    const first = tunnel
    await vi.waitFor(() => expect(first.state()).toBe('connected'))
    // The link drops after the publish was working: the exit has to reach `failed` and schedule another attempt.
    ;(first as unknown as { child?: FakeChild }).child?.emitExit(255)
    await vi.waitFor(() => expect(spawns).toBeGreaterThan(1))
  })

  it('tells a person to accept the host key rather than reporting a bare failure', () => {
    expect(explainExpose(ssh(), 13100, 'Host key verification failed.')).toContain('known_hosts')
  })

  it('tells a person the host could not be resolved', () => {
    expect(explainExpose(ssh({ host: 'nope.example' }), 13100, 'ssh: Could not resolve hostname nope.example'))
      .toContain('could not be resolved')
  })
})

describe('stopping', () => {
  it('kills the child instead of leaving the hub port bound', async () => {
    const child = fakeChild()
    const tunnel = new Expose({ ssh: ssh(), remotePort: 13100, localPort: () => 65277, readyMs: 1_000,
      spawn: () => child })
    tunnel.start()
    await vi.waitFor(() => expect(tunnel.state()).toBe('connecting'))
    tunnel.stop()
    expect(child.killed).toBe(true)
    expect(tunnel.state()).toBe('idle')
  })

  it('starts no further attempt once stopped', async () => {
    let spawns = 0
    const tunnel = new Expose({ ssh: ssh(), remotePort: 13100, localPort: () => 65277, retryMs: 5, readyMs: 5,
      spawn: () => { spawns++; const child = fakeChild(); setTimeout(() => child.emitExit(255), 0); return child },
      log: () => {} })
    tunnel.start()
    await vi.waitFor(() => expect(tunnel.state()).toBe('failed'))
    tunnel.stop()
    const atStop = spawns
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(spawns).toBe(atStop)
  })
})
