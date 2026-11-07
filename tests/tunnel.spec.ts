/**
 * The device's tunnel: what argv it builds, when it is allowed to call itself connected, and what it says when it
 * cannot be. Every test injects both the spawn and the probe, so nothing here starts ssh or opens a socket.
 */
import { describe, expect, it, vi } from 'vitest'
import { Tunnel, explain, tunnelArgs, type TunnelChild } from '../src/tunnel.ts'
import type { SshConfig } from '../src/index.ts'

const ssh = (overrides: Partial<SshConfig> = {}): SshConfig =>
  ({ enabled: true, host: 'hub.example', port: 22, user: 'me', keyPath: '/home/me/.ssh/id_ed25519',
    remotePort: 8790, localPort: 8790, ...overrides })

/** A child that reports the exit the test asked for, on the next tick, so the retry path runs. */
type FakeChild = TunnelChild & { killed: boolean; emitExit(code: number | null, stderr?: string): void }
function fakeChild(exit?: { code: number | null; stderr?: string }): FakeChild {
  const listeners: ((code: number | null) => void)[] = []
  const stderrListeners: ((chunk: Buffer) => void)[] = []
  const child = {
    killed: false,
    /** Fires one `exit` after the tunnel was already working, which is the case this fake exists to model. */
    emitExit(code: number | null, stderrText?: string) {
      if (stderrText !== undefined) for (const listener of stderrListeners) listener(Buffer.from(stderrText))
      for (const listener of listeners) listener(code)
    },
    kill() { child.killed = true; return true },
    on(event: string, listener: never) {
      if (event === 'exit') listeners.push(listener)
      if (event === 'error') void listener
      return child
    },
    stderr: { on(event: string, listener: never) {
      if (event === 'data') stderrListeners.push(listener as (chunk: Buffer) => void)
      return child.stderr
    } },
  }
  if (exit !== undefined) {
    // stderr first, then the exit: that is the order a real ssh reports a failure in.
    setTimeout(() => {
      if (exit.stderr !== undefined) for (const listener of stderrListeners) listener(Buffer.from(exit.stderr))
      for (const listener of listeners) listener(exit.code)
    }, 0)
  }
  return child as unknown as FakeChild
}

describe('the ssh command the tunnel runs', () => {
  it('fails fast instead of pretending the forward worked', () => {
    expect(tunnelArgs(ssh({ port: 2222, keyPath: '/k', remotePort: 8790, localPort: 8791 }))).toEqual(['ssh', '-N', '-T',
      '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3',
      '-p', '2222', '-i', '/k', '-L', '8791:127.0.0.1:8790', 'me@hub.example'])
  })
})

describe('a tunnel that works', () => {
  it('reaches connected only after the local port answers', async () => {
    const states: string[] = []
    const tunnel = new Tunnel({ ssh: ssh(), spawn: () => fakeChild(), probe: async () => true,
      onState: state => states.push(state) })
    tunnel.start()
    await vi.waitFor(() => expect(tunnel.state()).toBe('connected'))
    expect(states).toEqual(['connecting', 'connected'])
  })

  it('is not connected before the port answers', async () => {
    let answers = false
    const tunnel = new Tunnel({ ssh: ssh(), spawn: () => fakeChild(), probe: async () => answers })
    tunnel.start()
    // The process is up, but nothing is listening yet, so the honest state is still connecting.
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(tunnel.state()).toBe('connecting')
    answers = true
    await vi.waitFor(() => expect(tunnel.state()).toBe('connected'))
  })
})

describe('a tunnel that fails', () => {
  it('names the key when the hub refuses it', async () => {
    const tunnel = new Tunnel({ ssh: ssh(), spawn: () => fakeChild({ code: 255, stderr: 'Permission denied (publickey).' }),
      probe: async () => false, log: () => {} })
    tunnel.start()
    await vi.waitFor(() => expect(tunnel.state()).toBe('failed'))
    expect(tunnel.failure()).toContain('Permission denied (publickey)')
  })

  it('names the occupied local port rather than reprinting the bind error', async () => {
    const tunnel = new Tunnel({ ssh: ssh({ localPort: 8790 }), probe: async () => false,
      spawn: () => fakeChild({ code: 255, stderr: 'bind [127.0.0.1]:8790: Address already in use\nCould not request local forwarding.' }),
      log: () => {} })
    tunnel.start()
    await vi.waitFor(() => expect(tunnel.state()).toBe('failed'))
    expect(tunnel.failure()).toContain('8790')
    expect(tunnel.failure()).toContain('already in use')
  })

  it('tells a person to accept the host key rather than reporting a bare failure', async () => {
    expect(explain(ssh(), 'Host key verification failed.')).toContain('known_hosts')
  })

  it('tells a person the host could not be resolved', async () => {
    expect(explain(ssh({ host: 'nope.example' }), 'ssh: Could not resolve hostname nope.example')).toContain('could not be resolved')
  })

  it('falls back to naming the hub when ssh says nothing useful', async () => {
    expect(explain(ssh(), '')).toContain('hub.example')
  })

  it('retries after a failure instead of giving up', async () => {
    let spawns = 0
    const tunnel = new Tunnel({ ssh: ssh(), spawn: () => { spawns++; return fakeChild({ code: 255, stderr: 'boom' }) },
      probe: async () => false, retryMs: 5, log: () => {} })
    tunnel.start()
    await vi.waitFor(() => expect(spawns).toBeGreaterThan(1))
  })

  it('does not call an attempt a failure just because it is slow to listen, before the deadline', async () => {
    const tunnel = new Tunnel({ ssh: ssh(), spawn: () => fakeChild(), probe: async () => false, log: () => {} })
    tunnel.start()
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(tunnel.state()).toBe('connecting')
    tunnel.stop()
  })
})

describe('a tunnel that worked and then died', () => {
  it('notices the exit and retries, instead of staying silently connected', async () => {
    // The worst failure this class can have: it reports connected once, the link drops, and nothing ever notices.
    // A device in that state takes no work and looks online, so this case is pinned rather than left to luck.
    let spawns = 0
    const children: FakeChild[] = []
    const tunnel = new Tunnel({ ssh: ssh(), retryMs: 5, log: () => {}, probe: async () => true,
      spawn: () => { spawns++; const child = fakeChild(); children.push(child); return child } })
    tunnel.start()
    await vi.waitFor(() => expect(tunnel.state()).toBe('connected'))
    // The link drops after the tunnel was working.
    children[0]!.emitExit(255, 'Connection reset by peer')
    await vi.waitFor(() => expect(tunnel.state()).toBe('failed'))
    await vi.waitFor(() => expect(spawns).toBeGreaterThan(1))
  })
})

describe('stopping', () => {
  it('kills the child instead of leaving it running', () => {
    const child = fakeChild()
    const tunnel = new Tunnel({ ssh: ssh(), spawn: () => child, probe: async () => true })
    tunnel.start(); tunnel.stop()
    expect(child.killed).toBe(true)
    expect(tunnel.state()).toBe('idle')
  })

  it('starts no further attempt once stopped, however many it made before', async () => {
    let spawns = 0
    const tunnel = new Tunnel({ ssh: ssh(), spawn: () => { spawns++; return fakeChild({ code: 255, stderr: 'x' }) },
      probe: async () => false, retryMs: 5, log: () => {} })
    tunnel.start()
    await vi.waitFor(() => expect(tunnel.state()).toBe('failed'))
    tunnel.stop()
    // Attempts before the stop are the retry working; what matters is that none follows it.
    const atStop = spawns
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(spawns).toBe(atStop)
  })
})
