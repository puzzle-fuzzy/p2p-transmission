# 腾讯云单机上线实施计划

> 设计依据：[腾讯云单机上线与实时可靠性设计](../specs/2026-07-13-tencent-cloud-single-node-release-design.md)

## 实施顺序

### 1. 固定运行时与生产配置边界

目标：让本地、CI 和容器使用同一个 Bun 版本，并为 SQLite、ticket、实时保护和生产域名提供类型化配置。

文件：

- 新增 `.bun-version`，内容为 `1.3.14`。
- 修改 `package.json`，补充 Bun engine/验证脚本和 E2E 脚本入口。
- 修改 `services/api/src/config.ts`，加入 `DATABASE_PATH`、realtime ticket TTL/容量、信令速率和出站队列配置，并保持测试手写 `ApiConfig` 兼容。
- 修改 `services/api/src/config.test.ts`，覆盖默认值、非法值和生产环境配置。
- 修改 `.github/workflows/verify.yml`，显式检查 `bun --version` 等于 `1.3.14`。

验证：Python 脚本检查锁文件和 package metadata，`bun --version`、API config tests、typecheck。

### 2. 建立 SQLite schema、迁移和状态快照适配器

目标：把访客、房间、成员和入房申请从“只存在内存”改为“SQLite 持久化 + 内存运行时缓存”。SQLite 使用 Bun 原生 `bun:sqlite`，不增加 ORM 依赖。

文件：

- 新增 `services/api/src/storage/sqlite.ts`：打开数据库、WAL/busy timeout/foreign keys、有限重试、关闭和稳定错误。
- 新增 `services/api/src/storage/migrations.ts`：版本化建表迁移。
- 新增 `services/api/src/storage/state-store.ts`：读取初始状态、事务式保存完整业务快照、清理过期记录。
- 新增 `services/api/src/storage/model.ts`：持久化记录类型，禁止把文件/文本 payload 纳入 schema。
- 修改 `services/api/src/modules/visitor/model.ts`、`service.ts`：增加初始状态加载和只读快照导出。
- 修改 `services/api/src/modules/room/model.ts`、`service.ts`：增加房间/成员快照加载与导出，保留现有 mutation plan 校验。
- 修改 `services/api/src/modules/room-access/model.ts`、`service.ts`：增加入房申请快照加载与导出，保留状态转换和 tombstone 语义。
- 修改 `services/api/src/context.ts`：启动 SQLite、加载快照、构造服务并注入 state store。
- 修改 `services/api/src/runtime.ts`、`index.ts`：启动失败时停止已启动资源，优雅关闭时 flush/close 数据库。
- 修改 `services/api/src/app.ts`：HTTP 请求完成后持久化发生变化的业务状态；清理动作也必须被保存。
- 新增 `services/api/src/storage/state-store.test.ts`、`migrations.test.ts`。
- 更新 visitor/room/room-access/runtime tests，覆盖重启加载、过期清理、重复保存和坏数据库启动失败。

实现约束：完整快照保存必须在单个 SQLite transaction 中完成；数据库未配置时使用 `:memory:`，让现有测试和内存 harness 不产生工作区文件；生产 Compose 显式设置 `/data/app.sqlite`。

### 3. 用一次性短时 ticket 替换 WebSocket 查询字符串 bearer token

目标：避免长期 visitor token 出现在 WebSocket URL、反向代理访问日志和监控 URL 标签中。

文件：

- 新增 `services/api/src/modules/realtime/ticket-service.ts`：签发、哈希存储、一次消费、过期清理和 visitor 校验。
- 修改 `services/api/src/context.ts`、`app.ts`：增加受保护的 `POST /v1/realtime/tickets`，只从 Authorization Bearer 读取 visitor token。
- 修改 `services/api/src/modules/realtime/routes.ts`：query 改为短 ticket，消费失败返回稳定错误，不再接受 visitor token。
- 修改 `services/api/src/modules/realtime/hub.ts`：连接保存 visitor id，不保存长期 token；断开时清理本地连接状态。
- 修改 `services/api/src/modules/realtime/routes.test.ts`、新增 `ticket-service.test.ts`：覆盖过期、重复消费、跨 visitor 使用、URL 不含长期 token和旧 token 被拒绝。
- 修改 `apps/web/src/lib/api-client.ts`、`apps/web/src/lib/config.ts`、`apps/web/src/lib/realtime-client.ts`：连接前请求 ticket，再建立 WSS；重连重新申请 ticket。
- 更新 Web 单测和 `services/api/README.md`，说明 ticket 生命周期和日志脱敏边界。

### 4. 增加 WebSocket 信令保护和出站背压

目标：限制单连接信令滥用，避免慢客户端导致服务端无限积压。

文件：

- 新增 `services/api/src/modules/realtime/connection-limits.ts`：按连接的令牌桶/滑动窗口计数、出站消息计数和字节上限。
- 修改 `services/api/src/modules/realtime/hub.ts`：所有 attach/leave/offer/answer/ice 进入统一限速；发送前进入有限队列；队列满时发送稳定错误并关闭连接；关闭和发送异常释放队列。
- 修改 `services/api/src/modules/realtime/model.ts`、`routes.ts`：补充限流/背压错误码，严格维持不回显 secret 的错误内容。
- 更新 `hub.test.ts`、`routes.test.ts`：覆盖 burst、ICE 高频、慢发送端、队列释放、连接关闭和状态回收。

### 5. 完成腾讯云单机部署产物

目标：可在 Ubuntu 单机以 `p2p.yxswy.com` 正式域名部署，WebSocket、HTTPS、SQLite 和 TURN 路径均可运维。

文件：

- 新增 `deploy/api/Dockerfile`：Bun `1.3.14` 构建/运行 API，非 root，健康检查。
- 新增 `deploy/web/Dockerfile`：使用 Bun `1.3.14` 构建 Web，运行时只提供静态资源。
- 新增 `deploy/compose.yml`：Caddy、API、Web、coturn 的单机编排；挂载 SQLite 数据目录；配置 restart、healthcheck、资源边界和日志轮转。
- 新增 `deploy/caddy/Caddyfile`：`p2p.yxswy.com` HTTPS、静态文件、`/v1/*` API 和 WebSocket upgrade 代理。
- 新增 `deploy/.env.example`：只包含变量名、域名和安全的示例值，不包含生产 secret。
- 新增 `deploy/README.md`：腾讯云 DNS、安全组、Docker 安装、目录权限、TURN secret、首次迁移、备份/恢复、更新/回滚和验收命令。
- 修改 `deploy/coturn/README.md`、`deploy/coturn/compose.yml`：补充 `turn.p2p.yxswy.com` 占位、API 共用 secret 和腾讯云安全组要求。
- 修改 `.gitignore`：确保 `deploy/.env`、SQLite 数据和证书永不进入 Git。

部署验收：Caddy 配置检查、Compose config、容器 health、HTTPS 页面、`/health`、WSS、TURN UDP/TLS 连接；公网 TURN 失败时必须在报告中单独标注为基础设施问题。

### 6. 增加真实 Chromium 浏览器 E2E

目标：验证真实浏览器中的安全入房和 WebRTC DataChannel，不用 jsdom 模拟连接。

文件：

- 修改根 `package.json` 和 `bun.lock`：加入 `@playwright/test` 及 `e2e`/浏览器安装脚本。
- 新增 `apps/web/playwright.config.ts`：启动独立 API 和 Vite，固定测试端口，临时 SQLite，复用本地服务开关。
- 新增 `apps/web/e2e/room-transfer.spec.ts`：两个隔离 Chromium context，创建房间、房间码申请、发送方审批、WebSocket/WRTC 建连、文本传输、文件选择和接收完成。
- 新增 `apps/web/e2e/fixtures.ts`：稳定的 visitor、房间和 UI locator 辅助；不得读取生产环境变量或使用共享浏览器上下文。
- 修改 `.github/workflows/verify.yml` 或新增 `.github/workflows/e2e.yml`：Linux 安装 Chromium，运行真实 E2E 并上传失败 trace/screenshot/video。
- 更新 `apps/web/README.md`：本地运行、浏览器安装、E2E 与公共 TURN 验收的区别。

### 7. 完成 P2 可用性和前端边界

文件：

- 修改 `apps/web/src/App.tsx`：初始化失败可重试；无 visitor/session 时禁用依赖会话的操作；realtime ticket/重连失败显示可操作错误。
- 修改 `apps/web/src/components/Loading.tsx`：增加 `role="status"`、可读 label 和 live region。
- 修改 `apps/web/src/components/ui/Toast.tsx`：使用设计 token 和稳定的 `role`/`aria-live` 语义。
- 修改 `apps/web/src/features/transfer/peer-session.ts`：对接收批次、Blob 聚合和异常路径增加显式上限与可恢复错误。
- 修改相关组件测试、App 测试和 transfer tests。

### 8. 完整验证和上线清单

- 运行 `bun install --frozen-lockfile`。
- 运行 `bun run verify -- --force`。
- 运行 API SQLite restart tests 和 Web Playwright E2E。
- 使用 Python 脚本检查产物中不存在 TURN shared secret、visitor token 直连 URL 和生产 `.env`/数据库文件。
- 使用 Python 脚本检查 Git 状态，确认只保留用户原有 `.vscode/settings.json` 未提交修改及本次明确文件。
- 输出上线报告：完成度、已解决问题、剩余风险、腾讯云操作清单、首发单机容量假设和后续扩展建议。

## 风险与回滚

- SQLite 迁移或快照写入失败时 API 不应静默运行；启动失败并保留数据库文件供诊断。
- 新 ticket 协议是 API/Web 硬切，部署时必须同时更新 API 和 Web；回滚要成对回滚。
- Caddy 自动证书需要 DNS 已指向腾讯云公网 IP；DNS 尚未生效时只能先做内网/HTTP 验证，不能宣称正式上线。
- 单机 2 核 2G 适合小规模 beta，不承诺高并发；超过单机连接或带宽边界前应先规划共享状态和消息总线。

## 计划自审

- [x] 已按 P0 → P1 → P2 → E2E → 验证顺序排列。
- [x] 每个步骤列出目标、文件和可验证结果。
- [x] 明确 SQLite 不存文件内容，WebSocket 不改为 SSE。
- [x] 明确 Bun `1.3.14`、腾讯云单机和 `p2p.yxswy.com`。
- [x] 保留现有测试 harness 兼容性和用户未提交修改。
