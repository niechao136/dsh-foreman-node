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

## 配置

装进 profile 后会多出「设置 › 设备连接」一个配置页：从这台机器的 `~/.ssh` 里
挑一把密钥、填枢纽机器与用户、点「测试连接」、把枢纽上登记设备时给出的 `deviceId` 和 `token` 填进来，
再填项目名到本机路径的对应关系。保存后重启 DSH 生效。

插件详情里不再单独提供配置页——配置只有这一个入口。

「默认对话策略」是下拉框，选项来自这台机器自己的权限服务（`permissionPresets.catalog()`），
不是手填的名字：填错只会在任务派下来时才发现，而那时 `session.ts` 只会警告一句、退回
`workspace-write`。保存过但当前不认识的预设名不会被清空，页面会标出来。

隧道由插件自己拉起（`ssh -N -L`，断了自动重连），不需要再手开 `ssh -L`。

也可以直接写 profile 的 `cordis.patch.yml`：

```yaml
- id: dsh-foreman-node
  config:
    url: wss://foreman.example.com   # 隧道开着时不参与连接
    deviceId: laptop
    token: <枢纽登记设备时给出的令牌>
    roots:
      - project: shop
        path: 'D:\工作\shop'
    ssh:
      enabled: true
      host: 203.0.113.10
      port: 22
      user: ubuntu
      keyPath: /home/me/.ssh/id_ed25519
```

不支持密码登录（自动重连的前提是 `BatchMode=yes`），也不支持带口令的私钥——请放进 ssh-agent。

## 状态

**早期开发中。** 协议、连接、接单与回报工具都已落地并有测试（15 项）。

## 装上去

```yaml
# 本机 profile 的 cordis.patch.yml
- id: dsh-foreman-node
  config:
    url: wss://foreman.example.com     # 主 loop 的稳定域名（隧道后面）
    deviceId: laptop                   # 主 loop 上 scripts/add-device.mjs 登记的那个 id
    token: <登记时打印的那一枚>
    roots:
      - project: shop
        path: 'D:\工作\shop'            # 本机自己的绝对路径，原样写
```

重启本机的 DSH 即可。主 loop 不用重启——设备表在主 loop 的数据库里，不在它的插件配置里。

## 接单时发生什么

1. 收到 `assign` → 在帧里给的目录建（或复用）会话 `job-<assignmentId>`。
2. 任务文本作为一条用户消息投进去，`requestId` 幂等：重投不会产生第二条。
3. 会话挂上 `foreman_report` 工具，模型用它报 `progress` / `ready` / `blocked` / `failed`。
4. 每次投递成功回一帧 `accepted`，主 loop 才把这张 assignment 记为 started。

**权限是 `workspace-write`**，不是主 loop 自己用的 `danger-full-access`：笔记本前没人，弹审批等于卡死。
需要越界时设备不弹窗，而是报 `blocked`，由人决定放宽 root 还是换设备。

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
