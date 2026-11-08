# 设备配置页搬进设置 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 dsh-foreman-node 的配置页从「插件详情」搬成设置面板里的独立一格「设备连接」。

**Architecture:** 页面组件 `DevicePage` 基本不动，只把它的数据来源从 prop 传入的 `form` 改成自己从 `configForms` 服务订阅一个 `ConfigForm` 控制器。注册面从 `plugins.row.config` 换成 `settings.section`。三个宿主 API 参与：`ctx.inject`（可选服务注入）、`configForms.whileServed`（等 namespace 出现）、`ctx.slots.register`（注册设置页）。

**Tech Stack:** TypeScript、React 18、cordis、@deepseek-ai/dsh-client-ui-settings、@deepseek-ai/dsh-client-ui-slots、vitest、tsdown。

**Spec:** `docs/2026-11-08-device-settings-page-design.md`

## Global Constraints

- patch 行 id 必须是 `dsh-foreman-node`，不可改名（`configForms.get(entryId)` 按它取表单）。
- `configForms` 只能经 `ctx.inject(['configForms'], …)` 可选注入，**不得**写进模块级 `export const inject`（声明宿主不提供的服务会让整个包装不起来）。
- 浏览器 bundle 只允许 `require('react')` 和 `require('react/jsx-runtime')`；禁止任何 `node:*` 说明符（`tests/bundle.spec.ts` 已盯住）。
- 页面注册在 `settings.section`，`id: 'dsh-foreman-node'`、`order: 55`、`locale: NS`。
- 提交信息用英文祈使句，与仓库既有风格一致。

## Review Focus

- **配置 namespace 还没被宿主广播时打开设置页**：应显示「读取配置…」，而不是崩掉或显示空表单。
- **宿主不提供 `configForms`（无 ui-settings 的 profile）**：整页不注册，插件详情里也不出现；设备照常接活。
- **撤掉 `plugins.row.config` 后打开插件详情**：那一行只剩标题和开关，不能报错，且设置里有唯一入口。
- **`editsOf` 只写页面持有的字段**：保存必须不抹掉已存令牌（0.2.3 修过的回归）。
- **写入被宿主拒绝（只读 profile）**：页面显示 `readOnly` 文案，不显示保存按钮。

---

### Task 1: 抽出常量与订阅组件

**Files:**
- Create: `src/client/entry.ts`
- Create: `src/client/section.tsx`
- Test: `tests/section.spec.tsx`

**Interfaces:**
- Consumes: 无（第一个任务）。
- Produces:
  - `export const ENTRY_ID = 'dsh-foreman-node'`（`src/client/entry.ts`）
  - `export const ENTRY_ORDER = 55`（同上）
  - `export interface PageForm { state: ConfigFormSnapshot<Record<string, unknown>>; mutate: ConfigForm<Record<string, unknown>>['mutate'] }`（`src/client/section.tsx`）
  - `export function assertEntryId(patchText: string): string | undefined` —— 返回 patch 里那行的 id，找不到返回 undefined（`src/client/entry.ts`）
  - `export function Section(props: { form: { getSnapshot(): ConfigFormSnapshot<Record<string, unknown>>; subscribe(fn: () => void): () => void; mutate: ConfigForm<Record<string, unknown>>['mutate'] }; t: (key: keyof typeof zh) => string; initialKeys?: readonly SshKey[]; keysFailed?: boolean }): JSX.Element`（`src/client/section.tsx`）

说明：这一任务先把「取快照 → 渲染 DevicePage」这一层单独做出来并测通，不碰注册，也不碰 `index.tsx`。`DevicePage` 此时还不接受这个新形状，所以 `Section` 先渲染一个占位（`data-section-pending`），Task 2 再接上。

- [ ] **Step 1: Write the failing test**

```tsx
// tests/section.spec.tsx
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { ENTRY_ID, ENTRY_ORDER, assertEntryId } from '../src/client/entry.ts'
import { Section } from '../src/client/section.tsx'
import { zh } from '../src/client/locales.ts'

const t = (key: keyof typeof zh): string => zh[key]

it('names the settings entry after the patch row it configures', () => {
  expect(ENTRY_ID).toBe('dsh-foreman-node')
  expect(ENTRY_ORDER).toBe(55)
})

it('finds the patch row id, and says so when the row is missing', () => {
  expect(assertEntryId('- insert:\n    - id: dsh-foreman-node\n      name: x\n')).toBe('dsh-foreman-node')
  expect(assertEntryId('- insert:\n    - id: something-else\n')).toBeUndefined()
})

it('renders a placeholder until the page itself is wired in', () => {
  const form = { getSnapshot: () => ({ status: 'loading' as const }), subscribe: () => () => {}, mutate: async () => true }
  const markup = renderToStaticMarkup(createElement(Section, { form, t } as never))
  expect(markup).toContain('data-section-pending')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/section.spec.tsx`
Expected: FAIL — `Cannot find module '../src/client/entry.ts'`

- [ ] **Step 3: Implement the two modules**

`src/client/entry.ts`：`ENTRY_ID`/`ENTRY_ORDER` 两个常量，`assertEntryId` 用正则 `/- id: ([A-Za-z0-9_-]+)/` 在文本上找第一处匹配并取捕获组；找不到返回 `undefined`。

`src/client/section.tsx`：`Section` 用 `useSyncExternalStore(form.subscribe, form.getSnapshot)` 取当前快照，渲染 `<div data-section-pending>{t('loading')}</div>`。导入 `zh` 仅为 `t` 的类型。

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/section.spec.tsx`
Expected: PASS（3 条）

- [ ] **Step 5: Commit**

```bash
git add src/client/entry.ts src/client/section.tsx tests/section.spec.tsx
git commit -m "feat: name the settings entry and subscribe to its form"
```

---

### Task 2: DevicePage 接受表单快照而不是 prop

**Files:**
- Modify: `src/client/index.tsx:1-40`（imports 与 `DevicePage` 签名）
- Modify: `src/client/section.tsx`（把占位换成真实渲染）
- Modify: `tests/panel.spec.ts`（`render` 辅助函数与新签名对齐）
- Test: `tests/panel.spec.ts`

**Interfaces:**
- Consumes: `PageForm`（Task 1）、`ENTRY_ID`（Task 1）。
- Produces: `DevicePage({ t, form, initialKeys, keysFailed })`，其中 `form: PageForm | undefined`——`undefined` 表示宿主还没把 namespace 广播出来，页面渲染 `t('loading')`。

- [ ] **Step 1: Write the failing test**

在 `tests/panel.spec.ts` 里把 `form` 辅助函数换成返回 `PageForm` 形状，并加一条：

```ts
it('waits instead of showing an empty form while the host has not published the entry', () => {
  const markup = renderToStaticMarkup(createElement(DevicePage, { t, form: undefined } as never))
  expect(markup).toContain(zh.loading)
  expect(markup).not.toContain('data-node-save')
})
```

同时把既有 `form()` 辅助改成：

```ts
const form = (value: NodeConfig, writable = true) => ({
  state: { status: 'ready' as const, value, base: undefined, user: undefined, revision: 1, writable, mode: 'host' as const },
  mutate: async () => true })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/panel.spec.ts`
Expected: FAIL — 页面把 `undefined` 当成「未配置」并渲染 `missing`，新用例在 `expect(markup).toContain(zh.loading)` 处失败

- [ ] **Step 3: Change `DevicePage` to take `PageForm | undefined`**

`src/client/index.tsx`：`saved` 的取值改为 `form === undefined ? undefined : form.state.value === undefined ? undefined : configured(form.state.value)`；把「draft 为 undefined 就显示 loading」的判断提前到 `form === undefined` 也成立。`ConfigPageForm` 的 import 换成从 `./section.tsx` 引 `PageForm`。

**`Mounted` 和 `apply` 这一任务不要动。** 它们还在注册 `plugins.row.config`，而 `Mounted` 现在传给 `DevicePage` 的 `form` 是 `ConfigPageForm`——签名改成 `PageForm | undefined` 之后这处仍然赋值兼容（`ConfigPageForm` 的两个成员 `state`/`mutate` 与 `PageForm` 同形），所以整个包照样编译、照样跑。注册面的切换和 `Mounted` 的删除留给 Task 3，这样每个任务结束时都是可编译、可运行的。

`src/client/section.tsx`：`Section` 改为渲染 `<DevicePage t={t} form={{ state: snapshot, mutate: form.mutate }} initialKeys={...} keysFailed={...} />`。

同时把 Task 1 写的那条占位断言换掉——它描述的中间状态到这一步已经不存在了：

```ts
it('renders the configuration page once the host publishes a section', () => {
  const form = { getSnapshot: () => ({ status: 'ready' as const, value: {}, writable: true, revision: 1 }),
    subscribe: () => () => {}, mutate: async () => true }
  const markup = renderToStaticMarkup(createElement(Section, { form, t } as never))
  expect(markup).toContain('data-foreman-node-page="ready"')
})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/panel.spec.ts tests/section.spec.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/client/index.tsx src/client/section.tsx tests/panel.spec.ts
git commit -m "refactor: let the device page take its form snapshot directly"
```

---

### Task 3: 把注册面换到 settings.section

**Files:**
- Modify: `src/client/index.tsx`（`apply` 函数）
- Modify: `src/client/locales.ts`（加 `nav` 键）
- Test: `tests/registration.spec.ts`

**Interfaces:**
- Consumes: `ENTRY_ID`、`ENTRY_ORDER`、`Section`（Task 1–2）。
- Produces: `apply(ctx)` 在 `configForms` 可用时注册 `settings.section`；不可用时什么都不注册。

- [ ] **Step 1: Write the failing test**

```ts
// tests/registration.spec.ts
import { expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.tsx'

/** A context that records what the page registered and which services it injected. */
function fakeContext(services: string[]) {
  const registered: string[] = []
  const injected: string[][] = []
  const ctx = {
    effect: (fn: () => unknown) => { const off = fn(); return typeof off === 'function' ? off : () => {} },
    locale: { register: () => () => {}, bind: () => () => '' },
    slots: {
      inject: (name: string, run: () => unknown) => { registered.push(name); run() },
      register: (options: { name: string }) => { registered.push(options.name); return () => {} },
    },
    inject: (deps: string[], run: (child: unknown) => void) => {
      injected.push(deps)
      if (deps.every(dep => services.includes(dep))) run(ctx)
    },
  }
  return { ctx, registered, injected }
}

it('registers a settings page when the host offers configForms', () => {
  const { ctx, registered } = fakeContext(['configForms'])
  apply(ctx as never)
  expect(registered).toContain('settings.section')
})

it('registers nothing when configForms is absent, so a headless device still boots', () => {
  const { ctx, registered, injected } = fakeContext([])
  apply(ctx as never)
  expect(registered).not.toContain('settings.section')
  expect(injected).toContainEqual(['configForms'])
})

it('no longer registers a page inside the plugin manager', () => {
  const { ctx, registered } = fakeContext(['configForms'])
  apply(ctx as never)
  expect(registered).not.toContain('plugins.row.config')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/registration.spec.ts`
Expected: FAIL — 现在 `apply` 注册 `plugins.row.config`，第一条和第三条都不通过

- [ ] **Step 3: Rewrite `apply`**

```ts
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-foreman-node: dictionaries')
  const t = ctx.locale.bind(NS) as unknown as (key: keyof typeof zh) => string
  // `configForms` is optional on purpose: a profile without ui-settings has no settings panel, and declaring it in
  // the module-level `inject` would park the whole package waiting for a service that profile never provides.
  ctx.inject(['configForms'], child => {
    const forms = (child as unknown as { configForms?: { get?: (id: string) => unknown; whileServed?: Function } }).configForms
    if (forms?.whileServed === undefined || forms.get === undefined) return
    const form = forms.get(ENTRY_ID)
    // The page may not mount before the Host has published this namespace; `whileServed` registers the section only
    // once it has, and removes it again if the entry goes away.
    child.effect(() => forms.whileServed!([ENTRY_ID], () => child.slots.inject('settings.section', () => child.slots.register({
      name: 'settings.section', id: ENTRY_ID, order: ENTRY_ORDER, label: () => t('nav'), locale: NS },
    () => <Section form={form as never} t={t} />))), 'dsh-foreman-node: settings page')
  })
}
```

`locales.ts` 两个字典各加一行：`nav: '设备连接'` / `nav: 'Device connection'`。

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/registration.spec.ts tests/section.spec.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/client/index.tsx src/client/locales.ts tests/registration.spec.ts
git commit -m "feat: move the device page into the settings panel"
```

---

### Task 4: 盯住 patch 行 id 与 bundle 纯净性

**Files:**
- Modify: `tests/bundle.spec.ts:1-20`
- Test: `tests/bundle.spec.ts`

**Interfaces:**
- Consumes: `ENTRY_ID`、`assertEntryId`（Task 1）。
- Produces: 无新导出。

- [ ] **Step 1: Write the failing test**

```ts
it('keeps the settings entry named after the row the profile actually declares', () => {
  // A mismatch here has no compile-time symptom: the page would simply stay on "reading configuration" forever.
  const patch = readFileSync(join(import.meta.dirname, '..', 'cordis.patch.yml'), 'utf8')
  expect(assertEntryId(patch)).toBe(ENTRY_ID)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/bundle.spec.ts`
Expected: FAIL — `assertEntryId` 尚未 import（此步先只加 import 到文件顶部使其进入解析，断言先让它红）

- [ ] **Step 3: Add the import and confirm the shape of the bundle**

`tests/bundle.spec.ts` 顶部加 `import { ENTRY_ID, assertEntryId } from '../src/client/entry.ts'`。既有三条约束（只 require react、loader 包装、无 node: 模块）保留不动。

- [ ] **Step 4: Run the whole device suite**

Run: `pnpm check`
Expected: typecheck 通过，全部测试 PASS，build 产出 `lib/client.js`

- [ ] **Step 5: Commit**

```bash
git add tests/bundle.spec.ts
git commit -m "test: pin the settings entry id to the patch row"
```

---

### Task 5: 文档与版本

**Files:**
- Modify: `CHANGELOG.md:1`
- Modify: `README.md`（配置页位置那句）
- Modify: `package.json:3`

**Interfaces:**
- Consumes: 无。
- Produces: 无。

- [ ] **Step 1: 写 CHANGELOG**

顶部加一节 `## 0.3.0 — 2026-11-08`，三句话：配置页搬到「设置 › 设备连接」；插件详情不再提供自定义配置页，改在设置里配置；没有 Web 界面时页面不出现，设备行为不变。

- [ ] **Step 2: 改 README 里描述页面位置的那一段**

把「插件 → dsh-foreman-node → 详情」改成「设置 → 设备连接」。

- [ ] **Step 3: 版本号 0.2.3 → 0.3.0**

`package.json` 的 `version` 改为 `0.3.0`（页面入口位置是行为变化，按次版本走）。

- [ ] **Step 4: 全量验证**

Run: `pnpm check`
Expected: typecheck + 全部测试 + build 通过

- [ ] **Step 5: 同步枢纽的版本锁定**

`F:\dsh\dsh-foreman\package.json` 里 `dsh-foreman-node` 的版本固定值现在是 `0.2.2`（已经落后一个版本），改成 `0.3.0`，在枢纽仓库里单独提交。枢纽靠这个字段决定装哪个设备端，不跟上会让两边版本对不上。

- [ ] **Step 6: Commit**

```bash
git add CHANGELOG.md README.md package.json
git commit -m "chore: release 0.3.0 with the settings page"
```

---

### Task 6: 真机验证

**Files:**
- 无代码改动。

**Interfaces:**
- Consumes: 已发布的 0.3.0。
- Produces: 一份观察记录，写进 `CHANGELOG.md` 该版本「验证」小节。

- [ ] **Step 1: 装到本机 profile**

发布 0.3.0（先 npm，等 registry 可见），把 `~/.dsh/profiles/desktop/package.json` 里 `dsh-foreman-node` 改成 `0.3.0`，`dsh plugin install` 后按 unlag 的刷新按钮。

- [ ] **Step 2: 看设置面板**

打开 设置 → 左侧应有「设备连接」，点进去显示密钥下拉、SSH 段、枢纽段、项目路径段，且字段值是已保存的那份（`deviceId: pc`、隧道开、`F:\dsh` 两行）。

- [ ] **Step 3: 看插件详情**

插件 → dsh-foreman-node → 详情：不应有配置输入框，不应报错。

- [ ] **Step 4: 验一次保存**

改一个无关紧要的字段（例如把 `localPort` 从 8790 改成 8791）→ 保存 → 看 `~/.dsh/profiles/desktop/cordis.patch.yml` 里那行确实变了，**且 `token` 仍在**。改回 8790 再保存一次。

- [ ] **Step 5: 记录**

把观察写进 CHANGELOG 0.3.0 小节，`git commit -m "docs: record what the settings page did on a real profile"`。
