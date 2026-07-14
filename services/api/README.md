# P2P Transmission API

该服务负责临时访客、短期房间、WebRTC 信令，以及按房间生命周期签发 TURN 短期
凭据。它不会存储或中继文本正文与文件内容；传输载荷始终留在 WebRTC DataChannel。

生产地址：[https://p2p.yxswy.com](https://p2p.yxswy.com)。普通用户不需要直接调用 API，
操作路径见[用户指南](../../docs/user-guide.md)；仓库总览见[根 README](../../README.md)，
腾讯云运行配置见[部署说明](../../deploy/README.md)。项目固定使用 Bun 1.3.14。

## 本地开发

```bash
bun install --frozen-lockfile
cp services/api/.env.example services/api/.env
bun run --cwd services/api dev
```

未设置 `PORT` 时默认监听 `PORT=3332`，适合本地开发并避开常见的 `3000` 端口冲突。
生产 Compose 会显式设置 `PORT=3000`。未设置 `TURN_URLS` 和 `TURN_SHARED_SECRET` 时，服务仍可在
STUN-only/off 模式下用于本地开发。

```bash
bun run --cwd services/api test
bun run --cwd services/api typecheck
bun run --cwd services/api lint
bun run --cwd services/api build
```

## 配置

- `STUN_URLS`：逗号分隔的 `stun:` URL。
- `TURN_URLS`：逗号分隔的 `turn:`/`turns:` URL；必须与共享密钥一起设置。
- `TURN_SHARED_SECRET`：至少 32 字节，只存在于 API/coturn 服务端环境。
- `TURN_CREDENTIAL_GRACE_SECONDS`：TURN 凭据晚于房间到期的宽限期，默认 300 秒。
- `CORS_ALLOWED_ORIGINS`：允许的 Web 源，逗号分隔，不支持通配符。
- `TRUST_PROXY`、`TRUSTED_PROXY_IPS`：仅在明确受信的反向代理后启用；后者必须列出
  直接可信代理 IP。
- `DATABASE_PATH`：SQLite 文件路径；本地测试默认 `:memory:`，生产使用持久化数据卷，
  例如 `/data/app.sqlite`。
- `REALTIME_TICKET_TTL_SECONDS`、`REALTIME_TICKET_MAX_PER_VISITOR`：实时连接 ticket
  的有效期和未消费容量。
- `REALTIME_MESSAGES_PER_SECOND`、`REALTIME_OUTBOUND_QUEUE_MAX_MESSAGES`、
  `REALTIME_OUTBOUND_QUEUE_MAX_BYTES`：逐连接信令速率和出站背压上限。

生产 TURN 服务器的密钥生成、TLS、端口和 Compose 操作见
[`deploy/coturn/README.md`](../../deploy/coturn/README.md)。

## HTTP 会话

1. `POST /v1/visitors` 创建临时访客并返回 Bearer token。
2. 发送者通过 `POST /v1/rooms` 创建房间。响应中的 6 位房间码只是房间标识；高熵
   `invite.token` 只交给发送者，并用于构造邀请链接，服务端仅保存它的摘要。
3. 接收者打开邀请链接并确认后，通过 `POST /v1/rooms/:code/join` 提交
   `{ iceMode, admission: { kind: "invite", inviteToken } }`。Web 只从同一标签页配套的
   visitor/room session 发起 `{ iceMode, admission: { kind: "recovery" } }`；API 要求该
   Bearer 对应的 visitor 已经是房间 receiver，恢复不得创建新身份。接口不接受调用方选择
   `role`，无邀请的房间码不能直接加入。
4. 仅输入房间码时，接收者通过 `POST /v1/rooms/:code/join-requests` 创建加入申请并轮询
   `GET /v1/rooms/:code/join-requests/:requestId`。发送者调用后缀为 `/decision` 的接口批准
   或拒绝；接收者仅在状态为 `approved` 后调用 `/finalize`。等待中的接收者可调用
   `/cancel`。重复创建和操作返回当前权威状态，便于安全恢复响应丢失。
5. 创建、邀请加入、既有接收者恢复和批准后的 `/finalize` 请求声明 ICE 模式，成功响应
   原子返回房间状态以及该会话所需的 ICE 配置；API 模式下还会返回不晚于房间生命周期
   使用的短期 TURN 凭据。pending 或尚未 finalize 的 approved 申请没有成员关系或 TURN。
6. 浏览器使用 visitor Bearer 调用 `POST /v1/realtime/tickets`，得到短时一次性 ticket，
   再连接 `/v1/realtime?ticket=...` 并发送 `room:attach`。ticket 不包含 visitor token，
   消费后立即失效；WebSocket 只附着已由 HTTP 创建的成员关系，不能新建成员。

所有 `/v1/*` 响应（包括 visitor bearer、校验和错误响应）均发送
`Cache-Control: no-store` 与 `Referrer-Policy: no-referrer`。请求解析与 schema 校验错误
使用固定、无请求值回显的响应。服务不提供公开的 `GET /v1/rooms/:code` 房间查询。

邀请 capability 只返回给发送者并用于构造 `#room=123456&invite=inv_...` 分享链接。
API 只保存邀请摘要；原始 token 不进入公共房间 DTO、WebSocket、TURN 用户名、错误文本
或日志。旧 `?room=123456` 仅代表手动申请入口，不能恢复邀请权限。

所有 offer、answer 和 ICE frame 在转发前都会校验房间、角色、在线附着状态与目标。
WebSocket 单帧上限为 512 KiB；房间码、目标/会话 ID、SDP 与 ICE 字段都有 schema 长度或
数值边界，非法消息只返回固定错误，不回显原始 frame。
意外断线只保留短暂恢复窗口；房间到期或发送者终止离开会关闭房间。

## TURN 配置生成

从 `.env.example` 创建未跟踪的 `.env`，设置真实的 `TURN_SHARED_SECRET`、realm、
公网 IP 和容器内 TLS 路径后运行：

```bash
bun run --cwd services/api turn:config
```

脚本复用经过测试的 coturn 渲染器，校验必填值和端口，并原子写入被 Git 忽略的
`deploy/coturn/.local/turnserver.conf`（Linux 权限 `0600`）。脚本不会在标准输出或
错误输出中打印密钥或配置正文。

## 部署限制

访客、房间、成员和入房申请会在业务变更后以 SQLite transaction 保存，并在 API 启动时
恢复；文本和文件内容不进入 SQLite。在线 WebSocket 连接表仍在单进程内，因此首发仍只
运行一个 API 实例；横向扩展需要共享状态、事件总线和连接路由。
服务有显式容量、TTL、逐连接信令速率和出站队列限制，但 TURN 仍可能产生显著带宽成本；
生产环境应同时监控 API 容量、SQLite 磁盘、coturn 分配、吞吐和费用。

虽然 ticket 是短时且一次性的，反向代理、WAF、APM 与访问日志仍不应记录完整 query string；
应用不得记录请求 URL、headers、body、SDP 或 ICE 内容。

安全加入协议必须与 Web 同步硬切部署。API 不提供旧 code-only join、公开
`GET /v1/rooms/:code` 或客户端选择 `role` 的兼容路径，也不能与旧协议双模运行。API
重启后 SQLite 会恢复仍在生命周期内的访客、房间和申请；已建立的 WebSocket 会断开，
浏览器会重新申请 ticket 并重连。旧页面必须重新载入，不能把旧 browser storage 迁移成
恢复或邀请凭证。当前生产只运行一个 API 实例；SQLite 不负责跨实例的在线 WebSocket 状态、
广播或连接路由。腾讯云单机 Compose、宿主机 Nginx 和数据备份见
[`deploy/README.md`](../../deploy/README.md)。

其他入口：

- [普通用户指南](../../docs/user-guide.md)
- [Web 前端说明](../../apps/web/README.md)
- [coturn 说明](../../deploy/coturn/README.md)
