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
import { configured, type NodeConfig } from '../config.ts'
import type { SshKey } from '../keys.ts'
import type { TestResult } from '../routes.ts'
import { ENTRY_ID, ENTRY_ORDER } from './entry.ts'
import { addressPreview, DEFAULT_SSH, editsOf, emptyFields, keyLabel, testMessage } from './page-state.ts'
import type { PageForm } from './section.ts'
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
  /**
   * The configuration form, or undefined when the host has not published this entry yet.
   *
   * The distinction matters: an absent form means "not readable yet", and a page that treated it as "nothing is
   * configured" would show an empty form and invite a save that overwrites the real values.
   */
  form: PageForm | undefined
  initialKeys?: readonly SshKey[]
  keysFailed?: boolean
}) {
  // The draft starts from the saved value when there is one, so the first render already shows the configuration
  // rather than a loading line that only an effect would replace.
  // The host hands over the section's raw value; every field is volatile, so it is unwrapped once here.
  const saved = form?.state.value === undefined ? undefined : configured(form.state.value as Partial<NodeConfig>)
  const editable = form?.state.status === 'ready' && form.state.writable
  // The draft starts from the saved value when there is one, so the first render already shows the configuration
  // rather than a loading line that only an effect would replace.
  const [draft, setDraft] = useState<NodeConfig | undefined>(() =>
    saved === undefined ? undefined : { ...saved, token: '', ssh: { ...DEFAULT_SSH, ...saved.ssh } })
  // The stored token never reaches the page (it is a secret), so the box starts empty and is only written when
  // someone types one. `keepsToken` is what tells the page it does not have to ask.
  // A stored token cannot be detected: it is stripped before it reaches the page, so `saved.token` is always
  // undefined. What can be known is that the section already exists, which is what the hint is based on.
  const keepsToken = saved !== undefined
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
      const ok = await form.mutate(editsOf(draft), form.state.revision)
      setNotice(ok ? t('saved') : t('saveFailed'))
    } catch { setNotice(t('saveFailed')) }
  }

  if (draft === undefined) return <div data-foreman-node-page="loading">{t('loading')}</div>
  const address = addressPreview(draft)
  const missing = emptyFields(draft, keepsToken)
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
          onChange={event => patchSsh({ port: Number(event.target.value) || DEFAULT_SSH.port })} /></label>
        <label>{t('user')}<input data-node-user value={draft.ssh.user} disabled={!editable}
          onChange={event => patchSsh({ user: event.target.value })} /></label>
        <label>{t('remotePort')}<input type="number" data-node-remote-port value={draft.ssh.remotePort} disabled={!editable}
          onChange={event => patchSsh({ remotePort: Number(event.target.value) || DEFAULT_SSH.remotePort })} /></label>
        <label>{t('localPort')}<input type="number" data-node-local-port value={draft.ssh.localPort} disabled={!editable}
          onChange={event => patchSsh({ localPort: Number(event.target.value) || DEFAULT_SSH.localPort })} /></label>
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
        autoComplete="new-password" placeholder={keepsToken ? t('tokenStored') : ''}
        onChange={event => patch({ token: event.target.value })} /></label>
      <p className="dt-hint">{keepsToken ? t('tokenKeep') : t('tokenHint')}</p>
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

/**
 * The page as DSH mounts it.
 *
 * The page itself is `DevicePage`; this is only the shell that hands it a translator. The settings section supplies
 * the form, which is why nothing here reads configuration.
 */
function Mounted({ t, form, initialKeys, keysFailed }: {
  t: (key: keyof typeof zh) => string
  form?: PageForm | undefined
  initialKeys?: readonly SshKey[]
  keysFailed?: boolean
}) {
  // The settings section is the only entry now, so there is no `view` to branch on: `summary` used to render nothing
  // for the plugin manager's row list, and that page no longer mounts this.
  return <DevicePage t={t} form={form} initialKeys={initialKeys} keysFailed={keysFailed} />
}

/** What the settings provider's `configForms` service offers this page. */
interface FormsFace {
  get(id: string): unknown
  whileServed(namespaces: readonly string[], register: () => () => void): () => void
}

/**
 * Registers the page in the settings panel.
 *
 * Two nested waits, both deliberate:
 *  - `ctx.inject(['configForms'], …)` rather than a module-level `inject`: a profile without ui-settings has no
 *    settings panel, and declaring the service would park the whole package waiting for something that profile never
 *    provides. A headless device must still take work.
 *  - `whileServed` rather than an immediate registration: the Host publishes configuration namespaces as it composes
 *    them, so a page mounted before `dsh-foreman-node` appears in that list would render against nothing.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-foreman-node: dictionaries')
  const t = ctx.locale.bind(NS) as unknown as (key: keyof typeof zh) => string
  ctx.inject(['configForms'], child => {
    const forms = (child as unknown as { configForms?: Partial<FormsFace> }).configForms
    if (forms?.get === undefined || forms.whileServed === undefined) return
    const form = forms.get(ENTRY_ID) as PageForm & { subscribe(listener: () => void): () => void }
    ctx.effect(() => forms.whileServed!([ENTRY_ID], () => child.slots.inject('settings.section', () =>
      child.slots.register({ name: 'settings.section', id: ENTRY_ID, order: ENTRY_ORDER, label: () => t('nav'),
        locale: NS }, () => <Mounted t={t} form={form as never} />))), 'dsh-foreman-node: settings page')
  })
}

export { DevicePage }
