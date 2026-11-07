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
