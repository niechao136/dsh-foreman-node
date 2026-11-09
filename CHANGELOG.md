## 0.5.0 — 2026-11-10

### 改为：默认对话策略从填空变成下拉

`jobPreset` 原来是自由输入框，只有任务真的派下来才会发现名字打错了：`session.ts` 警告一句、回退到
`workspace-write`，于是页面说的和机器实际做的不是一回事。现在选项来自这台机器自己的权限服务：

- 新增 `GET /foreman-node/api/presets`，回答 `{ options, defaultPreset, source }`，`options` 的每一行就是
  `permissionPresets.catalog()` 里的 `PresetOption`（`value` / `name` / `description`），原样给页面用。
- 读不到目录（没有该服务、服务抛错、目录为空）时回退到内置的三条 `read-only` / `workspace-write` /
  `danger-full-access`，`source: 'built-in'`。少一个选择，好过一个永远加载不出来的下拉框。
- 保存过、但当前目录里没有的预设名**不会被清空**：它仍然选中，页面加一行说明「这台机器不认识它，任务会退回
  `workspace-write`」。空值仍然是「不改动这个字段」，`editsOf` 照样跳过它。
- `src/presets.ts` 是主机和页面共用的一份定义，不 import 任何 `node:*`，所以浏览器包不因此多一个依赖。

### 优化：配置面板样式

`src/client/client.css` 随浏览器包一起走 `?raw` 进 `<style>`，用 DSH 的 `--dsw-alias-*` 令牌经 `--dtn-*`
尺度定义，一条规则一行：

类和令牌都带 `dtn-` 前缀、令牌挂在页面元素上而不是 `:root`：这个 section 挂进的是每个插件都在打样的
同一个文档，`dt-*` / `:root --dt-*` 已被枢纽占用，撞名会把枢纽的宽度量到这边来。

- 页面有固定阅读宽度、按区块分卡片；SSH 的五个短字段在宽的地方排一行（`auto-fit` 网格，窄了自动落回一列）。
- 输入框、下拉框、按钮统一 32px 高、`--dtn-radius-sm` 圆角、聚焦时用 `--dtn-focus` 描边。
- 提示文字（`.dtn-hint`）降为 13px 三级文字；测试结果、端口占用、keepalive 缺失这类「有事要说」的提示改成
  带背景的 `.dtn-note`，错误用 `--dsw-alias-state-error-primary`，警告用 `state-warn`。
- 地址用等宽字体，方便和终端里的对一眼。

`tsdown.config.ts` 增加了 `?raw` 插件（照搬枢纽那份），`src/client/css.d.ts` 补了类型声明。

### 测试

`tests/presets.spec.ts` 覆盖选项合并与未知值保留；`tests/routes.spec.ts` 覆盖新路由的正常、无服务、抛错三条路径；
`tests/panel.spec.ts` 改为断言下拉框而不是输入框，并覆盖「保存值不在目录里」的提示。

## 0.4.0 — 2026-11-09

### 新增：把本机页面发布到枢纽

隧道让这台机器够到枢纽；这个功能反过来，在枢纽上开一个端口，转发回这台机器的 DSH 页面。

```
ssh -N -T -o BatchMode=yes -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
    -p <ssh.port> -i <ssh.keyPath> \
    -R 127.0.0.1:<expose.remotePort>:127.0.0.1:<本机 Web 端口> <ssh.user>@<ssh.host>
```

- 本机端口在**每次尝试时**从 `ctx.webServer.port` 读，不写进配置：那个端口是操作系统启动时分配的，写死会在重启后转发到一个没人监听的端口。
- 只绑 `127.0.0.1`，不依赖枢纽的 `GatewayPorts` 设置——枢纽的账本靠只监听 loopback 保护，这个页面不该成为那个口子。
- 反向转发在本地没有端口可探测，就绪判定改为「进程活了 `readyMs` 且 stderr 没报 `remote port forwarding failed`」。
- ssh 报这个错误时**不会退出**，所以 stderr 是流式读的：只靠 exit 事件会把「枢纽端口被占」报成正常工作。
- 失败与设备接单完全隔离：发布不了只是没有页面，任务照收。

### 新增：`expose` 配置块

```yaml
expose:
  enabled: false      # 默认关
  remotePort: 13100   # 用户自定义，不要用 8790（那是隧道端口）
```

全部字段 `.volatile()`，与 `ssh` 块同规则。

### 新增：配置页显示访问地址

两个地址，语义不同，页面上分开显示：

| 地址 | 端口 | 在哪里打得开 |
| --- | --- | --- |
| 本机打开 | `ctx.webServer.port` | 只在这台机器上 |
| 从枢纽打开 | `expose.remotePort` | 只在枢纽上 |

令牌来自 `ctx.inject(['connection'], …)` → `connection.authenticatedUrl(base)`，**不读日志、不读凭据文件、不自签 cookie**。没有 `connection` 服务时只显示端口并说明拿不到令牌，不打印一条会撞到登录墙的链接。

令牌每次启动重新生成（cookie 本身有效期 30 天），所以地址会随重启变化。

### 新增：端口占用检查按钮

「检查端口」通过一次 ssh 在枢纽上跑脚本，同时回答两件事：

- `PORT=busy|free|unknown`：`ss` → `netstat` → `lsof` 依次尝试，三个都没有就是 `unknown`，**不当成 free**。
- `CLIENTALIVE=<秒>`：先读 `sshd -T`（生效配置，覆盖 `Include`），读不到再读 `/etc/ssh/sshd_config`。

占用时提示换一个——换端口不是可选的优化：枢纽端口变了，之前保存的 cookie 绑定的 authority 也就失效了。

枢纽 `ClientAliveInterval` 为 0 时给出提示：断网后 sshd 不会主动断开那条死连接，发布的端口会一直占着，重连全部失败。**只提示，不改远端配置**——那个文件属于枢纽的管理员。

### 修复：保存后不重启就生效

以前 `apply()` 一路构造到底，`NodeClient` / `Tunnel` / `JobSessions` 都是构造时读一次配置，改完必须重启 DSH。

现在监听 `loader/volatile-update`：DSH 对「只有 volatile 值变了」的保存**不重启插件**，而是把新值提交进运行中的引用，再发这个事件。收到就停掉旧的一套、按新配置重新起一套。

- 会话不强制重建：`jobPreset` 的改动作用于之后新创建的会话。
- 首次保存（之前完全没配置）也会真的启动设备——这正是新装 profile 打开配置页的情形。

### 新增：配置页补「默认对话策略」

`jobPreset` 一直有 schema、有类型，但配置页从来没渲染过，只能手改 `cordis.patch.yml`。现在有栏位了，留空表示用默认的 `workspace-write`。

## 0.3.0 — 2026-11-08

### 配置页搬进设置

配置页以前只在「插件 → dsh-foreman-node → 详情」里，要配一次设备得先想到去插件列表里翻。
现在它是**设置 › 设备连接**，和备份迁移、内置插件并列。

插件详情里不再有自定义配置页——配置只有这一个入口，不会出现两个表单各自保存同一份配置的隐患。

### 说明

页面注册在 `settings.section`，靠宿主 `configForms` 服务拿配置表单。没有 Web 界面的 profile（CLI、
headless）装不出这一页，但设备照常接活——和以前"没有 webServer 就没有密钥列表"是同一类降级。

页面按 patch 行的 id（`dsh-foreman-node`）找配置，所以那一行的 id 不能改名；`tests/bundle.spec.ts`
会读真实的 `cordis.patch.yml` 比对。

## 0.2.3 — 2026-11-08

### 修复：预设名不存在时，任务直接起不来

配置里写了一个宿主机没有的权限预设名（`workspace-write-never-ask`），`permissionPresets.set` 抛错，
整个 `ensure` 失败——工单显示「未能启动」，真正的原因藏在三层之外。

现在：预设设置失败会**记录日志并用默认的 `workspace-write` 继续**。预设名是配置，配置可能写错，
而写错不该是工作做不成的理由。

### 说明

要「不弹审批」，直接用 DSH 内置的 `danger-full-access` 即可——它本来就是「完全权限 + 不询问」。
自定义预设表需要能定位到宿主的 entry id，那条路我试过但没生效，已放弃。

## 0.2.2 — 2026-11-08

### 新增：任务运行的权限预设可以配置了

以前设备上的 job 会话固定用 `workspace-write`。它把改动限制在声明的工作区里，但**越界时会弹审批**——
而那台机器前面没有人，弹审批等于让任务卡住。

现在可以在设备配置里指定 `jobPreset`：

```yaml
jobPreset: workspace-write-never-ask
```

推荐做法：在 DSH 里加一个 `workspace-write + never` 的预设，把它填在这里。**边界照旧限制在工作区内**，
只是不再停下来问人。

不填仍是 `workspace-write`（保持原有行为）。这个选择属于那台机器的操作者，因为风险落在他们的机器上。

## 0.2.1 — 2026-11-08

### 修复：任务跑完了，却没有回报给 hub

真机上一次派单：设备做了 30 步、37 次工具调用、写了 2808 字的完整答案，**一次都没调用 `foreman_report`**。
hub 因此一直停在 `running`，面板上那张工单永远不结束，人也收不到结果。

两个原因，都修了：

1. **任务文本里没有说要回报。** 设备收到的只有标题、请求原文和附件说明，模型自然当成普通任务，
   做完就结束。现在每张派单的末尾都有一段说明：`foreman_report` 是这个任务到达人的唯一途径，
   答在对话里不算完成。
2. **只靠模型自觉不可靠。** 加了一层兜底：一轮结束而还没有回报时，插件自动补一条 `ready`，
   摘要取会话里最后一段模型输出。工具被正确调用过就不会重复补。

兜底是真的兜底——任何一轮正常结束都会触发它，所以即使模型完全无视那段说明，任务也不会挂死。

### 加固

- 会话事件监听注册失败时（宿主不提供 `ctx.effect`），仍然会挂上回报工具：
  没有回报通道比“看不见轮次结束”严重得多。

## 0.2.0 — 2026-11-07

### 新增：配置页，设备绑定不用再碰命令行

以前绑定一台设备要动四样东西，全是手写：在服务器上跑注册脚本拿 token、改服务器的
`cordis.patch.yml`、改设备自己的 `cordis.patch.yml`、再手动开一条
`ssh -L 8790:127.0.0.1:8790` 隧道。最后那一步最要命——插件连不上时只表现为「离线」，
真正的原因是一条没人开的隧道。

现在这条隧道由设备自己开，配置也由设备自己的页面填：

- **「设置 › 插件 › dsh-foreman-node」多了一个配置页**：从这台机器 `~/.ssh` 里
  **列出密钥让你挑**、填主机/用户/端口、点「测试连接」看认证通不通、填项目路径，
  保存后重启 DSH 生效。
- **隧道由插件自己拉起**：`ssh -N -L`，断了按 1s→60s 退避重连。就绪判定是
  TCP 连本机端口，不看 ssh 的措辞。
- **两种失败会翻译成人话**：钥匙有口令（`Permission denied (publickey)`）会说
  「请改用 ssh-agent 或换一把无口令的钥匙」；本地端口被占会说
  「local port 8790 已经有人占了」，而不是把 ssh 原文丢给你。
- **配置页在没有配置时也能打开**：路由注册排在「缺配置就返回」之前。否则新装的
  设备打不开配置页，等于装完就卡死。
- **没有 Web 界面的 DSH 照常接单**：`webServer` 是可选注入，不是硬依赖。headless
  或 CLI 里的设备只是没有配置页，干活不受影响。

### 新增配置

`ssh` 一整块，全部有默认值，所以**旧的手写配置不会因为缺这一块而变 invalid**：

```yaml
ssh:
  enabled: false
  host: ''
  port: 22
  user: ''
  keyPath: ''
  remotePort: 8790
  localPort: 8790
```

`enabled: true` 时，`url` **不再参与连接**：设备拨的是 `ws://127.0.0.1:<localPort>`，
也就是隧道自己那一头。页面会把地址置灰并显示真正会用的那个。

### 不支持

- 密码登录：Windows 没有 `sshpass`，而且自动重连的前提是 `BatchMode=yes`。
- 带口令的私钥：请放进 ssh-agent。

## 0.1.1 — 2026-11-07

### 修复：装上去就把整个 profile 弄成「异常」

设备包一进 profile 的 `bundles`，它的 patch 就会插入 `dsh-foreman-node` 这一行，
而这一行**还没有任何 config**——`0.1.0` 的 schema 把 `url` / `deviceId` / `token` 都写成 `.required()`，
于是激活直接失败：

```
invalid config:
  - $.url missing required value (at url)
```

整个 profile 因此显示为异常，而不是「这个设备还没配好」。

现在这三项都有空字符串默认值，`apply` 在缺值时**干净地不激活**，只记一行说明缺哪几项、
去哪儿填，profile 保持健康。值填齐后才开始拨号。
只有空白的值也算缺——否则设备会一直拨一个空地址，看起来只是离线。

## 0.1.0 — 2026-11-07

首个公开发布。

### 新增：连出去

- `NodeClient`：主动 wss 连到主 loop 的稳定域名，断线指数退避重连（1 s 起，封顶 60 s）。
  方向是出站，所以公司 NAT 后面也能用。
- 每 15 s 一次心跳，报「我在跑几件」；`hello` 报完整的在跑 assignment id 列表，
  让主 loop 对齐而不是猜测。

### 新增：接单

- `JobSessions`：收到 `assign` 就在帧里给的**设备侧目录**建（或复用）会话
  `job-<assignmentId>`，把渲染好的任务文本投进去。会话出现在你自己的侧栏里，你能看、能插话。
- 会话权限固定为 **`workspace-write`**，不是 `danger-full-access`：笔记本前没人，
  弹审批等于卡死。需要越界时不弹窗，而是报 `blocked` 让人决定。
- 投递按 `requestId` 幂等：重投不会产生第二条消息。

### 新增：回报

- 每个 job 会话自动挂上 `foreman_report` 工具：`progress` / `ready` / `blocked` / `failed`，
  可选一句提问。工具调用直接转成 `report` 帧。
- **不向模型提供 `dropped`**：那是判断，设备没有判断权。想表达同样意思只能 `blocked`。
- 投递成功回一帧 `accepted`，主 loop 才把这张 assignment 记为 started。

### 协议

- 帧定义在 `src/protocol.ts`，**这是协议的唯一定义**，hub 依赖本包并从这里导入。
- 单帧上限 256 KiB，超限拒绝而不是截断；带副作用的帧带去重 id；帧里不传凭据。

### 依赖

- 运行时零第三方依赖。`@deepseek-ai/*` 是 `peerDependencies`，由装了本插件的 DSH 实例提供。
