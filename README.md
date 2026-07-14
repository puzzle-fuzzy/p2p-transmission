# P2P Transmission

P2P Transmission 是一个临时、点对点的文本与文件传输工具。打开
[https://p2p.yxswy.com](https://p2p.yxswy.com)，创建房间后把邀请链接或房间码交给对方，
浏览器会优先建立 WebRTC DataChannel；网络条件不允许直连时，可以通过 coturn 中继加密的
WebRTC 流量。

项目不需要注册账号，也不提供云端文件存储或历史记录。API 只负责临时访客、房间、加入
授权、WebSocket 信令和短期 TURN 凭据；文本正文和文件内容不经过 API 的应用载荷存储或
中继路径。

## 快速使用

1. 打开 [p2p.yxswy.com](https://p2p.yxswy.com)，点击创建房间。
2. 房主复制邀请链接，发送给可信的接收者。
3. 接收者打开邀请链接并确认加入；如果只有 6 位房间码，则输入房间码提交申请，等待
   房主批准，然后完成加入。
4. 连接建立后，在文本区域发送文字，或选择文件并发送。发送者和接收者都应等待页面显示
   完成状态后再关闭标签页。

普通用户可按任务阅读[用户指南](docs/user-guide.md)。

## 隐私与安全边界

- 6 位房间码只是公开的房间标识，不是成员授权凭证。仅知道房间码不能直接加入房间。
- 邀请链接包含加入权限。它等同于一次性邀请 capability，只应发送给可信接收者；不要把
  邀请链接发布到公开群组、日志或截图中。
- 文本和文件通过浏览器之间的 WebRTC DataChannel 传输。API 不保存或中继应用载荷；它仍
  会处理建立连接所需的临时访客、房间、成员、加入申请和信令状态。
- 直连失败时，coturn 只中继加密的 WebRTC 流量，不能读取文本正文或文件内容。是否需要
  中继取决于两端网络和浏览器的 ICE 协商结果。
- 房间默认有效期为 30 分钟。关闭页面、刷新页面或切换网络可能让当前连接断开并需要重新
  建立；本项目不把传输内容保存为可恢复的云端历史。

这些边界说明传输路径，不等同于匿名、永久可用或对重要文件的备份保证。重要文件请保留
原始副本，并通过可信渠道发送邀请链接。

## 使用限制与运行边界

- 单个文件批次最多 10 个文件，总大小最多 100 MiB。
- 房间和加入申请受生命周期限制；房间过期后请创建新房间。
- 浏览器需要支持 WebRTC DataChannel。严格 NAT、企业网络或防火墙可能阻止直连，需要
  已正确配置的 coturn 中继。
- 生产环境是腾讯云单机部署，当前只运行一个 API 实例。SQLite 持久化仍在生命周期内
  的访客、房间、成员和加入申请；在线 WebSocket 连接表仍在 API 进程内存中。
- API 重启后，SQLite 中仍有效的业务状态可以恢复，但已有在线 WebSocket 会断开，浏览器
  需要重新申请短期 ticket 并重连。当前不承诺多 API 实例之间的状态同步。

## 项目结构与数据流

```text
apps/web              React + Vite 前端，房间交互和 WebRTC DataChannel
services/api          Bun API，访客、房间、加入授权、信令和 TURN 凭据
packages/contracts    Web/API 共用的类型与 schema
services/api/src/storage  SQLite 持久化层
deploy                腾讯云单机的 Docker Compose、宿主机 Nginx 和 coturn 配置
```

一次传输的大致路径是：浏览器向 API 创建临时访客和房间 → API 通过 HTTP/WebSocket 协助
加入授权与 WebRTC 协商 → 两个浏览器通过 DataChannel 传文本和文件；只有在网络无法直连
时，WebRTC 才会把加密流量交给 coturn 中继。API 不接收文件正文，也不把正文写入 SQLite。

## 本地开发

项目固定使用 Bun 1.3.14：

```bash
bun --version
bun install --frozen-lockfile
bun run dev
```

开发服务地址：

- Web：<http://localhost:5713>
- API：<http://localhost:3332>

各工作区的配置和技术细节见：

- [Web 前端说明](apps/web/README.md)
- [API 说明](services/api/README.md)
- [腾讯云单机部署说明](deploy/README.md)
- [coturn 说明](deploy/coturn/README.md)

## 验证

```bash
bun run check:docs
bun run verify -- --force
bun run e2e
git diff --check
```

`bun run e2e` 使用真实 Chromium 和两个隔离浏览器上下文，验证建房、加入审批、WebRTC
DataChannel、文本和文件传输。公网 TURN 的 UDP/TLS 回退仍需要在真实网络和部署环境中
单独验收。

## 腾讯云单机部署

生产地址是 [https://p2p.yxswy.com](https://p2p.yxswy.com)。部署方案使用单个 API 实例、
SQLite 数据卷、Docker Compose、宿主机 Nginx 和 coturn。需要配置的公网端口包括：

- TCP `80`、`443`：Web、API 和 HTTPS/WSS。
- TCP/UDP `3478`：TURN。
- TCP `5349`：TURN TLS。
- UDP `49160-49259`：coturn relay 端口范围。

完整的 DNS、安全组、证书、环境变量、启动、备份和验收步骤见
[腾讯云单机部署说明](deploy/README.md)。部署 Web 与 API 时必须同步发布；API 重启或协议
硬切部署后，旧页面应重新载入。

## 故障排查

| 现象 | 发生了什么 | 下一步 |
| --- | --- | --- |
| 页面提示无法连接服务器 | 浏览器没有成功访问当前 API 或 WebSocket | 确认使用 `https://p2p.yxswy.com`，检查域名解析、HTTPS 证书和 `/health`；部署环境再查看 API 与 Nginx 日志。 |
| 房间码无效或房间已结束 | 房间不存在、已被关闭或已超过 30 分钟 | 返回大厅创建新房间，并重新发送新的邀请链接或房间码。 |
| 只有房间码，长时间没有进入房间 | 房间码只定位房间，当前请求仍在等待房主决定 | 把页面保持打开并联系房主批准；被拒绝或申请失效后重新提交申请。 |
| 两端一直连接中或传输失败 | 两端网络可能无法直连，或 TURN/防火墙配置不可用 | 先切换到稳定网络并重试；生产环境检查 coturn 域名、3478/5349 端口和 `49160-49259/udp`，再用真实浏览器做 relay 验收。 |
| 文件无法加入批次 | 批次超过 10 个文件或总大小超过 100 MiB | 分成多个批次后重试，并保留原始文件备份。 |
| 部署后页面行为异常 | Web 与 API 可能不是同一版，或浏览器仍使用旧页面 | 同时更新 Web/API，重新加载页面；房间授权协议硬切部署后创建新房间和新邀请链接。 |

## 文档索引

- [普通用户指南](docs/user-guide.md)：创建房间、加入、审批、传输和失败后的处理。
- [Web 前端说明](apps/web/README.md)：React、ICE/TURN 模式、配置和前端验证。
- [API 说明](services/api/README.md)：HTTP、WebSocket、SQLite、TURN 和单实例边界。
- [腾讯云单机部署说明](deploy/README.md)：DNS、安全组、Nginx、Compose、证书和备份。
- [coturn 说明](deploy/coturn/README.md)：公网 TURN 的配置生成与验收。

当前的产品边界是“单 API 实例 + SQLite 业务状态 + 进程内在线连接”。如果要横向扩展，
需要引入共享状态、事件广播和连接路由，不能仅通过增加 API 容器数量完成。
