# Rust M4：Axum 控制面结果

> 结论：**M4 通过，可以进入 M5 Dioxus 房间 vertical slice。**

## 1. 本阶段边界

M4 建立全新的 Rust 控制面，不兼容 1.x 的 Bun API、WebSocket 协议或数据库。用户可见页面仍是 M2 锁定的克制 AppShell，本阶段没有修改 CSS、布局或动效。

控制面只保存 session、room、membership、join request 与邀请授权状态。SDP、ICE candidate、WebSocket connection、文件内容、文件清单和传输进度不写入 SQLite。

## 2. SQLite

初始 migration 位于 `rust/apps/server/migrations/202607150001_initial.sql`，创建五张 `STRICT` 表：

- `sessions`
- `rooms`
- `room_members`
- `join_requests`
- `invite_capabilities`

schema 使用 foreign key、状态 `CHECK`、过期索引、room revision、owner/create-request 幂等唯一键，以及“同一 session 在同一 room 最多一个 pending join request”的 partial unique index。

repository 在启动时执行 migration，并验证 foreign keys 与 WAL。房间命令统一通过 `BEGIN IMMEDIATE` 事务加载 domain snapshot、执行领域命令，再按预期 revision 持久化；并发提交同一 revision 时只有一个请求获胜。进程关闭数据库后重新连接，room、membership 和 join request 可以完整恢复为领域对象。

## 3. HTTP 控制面

当前同源 API：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `POST` | `/api/session` | 创建或恢复匿名 session，并设置 2.0 独立 cookie |
| `POST` | `/api/rooms` | 幂等创建 room |
| `POST` | `/api/rooms/{code}/invite-capabilities` | owner 幂等签发邀请 capability |
| `GET` | `/api/rooms/{code}/bootstrap` | 获取授权范围内的 room snapshot |
| `POST` | `/api/rooms/{code}/join-requests` | 创建 join request，可校验邀请 capability |
| `POST` | `/api/rooms/{code}/join-requests/{request_id}/decision` | owner 批准或拒绝 |
| `POST` | `/api/rooms/{code}/leave` | 离开 room |
| `GET` | `/api/rtc/config` | 获取 STUN 与短期 TURN 配置 |

mutation 要求精确匹配允许的 Origin，并统一使用有大小上限的 JSON body 与 `ErrorEnvelope`。cookie 名为 `p2p_session`，设置 `HttpOnly`、`SameSite=Lax`、`Path=/`，生产 HTTPS 配置要求同时启用 `Secure`。

session、room、join 与 signaling 使用分层、定长窗口且总 key 数有上限的 rate limiter。客户端地址来自 Axum `ConnectInfo<SocketAddr>`，不信任请求自行提供的转发头。

## 4. 邀请 capability 与 TURN

邀请 capability 使用服务端 HMAC-SHA256 密钥、room id 与 request id 确定性派生，因此相同幂等请求可以返回相同结果。数据库只保存 capability 的 SHA-256 摘要，不保存明文；日志边界不记录 cookie、capability、SDP 或 ICE credential。

生产 HTTPS 配置必须显式提供不少于 32 bytes 的 `P2P_CAPABILITY_SECRET`。配置的 secret 类型实现脱敏 `Debug`，避免意外进入日志。

配置 `P2P_TURN_URLS` 与 `P2P_TURN_SECRET` 后，`/api/rtc/config` 按 coturn REST credential 约定生成绑定当前 session、带过期时间的 HMAC-SHA1 临时凭证。两个 TURN 环境变量必须成对出现，secret 不进入响应或调试输出。

## 5. Realtime

`/realtime` 使用 session cookie 与 Origin 完成握手，第一条客户端消息必须是 room attach。每条 connection 拆分 reader/writer，并具备：

- bounded outbound channel 与慢消费者隔离；
- session/room/peer 路由索引；
- connection generation 替换，旧连接清理不会删除新连接；
- attach/detach 驱动 domain presence 与 room revision；
- join、decision、online、offline 与 room snapshot 推送；
- SDP/ICE 只允许发送给同 room、已批准且在线的目标 peer；
- signaling frame、非法帧次数、发送速率和空闲时间均有上限。

HTTP join/decision 与 WebSocket presence 共用同一个 hub，因此 owner 已 attach 时会立即收到 join 事件，不需要前端轮询。

## 6. Maintenance 与服务边界

后台 maintenance 固定周期、固定 batch 大小处理过期 join request、room 与 session。过期变更仍通过 domain command 与 repository transaction，room 过期后广播事件并断开对应实时连接。

readiness 会真实查询 SQLite；server 在 migration 与 storage 初始化成功后才监听端口。应用统一设置 CSP、`nosniff`、`no-referrer`、Permissions Policy 与请求 timeout，并保留优雅关停和 SQLite pool 关闭。

Dioxus 动态 document API 会依赖 JavaScript `new Function`。为保持 CSP 不包含 `unsafe-eval`，AppShell 移除了非必要的动态 title/meta 节点，页面标题继续由 `Dioxus.toml` 的静态构建配置提供；页面 CSS 和布局未改变。

## 7. 验证结果

完整 Rust 测试共 54 项：

- domain：17
- protocol：13
- server：18
- test-support：1
- transfer：5

server integration tests 覆盖：

- SQLite migration 重开、WAL、foreign key 与 bounded expiry；
- room command 幂等、并发 revision 单赢家和完整 snapshot 恢复；
- Origin、cookie flags、body limit 与统一错误结构；
- session → room → invite → join → approve → bootstrap 流程；
- capability 明文不入库、错误 capability 拒绝；
- TURN 临时凭证按 session 生成且 secret 脱敏；
- WebSocket 安全握手、attach、重连、慢客户端、旧 generation 清理；
- HTTP join 事件推送与 signaling authorization。

通过的质量门禁：

```text
python -X utf8 scripts/verify.py
python -X utf8 scripts/test_e2e.py
```

第一条命令包含 native/WASM strict Clippy、workspace tests、release server、Dioxus release build、文档链接与 `git diff --check`。第二条命令在 1440px 与 390px Chromium 中验证现有 AppShell、About/GitHub、readiness 与无水平溢出，结果为 2/2 通过。

## 8. M5 起点

M5 将在不改变既有视觉基线的前提下，把 session、room、join approval、bootstrap 和 realtime 接入 Dioxus 页面。第一条完整用户链路是：创建房间 → 分享 capability → 接收者请求加入 → owner 批准 → 双方在线 → 接收者头像按既有“小到大”动效只出现一次，并支持 reduced motion。
