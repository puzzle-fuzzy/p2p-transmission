# P2P Transmission API

该服务负责临时访客、短期房间、WebRTC 信令，以及按房间生命周期签发 TURN 短期
凭据。它不会存储或中继文本正文与文件内容；传输载荷始终留在 WebRTC DataChannel。

## 本地开发

```bash
bun install --frozen-lockfile
cp services/api/.env.example services/api/.env
bun run --cwd services/api dev
```

默认监听 `PORT=3000`。未设置 `TURN_URLS` 和 `TURN_SHARED_SECRET` 时，服务仍可在
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

生产 TURN 服务器的密钥生成、TLS、端口和 Compose 操作见
[`deploy/coturn/README.md`](../../deploy/coturn/README.md)。

## HTTP 会话

1. `POST /v1/visitors` 创建临时访客并返回 Bearer token。
2. `POST /v1/rooms` 创建房间；`POST /v1/rooms/:code/join` 加入房间。
3. 创建/加入请求声明 ICE 模式，响应原子返回房间状态以及该会话所需的 ICE 配置；
   API 模式下还会返回不晚于房间生命周期使用的短期 TURN 凭据。
4. 浏览器连接 `/v1/realtime?token=...` 后发送 `room:attach`，只附着已由 HTTP 创建的
   成员关系，不能通过 WebSocket 新建成员。

所有 offer、answer 和 ICE frame 在转发前都会校验房间、角色、在线附着状态与目标。
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

访客、房间、连接和限流状态目前保存在单进程内存中，因此 API 只能运行一个实例。
服务有显式容量、TTL 和速率限制，但 TURN 仍可能产生显著带宽成本；生产环境应同时
监控 API 容量和 coturn 分配、吞吐及费用。
