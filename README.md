# P2P Transmission

P2P Transmission 是一个临时、点对点的文本与文件传输应用。React Web 负责房间交互和
WebRTC DataChannel 传输，Bun API 负责临时身份、授权加入、信令与短期 TURN 凭据。
Bun HTTP/WebSocket API 不存储或中继应用载荷；启用 coturn 时，它只转发加密的 WebRTC
流量，不能读取文本正文或文件内容。

## 安全加入模型

- 6 位房间码只是公开标识，不能直接授予成员资格。仅输入房间码时，接收者发送加入
  申请，由房主明确允许或拒绝；批准后接收者必须完成 `/finalize` 才成为房间成员。
- 房主创建房间时获得一次高熵邀请 capability。分享链接使用
  `#room=123456&invite=inv_...`，持有该链接的接收者确认后可直接加入。
- Web 启动后立即消费并清除 URL fragment。邀请 token 只保存在当前标签页内存中：房主
  保存当前房间的分享 capability，接收者保存当前加入意图；它不写入 browser storage、
  公共房间 DTO、WebSocket、TURN 用户名、错误文本或日志。邀请链接只应发送给可信接收者。
- 接收者恢复仅限同一标签页保存的 visitor/room session、同一 visitor 和已有 receiver
  membership；恢复不会创建新身份。当前不支持发送者恢复。
- 旧 `?room=123456` 链接只预填手动申请，旧 `localStorage['p2p.roomSession']` 会被删除，
  不会迁移为恢复凭证。

## 本地开发

```bash
bun install --frozen-lockfile
bun run dev
```

- Web：<http://localhost:5713>
- API：<http://localhost:3000>

各工作区的配置、验证和 TURN 说明见
[`apps/web/README.md`](apps/web/README.md) 与
[`services/api/README.md`](services/api/README.md)。

## 部署

安全加入协议采用硬切部署：Web 与 API 必须同步发布，不保留 code-only join、公开房间
查询或客户端选择 role 的兼容路径，也不允许前端失败后回退到旧协议。API 重启会使所有
内存访客、房间和申请失效，因此部署后旧页面应重新载入并重新创建房间。

```bash
bun run verify
```
