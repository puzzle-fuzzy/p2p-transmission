# P2P Transmission Web

React 前端负责临时访客、房间会话、WebRTC 协商，以及点对点文本和文件传输。
HTTP/WebSocket 服务只处理房间与信令；文本正文和文件二进制只通过 WebRTC
DataChannel 传输。一次文件批次最多 10 个文件、总计 100 MiB。

## 本地开发

在仓库根目录安装依赖并同时启动 API 与 Web：

```bash
bun install --frozen-lockfile
bun run dev
```

- Web：<http://localhost:5713>
- API：<http://localhost:3000>

也可以分别运行：

```bash
bun run --cwd services/api dev
bun run --cwd apps/web dev
```

复制 `.env.example` 为未跟踪的 `.env` 后再调整本地配置。Vite 环境变量会进入前端
构建产物，任何情况下都不要把 `TURN_SHARED_SECRET` 放在 Web 环境中。

## ICE/TURN 模式

`VITE_TURN_MODE` 支持：

- `off`：只使用 `VITE_STUN_URLS`，适合本地开发，但严格 NAT/企业网络可能无法直连。
- `api`：推荐的生产模式。创建/加入房间时由 API 原子返回短期 TURN 凭据。
- `static`：仅供受控开发或私有环境使用，需要同时配置 `VITE_TURN_URLS`、
  `VITE_TURN_USERNAME` 和 `VITE_TURN_CREDENTIAL`；这些值会进入浏览器构建。

`VITE_ICE_TRANSPORT_POLICY` 默认为 `all`。设置为 `relay` 会强制只走 TURN，主要用于
部署验收；没有可用 TURN 时连接会按预期失败。

生产配置示例：

```dotenv
VITE_API_URL=https://api.example.com
VITE_TURN_MODE=api
VITE_STUN_URLS=stun:stun.example.com:3478
VITE_ICE_TRANSPORT_POLICY=all
```

## TURN 中继验收

公网 coturn 就绪后，用 `VITE_TURN_MODE=api` 和
`VITE_ICE_TRANSPORT_POLICY=relay` 构建 Web，在两个隔离浏览器会话中创建/加入房间，
确认可以传输精确文本与文件。先验证 UDP；再阻断客户端 UDP，确认
`turns:...transport=tcp` 的 TLS/TCP 回退。最后检查 API 日志和前端产物均不包含
`TURN_SHARED_SECRET`。本地单元测试不能替代这项公网路径验收。

## 验证

```bash
bun run test
bun run typecheck
bun run lint
bun run build
```
