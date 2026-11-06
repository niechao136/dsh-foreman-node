# dsh-foreman-node

> **Not an official DeepSeek product.** 第三方项目，与 DeepSeek 官方无关。

**设备侧。** 装在每台要被主 loop 派活的机器上：公司笔记本、宿舍电脑、任何一台你愿意接单的机器。

它只做三件事：

1. **连出去**——主动 wss 连到主 loop 的稳定域名，断线指数退避重连。方向是出站，所以公司 NAT 后面也能用。
2. **接单**——收到 `assign` 就在指定目录建（或复用）一个 `job-<assignmentId>` 会话，把渲染好的任务文本投进去。这个会话出现在你自己的侧栏里，你能看、能插话。
3. **回报**——在 job 会话上注册 `foreman_report` 工具，`progress` / `ready` / `blocked` / `failed` 加可选提问，直接转成 `report` 帧发回去。

**它没有的**：工单、评估、决策、策略、数据库、SQLite。判断这件事该不该做，是主 loop 的事，不是设备的。

```
┌──────────── 主 loop（另一台机器）────────────┐
│  dsh-foreman：唯一账本、选设备、下发、收回报     │
└────────────────────┬─────────────────────────┘
                     │  设备主动外连（wss）
                     ▼
     ┌───────────────────────────────┐
     │  dsh-foreman-node（本机）      │
     │  job-<id> 会话，权限受限       │
     │  你自己的 DSH 一切照常         │
     └───────────────────────────────┘
```

## 状态

**早期开发中。** 协议已落地并有测试，连接、接单、回报工具还在实现中。

## 协议

帧定义在 [`src/protocol.ts`](src/protocol.ts)。**这个文件是该协议的唯一权威定义**：
主 loop 那个包 `dsh-foreman` 依赖本包并从 `dsh-foreman-node/protocol` 导入它，所以两侧
不可能漂移——这也是为什么协议放在设备侧而不是主 loop 侧：反过来会把整个领域内核装进每台笔记本。

约定：
- 一条 WebSocket 文本消息一个 JSON 帧，`v` 是协议版本，不同版本在握手时就拒绝。
- 单帧上限 256 KiB，超限拒绝而不是截断。
- 带副作用的帧带 `frameId`，接收方去重。
- `report` 的 `state` **不含 `dropped`**：那是判断，设备没有判断权。

## 由来

代码结构参考了 [dsh-superagent-local](https://github.com/mengzhongjie/dsh-superagent-local)
与 [dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)（均为 MIT，
Copyright (c) 2026 DeepSeek Harness Team）。架构思想来自 DeepSeek Harness 团队的
《Super-agent 设计探索》，本包对应其中「计算与执行环境分离」那一层。

## 许可

MIT，见 [LICENSE](LICENSE)。
