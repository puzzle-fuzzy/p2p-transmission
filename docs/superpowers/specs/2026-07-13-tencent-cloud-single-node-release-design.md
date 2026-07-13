# 腾讯云单机上线与实时可靠性设计

## 背景

项目准备部署到腾讯云 Ubuntu 单机，正式 Web 地址为 `https://p2p.yxswy.com`。当前 API 的访客、房间、成员准入和信令相关业务状态主要位于单个进程内存中；API 重启会丢失这些状态，且多进程/多实例之间无法共享在线 WebSocket 连接。

## 已确认决策

1. 首发采用单台腾讯云 Ubuntu 服务器，不做水平扩容。
2. 使用 Docker Compose 管理 API、前端静态资源、Caddy 和 coturn。
3. 使用 SQLite 作为业务状态持久化存储，数据库放在宿主机持久化目录并挂载到 API 容器。
4. SQLite 只保存业务元数据：访客、房间、成员/入房申请、连接票据和必要的限流状态；不保存文本或文件传输内容。
5. 实时信令继续使用 WebSocket。`@microsoft/fetch-event-source` 是 SSE 客户端，不承担浏览器到服务端的双向 WebRTC offer/answer/ICE 信令，因此不作为 WebSocket 替代方案。
6. 使用一次性、短时有效的连接票据，避免把长期访客 bearer token 放在 WebSocket URL 查询字符串中。
7. Bun 版本固定为 `1.3.14`，本地项目声明、CI 和容器运行时保持一致。
8. 正式域名为 `p2p.yxswy.com`；Caddy 负责 HTTPS 和 Web/API 反向代理，API 只监听容器网络，不直接暴露公网端口。

## 目标架构

```text
Browser
  | HTTPS / WSS https://p2p.yxswy.com
  v
Caddy :80/:443
  |-- /       -> web static assets
  |-- /v1/*   -> api:3000
  |
  `-- WebSocket upgrade /v1/realtime -> api:3000

api:3000 -- mounted SQLite volume --> /data/app.sqlite
coturn    -- UDP/TCP 3478, TLS/TCP 5349 --> public network
```

API 进程内仍保留在线 socket registry；SQLite 负责可恢复的业务真相源。服务器重启后，浏览器重新建立 WebSocket 并重新绑定房间即可恢复业务状态。由于首发是单实例，不引入 Redis/pubsub；未来横向扩展时需要增加跨实例事件总线和连接路由。

## P0：可部署性与上线基线

- 增加 API 和 Web 的生产容器构建配置，运行时固定 Bun `1.3.14`。
- 增加 Compose、Caddy、coturn 配置模板和腾讯云部署说明。
- 配置 SQLite 数据卷、WAL、备份建议、健康检查和优雅停止。
- 配置 `p2p.yxswy.com` 的生产 API 地址、CORS、可信代理和 WebSocket 反代。
- 文档明确腾讯云安全组至少需要 80/443、TURN 的 3478 UDP/TCP 和 5349 TCP；SSH 只允许管理来源。
- 不把域名证书、TURN secret、SQLite 数据库或生产环境文件提交到仓库。

## P1：实时信令与状态可靠性

- 新增短时一次性 realtime connection ticket 的签发和消费接口。
- WebSocket 只接受 ticket，ticket 绑定 visitor、过期时间和一次消费语义。
- 为每个连接增加信令消息速率限制、消息大小边界和出站队列上限；队列满时安全关闭连接并返回稳定错误码。
- 将访客、房间、房间成员、入房申请和 ticket 的读写迁移到 SQLite repository；涉及准入状态的变更使用事务和幂等检查。
- 启动时执行迁移；SQLite 暂时不可用时采用有限次数、递增间隔重试，仍失败则明确退出并输出可诊断错误。
- 对重启场景补充 API 单测：数据可恢复、过期 ticket 不可用、ticket 不能重复消费、并发准入不会产生非法状态。

## P2：产品与可用性收尾

- API/前端初始化失败时提供可见的重试路径，未建立会话时禁用依赖会话的操作。
- 为加载和实时状态增加适当的语义属性和 live region。
- 将关键图标按钮触控尺寸调整到至少 44px。
- 统一 Toast 的语义和现有设计 token，保留错误、成功和普通提示的可读性。
- 对接收文件的内存聚合增加明确边界与异常处理，避免超出浏览器可用内存时静默失败。

## 真实浏览器 E2E

使用 Playwright Chromium，不用 jsdom 模拟 WebRTC。测试由真实 API 和 Vite 服务提供：

1. 启动临时 API 和 Web 服务。
2. 创建两个隔离 browser context，分别作为发送方和接收方。
3. 发送方创建房间；接收方通过房间码申请加入；发送方批准。
4. 等待两个浏览器中的 WebRTC DataChannel 建立。
5. 验证文本发送/接收和文件选择/接收完成。
6. 测试结束自动关闭上下文和临时服务，不使用生产数据库。

CI 在 Linux 安装 Chromium 后执行 E2E；若公共 TURN 未配置，E2E 使用本地浏览器直连，只验证应用信令和 DataChannel 流程。公共 TURN 的 UDP/TURN-TLS 验收另保留部署验收步骤，不把公网基础设施状态伪装成单元测试结果。

## 不在本次范围

- 不使用 SSE 替换 WebSocket。
- 不引入 Redis、消息队列或多实例负载均衡。
- 不把文件或大文本写入 SQLite。
- 不在代码中硬编码生产 secret。
- 不把腾讯云控制台 DNS、安全组或证书操作自动化为不可逆脚本；部署文档提供人工确认步骤。

## 验收标准

- `bun install --frozen-lockfile`、lint、typecheck、单元测试和 build 全部通过。
- 本地可用 Bun `1.3.14` 启动 API/Web，并完成 SQLite 初始化。
- API 重启后房间和准入业务状态仍可恢复；过期或重复 ticket 被拒绝。
- Playwright 两浏览器上下文真实完成建房、审批、连接、文本和文件流程。
- Compose 配置通过静态检查，Caddy 配置能代理 HTTPS、API 和 WebSocket。
- `p2p.yxswy.com` 的生产变量、数据库目录、备份和安全组要求均有清晰文档。
