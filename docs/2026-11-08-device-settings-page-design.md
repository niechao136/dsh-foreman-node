# 设备配置页搬进设置 — 设计

日期：2026-11-08
状态：待批准

## 想要什么

`dsh-foreman-node` 的配置页现在只在「插件 → dsh-foreman-node → 详情」里。要配一次设备，
得先想到去插件列表里翻。希望它像 `dsh-config-manager` 那样，在设置面板左侧导航里有一格
「设备连接」，点进去就是这个页面。

## 现在是什么样

设备页注册在 `plugins.row.config` 槽位，key 是 `dsh-foreman-node#dsh-foreman-node`
（包名 # patch 行 id）。插件管理页在渲染单行详情时把配置表单从 `configForms.get(entryId)`
取出来，作为 `form` prop 递进来；我们的页面收到后渲染自己的一套输入框，保存时调
`form.mutate(editsOf(draft), revision)`。

写入路径不变：表单服务 → `remote.settings` → 宿主的 `SettingsForms.write` →
`ConfigEditor.edit` → 写 `cordis.patch.yml`。这条链和页面挂在哪无关。

## 目标

- 设置面板左侧多一格「设备连接」，点进去就是现在这个页面。
- 插件详情里不再出现自定义配置页，避免同一 namespace 有两处入口。
- 设备没有 Web 界面（CLI/headless）时，一切照旧：页面不出现，设备照常接活。

## 非目标

- 不把 profile 的依赖指向本地 checkout（用户 2026-11-08 明确不做）。
- 不改协议、不改 tunnel、不改 job 会话。
- 不做多设备管理页面。一个设备页只管这一台。

## 约束（查证过的）

1. **patch 行 id 不能改。** `configForms.get(entryId)` 的 `entryId` 就是 patch 里那行的
   `id`。现在 `cordis.patch.yml` 里写的是 `- id: dsh-foreman-node`，页面要按这个名字取表单。
   改名会让页面拿到一个永远 `loading` 的空表单。

2. **`configForms` 来自 `@deepseek-ai/dsh-client-ui-settings`。** 它不在 `inject` 里硬声明，
   否则没有这个插件的 profile 整个包都装不起来 —— `dsh-fonttune` 的注释里记着这个教训
   （声明一个宿主不提供的服务会让整个包停摆）。改用 `ctx.inject(['configForms'], …)`，
   这是可选注入，服务不在就不跑回调。

3. **`whileServed` 用来等 namespace 出现。** `configForms.whileServed(['dsh-foreman-node'],
   register)` 在设置描述镜像里出现这个 namespace 时调 `register`，消失时调 disposer。
   直接用 `configForms.get()` 拿到的是一个可能还没被宿主广播过的控制器。

4. **`settings.section` 的 owner props 是 `{ close }`。** 页面不需要它 —— 关闭按钮是设置
   外壳自己的 —— 但注册签名要求组件能接住这个 prop。

5. **插件详情那边没有「通用表单」兜底。** 翻过 `dsh-client-ui-plugin-manager` 的
   `lib/client.js`（438 KB，从 `app.asar` 解出来看的）：`RowDetail` 只用
   `renderSlot("plugins.row.config", { view: 'page', form })` 渲染自定义页，没有任何
   schema 驱动的自动表单。所以撤掉注册后，插件详情里那一行会只剩标题和开关，没有配置项。
   这是可接受的：配置的唯一入口在设置里，页面上会写清楚去哪里。

6. **`settings.section.icon` 是可选的。** 设置外壳在导航项里渲染
   `renderSlot("settings.section.icon", …, { only: row.id, fallback: navIcon(row.id) })`，
   没注册就用默认图标。第一版先不注册图标。

## 怎么做

### 页面

`src/client/index.tsx` 拆成两半：

- `DevicePage`（现在这个组件）保留，只改一件事：它不再从 prop 收 `form`，改成一个
  `form` 值可以是 `undefined` 的组件 —— 表单还在 `loading` 时显示「读取配置…」。
- 新的注册面：`apply` 里 `ctx.inject(['configForms'], …)`，回调里
  `configForms.whileServed([ENTRY_ID], () => ctx.slots.inject('settings.section', () =>
  ctx.slots.register({ name: 'settings.section', id: ENTRY_ID, order: 55,
  label: () => t('nav'), locale: NS }, Section)))`。

`Section` 是一个小组件：用 `useSyncExternalStore` 订阅那个 `ConfigForm` 控制器，
把 `getSnapshot()` 包成页面现在认识的 `{ state, mutate }` 形状，然后渲染 `DevicePage`。

- `ENTRY_ID = 'dsh-foreman-node'`，写成常量并加注释说明它必须和 patch 行 id 一致。

### 顺序

`order: 55`：`dsh-config-manager` 是 60，内置的「插件」是 15。放 55 让它排在外置工具
附近，不跟内置项混在一起。

### 语言

`locales.ts` 加一个键 `nav: '设备连接'`（en: `Device connection`），给导航项用。
已有的 `title` 保持不动，作为页面正文的标题。

### 测试

- `tests/panel.spec.ts`：现有的 8 条全部保留，`render` 辅助函数改成构造 `{ state, mutate }`
  而不是直接塞 `form`。
- 新增一条：注册面在没有 `configForms` 时（`ctx.inject` 的回调不跑）不注册任何槽位。
- 新增一条：`ENTRY_ID` 与 `cordis.patch.yml` 里那行的 `id` 一致 —— 读文件比对，
  因为这条不一致只会在真机上表现为「页面永远是空的」。
- `tests/bundle.spec.ts` 不变，但要重新跑：新增的 `useSyncExternalStore` 来自 react，
  不允许拖进别的 require。

## 风险

- **`ctx.slots.inject` 嵌套在 `ctx.inject` 里。** `dsh-context` 就是这种写法（设置页里
  的 `configForms` 用法同款），所以形态是有的；但两个 inject 的时序我只在它身上看到过，
  真机要验一次。
- **`whileServed` 的 disposer。** 宿主不再提供这个 namespace 时页面应当消失。这条在真机上
  很难构造，靠单测覆盖回调时机，真机只验「有 namespace 时出现」。
- **撤掉 `plugins.row.config` 后插件详情变空。** 用户可能以为配置丢了。页面正文和
  locale 里要有一句话指向设置。
