/**
 * The device's configuration page, mounted in the DSH Plugin Manager.
 *
 * It does two things the page alone cannot: it lists the keys this machine has (through the device's own route, because
 * a browser cannot read `~/.ssh`) and it tests one authentication (also through the device, because a browser cannot
 * start ssh). Everything it *writes* goes through DSH's own configuration form, so the saved values land in the
 * profile's patch exactly as if they had been typed there by hand.
 */
import { useEffect, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { ConfigPageForm, PluginConfigViewProps } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { NodeConfig } from '../index.ts'
import type { SshKey } from '../keys.ts'
import type { TestResult } from '../routes.ts'
import { addressPreview, configOf, DEFAULT_SSH, emptyFields, keyLabel, testMessage } from './page-state.ts'
import { en, zh } from './locales.ts'

/** The prefix the device's own routes answer under. */
const API = '/foreman-node/api'

/** A key list answer, as `GET /foreman-node/api/keys` sends it. */
interface KeysAnswer { keys: SshKey[]; directory: string }

/** Fetches a key list or runs one test; both need the marker header the device's same-origin check looks for. */
async function ask<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(new URL(`${API}/${path}`, window.location.href), {
    ...init, headers: { 'x-orchestrator-request': '1', ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }), ...init?.headers } })
  if (!response.ok) throw new Error(`the device answered ${response.status}`)
  return await response.json() as T
}

export const inject = ['locale', 'slots']
export const name = 'dsh-foreman-node'

/** The locale namespace this page registers its dictionaries under. */
const NS = 'dshNode'

/**
 * The page itself. `t` comes from the host's locale service, like every other plugin's page.
 *
 * `initialKeys` and `keysFailed` exist so a test can render a page without a network or a web server. Production never
 * passes them, so the page fetches as it otherwise would — they change nothing about how it behaves.
 */
function DevicePage({ form, t, initialKeys, keysFailed: prefailed }: {
  t: (key: keyof typeof zh) => string
  form: ConfigPageForm | undefined
  initialKeys?: readonly SshKey[]
  keysFailed?: boolean
}) {
  // The draft starts from the saved value when there is one, so the first render already shows the configuration
  // rather than a loading line that only an effect would replace.
  const saved = form?.state.value as NodeConfig | undefined
  const editable = form?.state.status === 'ready' && form.state.writable
  // The draft starts from the saved value when there is one, so the first render already shows the configuration
  // rather than a loading line that only an effect would replace.
  const [draft, setDraft] = useState<NodeConfig | undefined>(() =>
    saved === undefined ? undefined : { ...saved, ssh: { ...DEFAULT_SSH, ...saved.ssh } })
  const [keys, setKeys] = useState<SshKey[] | undefined>(initialKeys === undefined ? undefined : [...initialKeys])
  const [keysFailed, setKeysFailed] = useState(prefailed === true)
  const [tested, setTested] = useState<TestResult>()
  const [testing, setTesting] = useState(false)
  const [notice, setNotice] = useState<string>()

  // The form's value is the saved truth; the draft is what a person is editing on top of it, so it is only adopted
  // when nothing has been typed yet — a form that reloads must not overwrite a half-finished edit.
  useEffect(() => { if (saved !== undefined) setDraft(current => current ?? { ...saved, ssh: { ...DEFAULT_SSH, ...saved.ssh } }) }, [saved])
  useEffect(() => {
    if (initialKeys !== undefined || prefailed === true) return
    ask<KeysAnswer>('keys').then(answer => setKeys(answer.keys), () => setKeysFailed(true))
  }, [initialKeys, prefailed])

  const patch = (change: Partial<NodeConfig>) => setDraft(current => current === undefined ? current : { ...current, ...change })
  const patchSsh = (change: Partial<NodeConfig['ssh']>) =>
    setDraft(current => current === undefined ? current : { ...current, ssh: { ...current.ssh, ...change } })

  const test = async () => {
    if (draft === undefined) return
    setTesting(true); setTested(undefined)
    try {
      setTested(await ask<TestResult>('test', { method: 'POST', body: JSON.stringify({ host: draft.ssh.host.trim(),
        port: draft.ssh.port, user: draft.ssh.user.trim(), keyPath: draft.ssh.keyPath.trim() }) }))
    } catch (error) { setTested({ ok: false, output: String(error) }) } finally { setTesting(false) }
  }

  const save = async () => {
    if (draft === undefined || form === undefined) return
    setNotice(undefined)
    try {
      const ok = await form.mutate([{ op: 'set', path: [], value: configOf(draft) }], form.state.revision)
      setNotice(ok ? t('saved') : t('saveFailed'))
    } catch { setNotice(t('saveFailed')) }
  }

  if (draft === undefined) return <div data-foreman-node-page="loading">{t('loading')}</div>
  const address = addressPreview(draft)
  const missing = emptyFields(draft)
  return <div data-foreman-node-page="ready">
    <h2>{t('title')}</h2>
    <p className="dt-hint">{t('intro')}</p>

    <section data-section="keys">
      <h3>{t('keysSection')}</h3>
      <p className="dt-hint">{t('keysHint')}</p>
      {keysFailed
        ? <p data-keys="unavailable">{t('keysUnavailable')}</p>
        : keys === undefined ? <p>{t('loading')}</p>
          : keys.length === 0 ? <p data-keys="empty">{t('keysEmpty')}</p>
            : <select aria-label={t('keysSection')} data-node-key value={draft.ssh.keyPath}
                onChange={event => patchSsh({ keyPath: event.target.value })}>
                <option value="">—</option>
                {keys.map(key => <option key={key.path} value={key.path}>{keyLabel(key)}</option>)}
              </select>}
      <label>{t('keyPath')}
        <input data-node-key-path value={draft.ssh.keyPath} disabled={!editable}
          onChange={event => patchSsh({ keyPath: event.target.value })} />
      </label>
    </section>

    <section data-section="ssh">
      <h3>{t('sshSection')}</h3>
      <label><input type="checkbox" data-node-ssh-enabled checked={draft.ssh.enabled} disabled={!editable}
        onChange={event => patchSsh({ enabled: event.target.checked })} />{t('sshEnabled')}</label>
      <p className="dt-hint">{t('sshEnabledHint')}</p>
      {draft.ssh.enabled && <>
        <label>{t('host')}<input data-node-host value={draft.ssh.host} disabled={!editable}
          onChange={event => patchSsh({ host: event.target.value })} /></label>
        <label>{t('port')}<input type="number" data-node-port value={draft.ssh.port} disabled={!editable}
          onChange={event => patchSsh({ port: Number(event.target.value) })} /></label>
        <label>{t('user')}<input data-node-user value={draft.ssh.user} disabled={!editable}
          onChange={event => patchSsh({ user: event.target.value })} /></label>
        <label>{t('remotePort')}<input type="number" data-node-remote-port value={draft.ssh.remotePort} disabled={!editable}
          onChange={event => patchSsh({ remotePort: Number(event.target.value) })} /></label>
        <label>{t('localPort')}<input type="number" data-node-local-port value={draft.ssh.localPort} disabled={!editable}
          onChange={event => patchSsh({ localPort: Number(event.target.value) })} /></label>
        <button type="button" data-node-test data-testing={testing ? 'true' : undefined}
          disabled={!draft.ssh.host.trim() || !draft.ssh.user.trim() || !draft.ssh.keyPath.trim()}
          onClick={() => { void test() }}>{testing ? t('testing') : t('test')}</button>
        {tested !== undefined && <p data-test-result={testMessage(tested)}>
          {tested.ok ? t('testOk')
            : testMessage(tested) === 'passphrase' ? t('testPassphrase')
              : testMessage(tested) === 'unresolved' ? t('testUnresolved')
                : testMessage(tested) === 'timeout' ? t('testTimeout')
                  : `${t('testRefused')} ${tested.output}`}
        </p>}
      </>}
    </section>

    <section data-section="hub">
      <h3>{t('hubSection')}</h3>
      <label>{t('address')}
        <input data-node-url value={address.address} readOnly={address.derived} disabled={!editable || address.derived}
          onChange={event => patch({ url: event.target.value })} />
      </label>
      {address.derived && <p className="dt-hint">{t('addressDerived')}</p>}
      <label>{t('deviceId')}<input data-node-device value={draft.deviceId} disabled={!editable}
        onChange={event => patch({ deviceId: event.target.value })} /></label>
      <label>{t('token')}<input type="password" data-node-token value={draft.token} disabled={!editable}
        onChange={event => patch({ token: event.target.value })} /></label>
      <p className="dt-hint">{t('tokenHint')}</p>
    </section>

    <section data-section="roots">
      <h3>{t('rootsSection')}</h3>
      <p className="dt-hint">{t('rootsHint')}</p>
      {draft.roots.map((root, index) => <div key={index} data-root={index}>
        <label>{t('project')}<input value={root.project} disabled={!editable}
          onChange={event => patch({ roots: draft.roots.map((item, at) => at === index ? { ...item, project: event.target.value } : item) })} /></label>
        <label>{t('path')}<input value={root.path} disabled={!editable}
          onChange={event => patch({ roots: draft.roots.map((item, at) => at === index ? { ...item, path: event.target.value } : item) })} /></label>
      </div>)}
      <button type="button" disabled={!editable}
        onClick={() => patch({ roots: [...draft.roots, { project: '', path: '' }] })}>{t('addRoot')}</button>
    </section>

    {missing.length > 0 && <p data-missing="true">{t('missing')}{missing.join(', ')}</p>}
    {editable
      ? <button type="button" data-node-save onClick={() => { void save() }}>{t('save')}</button>
      : <p data-read-only="true">{t('readOnly')}</p>}
    {notice !== undefined && <p data-notice>{notice}</p>}
  </div>
}

/** The page as the Plugin Manager mounts it: locale and form come from the host. */
interface PageProps extends PluginConfigViewProps {
  t: (key: keyof typeof zh) => string
}

function Mounted({ t, form = undefined }: PageProps) {
  return <DevicePage t={t} form={form} />
}

/** Registers the page for the `dsh-foreman-node` row. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-foreman-node: dictionaries')
  const t = ctx.locale.bind(NS) as unknown as (key: keyof typeof zh) => string
  ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
    name: 'plugins.row.config', key: 'dsh-foreman-node#dsh-foreman-node', locale: NS },
  (props: PluginConfigViewProps) => <Mounted {...props} t={(props as { t?: typeof t }).t ?? t} />))
}

export { DevicePage }
