# Changelog

本包是 [`dsh-foreman`](https://www.npmjs.com/package/dsh-foreman) 的设备侧，单独发版，
但**协议与 hub 版本绑定**：两侧协议版本不一致时，握手就拒绝并给出可读原因。

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
