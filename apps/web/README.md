# P2P Transmission Web

React 前端负责临时访客、房间会话、WebRTC 协商，以及点对点文本和文件传输。
HTTP/WebSocket 服务只处理房间与信令；文本正文和文件二进制只通过 WebRTC
DataChannel 传输。一次文件批次最多 10 个文件、总计 100 MiB。

生产地址：[https://p2p.yxswy.com](https://p2p.yxswy.com)。普通用户操作见
[用户指南](../../docs/user-guide.md)，仓库级开发、验证和故障排查见
[根 README](../../README.md)，腾讯云运行配置见[部署说明](../../deploy/README.md)。

项目固定使用 Bun 1.3.14。前端是浏览器中的传输端：API 负责临时访客、房间、加入授权和
信令，文本与文件不经过 API 的应用载荷存储或中继路径；必要时浏览器会通过 coturn 中继
加密的 WebRTC 流量。

## 安全加入与分享

- 6 位房间码只是房间标识。仅输入房间码时，接收者发送加入申请，房主在弹窗中允许或
  拒绝；批准后接收者完成最终加入才获得成员关系。
- 房主分享的高熵邀请链接使用 `#room=123456&invite=inv_...`。接收者确认邀请后可以
  直接加入，因此链接只应发送给可信接收者。
- 页面启动后立即消费并清除 fragment。邀请 token 只保留在当前标签页内存中：房主保存
  当前房间的分享 capability，接收者保存当前加入意图；它不进入 local/session storage、
  公共房间状态、WebSocket、TURN 用户名、错误文本或日志。
- 接收者恢复只使用同一标签页已有的 visitor/room session，保持同一 visitor，且要求其
  已经是该房间的 receiver；恢复不会创建新身份。当前不支持发送者恢复。
- 旧 `?room=123456` 链接只预填手动申请。旧 `localStorage['p2p.roomSession']` 会被删除，
  不会作为恢复凭证继续使用。

## 本地开发

在仓库根目录安装依赖并同时启动 API 与 Web：

```bash
bun install --frozen-lockfile
bun run dev
```

- Web：<http://localhost:5713>
- API：<http://localhost:3332>

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
- `api`：推荐的生产模式。只有创建房间、邀请加入、既有接收者恢复，或批准申请的
  `/finalize` 成功后，API 才原子返回短期 TURN 凭据；pending 或尚未 finalize 的 approved
  申请没有成员关系，也不会获得 TURN。
- `static`：仅供受控开发或私有环境使用，需要同时配置 `VITE_TURN_URLS`、
  `VITE_TURN_USERNAME` 和 `VITE_TURN_CREDENTIAL`；这些值会进入浏览器构建，不能提供
  API 模式的逐房间授权保证，禁止用于公开生产部署。

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
`VITE_ICE_TRANSPORT_POLICY=relay` 构建 Web，在两个隔离浏览器会话中创建房间，并先用
安全邀请链接确认直接加入，再验证“仅输入房间码 → 房主批准 → finalize”的手动流程，
确认两条路径都可以传输精确文本与文件。先验证 UDP；再阻断客户端 UDP，确认
`turns:...transport=tcp` 的 TLS/TCP 回退。最后检查 API 日志和前端产物均不包含
`TURN_SHARED_SECRET`。本地单元测试不能替代这项公网路径验收。

## 部署兼容性

Web 与 API 必须按安全加入协议同步硬切部署。客户端不提供 code-only join、公开房间查询、
调用方选择 role 或失败后回退旧协议的兼容路径。API 重启后 SQLite 会恢复房间和申请，但在线
WebSocket 会断开并重新申请一次性 ticket；部署后
旧页面应重新载入，房主重新创建房间并生成新的安全邀请链接。Service Worker 不缓存页面、
动态构建产物或 `/v1/*` API，只缓存明确列出的公开静态资源，并会清除旧版页面缓存。

当前生产部署只有一个 API 实例。SQLite 恢复仍在生命周期内的业务状态，但不能替代多实例
WebSocket 的共享状态、事件广播和连接路由；横向扩展不属于当前单机边界。

## 验证

```bash
bun run test
bun run typecheck
bun run lint
bun run build
bun run e2e
```

`bun run e2e` 使用真实 Chromium 和两个隔离浏览器上下文，验证建房、手动审批、WebRTC
DataChannel、文本和文件传输；它不使用 jsdom 模拟 WebRTC。公网 TURN 的 UDP/TLS 验收仍需
在腾讯云服务器和真实网络上单独完成。

更多工作区文档：

- [普通用户指南](../../docs/user-guide.md)
- [API 说明](../../services/api/README.md)
- [腾讯云单机部署说明](../../deploy/README.md)
- [coturn 说明](../../deploy/coturn/README.md)
