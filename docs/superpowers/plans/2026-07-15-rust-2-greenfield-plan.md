# P2P Transmission 2.0：全 Rust Greenfield 实施计划

> 状态：执行中（M0、M2、M3、M4、M5、M6 完成；M7 已完成多接收者、5 GiB 流式写盘、同页面与双方刷新恢复、有界重连和最多 10 文件批次，其他体验项继续；M1 在 Chromium/Firefox 条件通过，真实 Safari 与 TURN relay 待补）<br>
> 工作分支：`rust-dev`<br>
> 设计依据：[全 Rust Greenfield 重构设计](../specs/2026-07-15-rust-2-greenfield-design.md)
> 验证记录：[Dioxus + Axum + WebRTC Spike 结果](../specs/2026-07-15-dioxus-webrtc-spike-results.md)
> M2 记录：[Rust 2.0 工程基线结果](../specs/2026-07-15-rust-v2-m2-engineering-baseline.md)
> M3 记录：[Rust 2.0 Domain 与协议结果](../specs/2026-07-15-rust-v2-m3-domain-protocol.md)
> M4 记录：[Rust 2.0 Axum 控制面结果](../specs/2026-07-15-rust-v2-m4-control-plane.md)
> M5 记录：[Rust 2.0 Dioxus 房间垂直切片结果](../specs/2026-07-15-rust-v2-m5-room-vertical-slice.md)
> M6 记录：[Rust 2.0 DataChannel 单文件传输结果](../specs/2026-07-15-rust-v2-m6-datachannel-transfer.md)
> M7 阶段记录：[Rust 2.0 多接收者传输结果](../specs/2026-07-15-rust-v2-m7-multi-receiver.md)
> M7 大文件与批量记录：[Rust 2.0 5 GiB 与最多 10 文件流式传输](../specs/2026-07-15-rust-v2-m7-large-file-protocol.md)

## 1. 执行原则

本计划不把 1.x 翻译成 Rust。每个阶段以可运行的 vertical slice 为目标，并遵守：

- 保留的是用户体验和功能结果，不是旧 API、协议、数据库和内部实现。
- 在 Dioxus/WebRTC 技术 spike 通过前，不开始大规模页面重写。
- `domain`、`protocol`、`transfer` 优先写成可在 native Rust 测试的纯 crate。
- 每个异步队列、浏览器缓冲区和内存 fallback 都有上限。
- 1.x 与 2.0 在迁移期独立构建、独立部署、独立数据库。
- 2.0 未达到体验等价前，1.x 继续作为可用产品；不让半成品替换线上版本。
- CSS、Playwright、浏览器生成的 WASM bootstrap 不属于需要消灭的“非 Rust 生产逻辑”。

## 2. 完整里程碑

| 里程碑 | 结果 | 决策 gate |
| --- | --- | --- |
| M0 ✅ | 冻结 1.x 体验基线 | 页面/状态/流程清单完整 |
| M1 🟡 | Dioxus + Axum + WebRTC spike | Chromium/Firefox 已通过；Safari/TURN 是后续硬 gate |
| M2 ✅ | Rust workspace 与 CI | 全新 checkout 可构建测试 |
| M3 ✅ | 2.0 domain/protocol | 状态机和协议不变量全绿 |
| M4 ✅ | 2.0 Axum 控制面 | session/room/join/realtime 可用 |
| M5 ✅ | Dioxus 房间 vertical slice | 双浏览器创建、批准、连接 |
| M6 ✅ | DataChannel 文件协议 | 单接收者可靠传输 |
| M7 ▶ | 完整产品体验 | 多接收者定向/广播、5 GiB 流式写盘、同页面与双方刷新恢复、有界重连、最多 10 文件 ✅；文本与错误矩阵继续 |
| M8 | 跨浏览器、性能与安全 | Chrome/Firefox/WebKit 达标 |
| M9 | 2.0 独立预发布 | 真实环境观察通过 |
| M10 | 正式切换与 1.x 退役 | 观察期结束、回滚演练完成 |

## 3. M0：建立体验基线

### 目标

把“页面样式和使用功能一致”变成可以验收的标准，而不是凭记忆判断。

### 任务

- 盘点 1.x 页面状态：
  - 首次加载与初始化失败。
  - 首页空闲、创建中、房间恢复。
  - 手动加入、邀请加入、等待、取消、批准、拒绝、过期。
  - 无接收者、一个接收者、多接收者和溢出计数。
  - 空传输面板、文件选择、粘贴确认、接收者选择。
  - 接收请求、传输中、完成、拒绝、取消、超时、失败、重试。
  - 分享、About、Toast、确认和错误 dialog。
- 固定 390px、768px、1440px 三个 viewport 的截图。
- 对头像进入、连接状态、文件行、dialog、toast、传输轨道录制短视频/trace。
- 记录键盘 tab 顺序、dialog 初始焦点、Escape 行为和 aria-live 文案。
- 建立 capability matrix：Chrome、Firefox、Safari；direct、STUN、TURN relay。
- 记录 1.x 用户可见文案和错误映射，2.0 可以优化文字，但不能漏掉反馈场景。
- 记录核心性能：首屏、进入房间、建连时间、100 MiB/1 GiB 传输、主线程响应和内存峰值。

### 产物

```text
docs/product-baseline/
├─ states.md
├─ flows.md
├─ accessibility.md
├─ performance.md
├─ screenshots/
└─ recordings/
```

### Gate

- 每个核心用户流程有 Given/When/Then。
- 每个 UI 状态有截图或明确说明为何无法截图。
- 发送方与接收方两个角色都覆盖。
- 动效在普通模式和 reduced-motion 下都有记录。

## 4. M1：技术 spike——先证明最危险的部分

### 目标

用最少 UI 证明 Dioxus/WASM 能可靠使用 WebRTC、File API 和背压。此阶段不追求产品视觉。

### 建议目录

```text
spikes/dioxus-webrtc/
├─ Cargo.toml
├─ Dioxus.toml
├─ src/
└─ README.md
```

### 任务

1. Dioxus Web 显示两个 peer 的最小连接状态。
2. Axum 暴露 `/health` 和一个最小 WebSocket signaling endpoint。
3. `web-sys` 封装：
   - `RTCPeerConnection`。
   - offer/answer。
   - trickle ICE。
   - DataChannel open/message/close/error。
4. 两个真实 browser context 完成：
   - 文本消息。
   - 1 MiB、100 MiB 文件。
   - 主动取消。
   - 一端刷新后的清理。
5. 实现 `buffered_amount` high/low watermark，证明发送内存有界。
6. File slice → ArrayBuffer → DataChannel → Blob/下载，全链路检查字节和 BLAKE3。
7. 验证 object URL、Closure、timer、PeerConnection 和 DataChannel cleanup。
8. 在 Chromium、Firefox、WebKit 运行；单独记录 Safari 限制。
9. 用 coturn 强制 relay 运行一次。
10. 测量 WASM 包大小、初始化时间、传输吞吐、CPU 和内存。

### 成功条件

- 三个浏览器核心链路通过，或只有有明确 workaround 的次要差异。
- 100 MiB 传输 hash 一致，内存不随文件大小线性无限增长。
- 慢接收端会触发发送暂停，而不是堆积所有 chunk。
- 页面退出后没有继续运行的读写循环和明显资源泄漏。
- 主逻辑没有散落 JavaScript；interop 被限制在一个平台模块。

### 失败决策

- Dioxus 生命周期/渲染造成问题，`web-sys` 本身可用：尝试 Leptos 或 Yew 薄 spike。
- 三个 Rust UI 框架都被同一浏览器绑定问题阻塞：采用 React 前端 + Rust backend 的风险回退，并记录 ADR。
- 不允许为了通过 gate 在组件中大量注入不可测试的 JS 字符串。

## 5. M2：正式 Rust workspace 与工程基线

### 任务

- 新建根 `Cargo.toml` workspace。
- 固定 `rust-toolchain.toml`；提交 `Cargo.lock`。
- 创建：
  - `apps/web`
  - `apps/server`
  - `crates/domain`
  - `crates/protocol`
  - `crates/transfer`
  - `crates/browser-platform`
  - `crates/test-support`
- Dioxus Web 只显示基础 AppShell；Axum 只提供 health 和静态资源。
- 用 Cargo features 隔离 wasm-only/native-only 依赖。
- 加入统一 error policy：library 用 typed error，binary boundary 用 context，不在正常路径 `unwrap`。
- 配置 `tracing`、panic hook、开发日志和优雅关停。
- Python 脚本封装开发启动与验证，避免 shell 编码和平台差异。
- CI 分开 native、wasm、E2E job，并缓存 Cargo/Dioxus 构建产物。

### 初始命令

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --locked
cargo build -p p2p-server --release --locked
dx build --web --release
```

### Gate

- 全新 checkout 仅按 README 可以启动。
- server/web 构建不依赖现有 Bun workspace。
- `domain` 在 native 和 wasm target 均不引入平台依赖。
- release 构建的静态资源由 Axum 同源提供。

## 6. M3：2.0 domain 和共享协议

### 6.1 ID 与时间

- 为 SessionId、RoomId、RoomCode、PeerId、RequestId、TransferId、FileId 建 newtype。
- clock、ID generator、random source 可注入。
- wire 时间统一 UTC epoch milliseconds；领域内部使用明确类型。
- 任何展示名称、房间码、文件元数据都有长度和字符约束。

### 6.2 房间状态机

- `SessionState`、`RoomState`、`MembershipState`、`JoinRequestState`。
- 命令：CreateRoom、RequestJoin、DecideJoin、Attach、Detach、Leave、Expire。
- 事件：RoomCreated、JoinRequested、JoinApproved、PeerOnline、PeerOffline、RoomExpired。
- 明确重复命令的幂等行为和非法转移错误。
- room revision 每次可见状态变化递增。

### 6.3 传输状态机

- sender 与 receiver 分开建模。
- manifest、accept/reject、start、progress、cancel、complete、fail。
- 每个 receiver 独立 outcome，多接收者聚合只属于 presentation。
- 进度单调、terminal 状态不可逆、重复 cancel/complete 幂等。

### 6.4 协议

- HTTP DTO、WS tagged enums、DataChannel control/binary headers。
- wire protocol 显式 `major/minor`。
- 控制协议使用 JSON，DataChannel data frame 使用二进制。
- golden fixture 验证 encode/decode。
- 解析任意不可信输入不得 panic；设置长度和嵌套上限。

### Gate

```bash
cargo test -p p2p-domain --locked
cargo test -p p2p-protocol --locked
cargo test -p p2p-transfer --locked
```

- 状态迁移表全覆盖。
- property test 随机命令序列保持不变量。
- protocol fuzz/property test 不 panic、不无限分配。
- crate graph 符合设计依赖方向。

## 7. M4：Axum 2.0 控制面

### 7.1 SQLite 2.0

- 使用全新数据库和 `sqlx` migration。
- 表：sessions、rooms、room_members、join_requests、invite_capabilities。
- foreign keys、索引、expires_at、revision 和 unique constraints 明确。
- 每个状态转移一个事务；使用条件更新保护 revision。
- 开启/验证 WAL、busy timeout、checkpoint 和备份恢复。
- WS connection、SDP/ICE、文件清单和进度不入库。

### 7.2 Session 与安全

- `POST /api/session` 创建匿名 session。
- Secure/HttpOnly/SameSite cookie；2.0 独立 cookie name。
- mutation 和 WS 校验 Origin。
- session、room code、join、signaling 分层限流。
- 邀请 capability 只存 hash，fragment 由客户端显式提交。

### 7.3 Room/Access HTTP

- Create room、bootstrap、join request、decision、leave、RTC config。
- 命令支持 request id/idempotency key，网络重试不重复创建。
- 统一 error envelope，但不模仿 1.x error code。
- readiness 在 migration、DB、hub 和 maintenance 就绪后才成功。

### 7.4 Realtime

- `/realtime` cookie 认证与 room attach。
- hub 使用 bounded channel；每 socket reader/writer 分离。
- join/decision/presence 事件推送，替代前端轮询。
- SDP/ICE 只允许路由给同房间、已批准、在线 peer。
- 旧 connection generation 退出不删除新 connection。
- revision gap 触发客户端 bootstrap。

### Gate

- HTTP integration tests 覆盖正常、错误、幂等和并发 revision。
- WebSocket tests 覆盖 attach、重连、慢客户端、乱序和 signal authorization。
- SQLite kill/restart 后保持一致。
- signaling 压力不会产生数据库写放大。
- 日志不包含 cookie、capability、SDP、ICE credential。

## 8. M5：Dioxus 房间 vertical slice

### 目标

第一次交付端到端可用但尚不完整的 2.0：两个浏览器可以创建房间、请求、批准并看到头像入场。

### 任务

- AppShell、HomePage、RoomHeader、PeerFlow、JoinWaiting、JoinRequestDialog。
- browser-platform 封装 fetch、WebSocket、cookie same-origin、timer、visibility。
- Session/Room/Realtime 三个状态机与 Dioxus signals 对接。
- 分享链接 fragment capability 解析后立即从地址栏历史安全清理。
- room revision gap、WS reconnect/backoff 和 bootstrap recovery。
- 复刻当前设计 tokens、字体、背景、按钮、输入框、dialog、toast。
- 实现头像从小到大进入、connecting dots、presence 状态；支持 reduced motion。
- 桌面/移动响应式和键盘焦点。

### Gate

- 两个 browser context 完成创建 → 分享/输入码 → 请求 → 批准 → 在线。
- 接收人出现时头像只动画一次，重渲染不重复抖动。
- 刷新 owner/receiver 有明确恢复或失效提示。
- 截图基线达到约定阈值；DOM/aria 行为无退化。
- 此时尚未要求文件传输，但 signaling spike 保持可运行。

## 9. M6：DataChannel 单接收者文件 vertical slice

### 任务

- 将 spike 的 WebRTC 代码重构进 `browser-platform`，移除一次性验证代码。
- 完整 offer/answer/trickle ICE、TURN credential 和 peer lifecycle。
- TransferComposer 支持 file input、拖拽和列表。
- manifest → receiver confirmation → accept/reject。
- control/data channel、二进制 chunk、BLAKE3、完成确认。
- buffered_amount high/low watermark。
- 进度事件用 animation frame 合并；速度/ETA 使用稳定窗口。
- 接收端 capability detection：流式落地优先，Blob fallback 有大小限制。
- cancel、peer close、timeout、hash mismatch 和 download URL cleanup。

### Gate

- 0 B、小文件、100 MiB、目标上限文件均通过。
- 文件名 Unicode、同名、多文件和未知 MIME 通过。
- direct 与 TURN relay 通过。
- 取消后 CPU、内存和 network activity 及时下降。
- 发送和接收 hash 一致；损坏数据不提供下载。
- UI 主线程在持续传输时仍可操作取消按钮。

## 10. M7：完整体验等价

### 功能

- 多接收者选择与并行/调度策略。
- 文本/粘贴行为按产品确认实现；如果粘贴只表示文件，文案明确。
- 多文件 manifest 和逐文件结果。
- 100 MiB buffered 与 5 GiB streamed 模式；大文件使用流式写盘、分段 ACK 和恢复游标。
- receiver 独立 accept/reject/cancel/fail。
- retry 创建新 transfer，同时保留上一轮结果摘要。
- 房间倒计时、过期、离开和恢复。
- 通知权限和后台状态行为。
- 分享、About 和 GitHub 链接。

### UI 与动效

- 迁移 M0 状态矩阵中的所有视觉状态。
- PeerFlow 最多显示头像数量与 overflow count。
- 文件行入场、进度、terminal 状态、dialog、scrim、toast timer。
- hover/focus/active/disabled 和 touch 反馈完整。
- 所有 motion 支持 reduced-motion。
- 加载和错误状态不发生明显 layout shift。

### 韧性

- WS 短断线和 backoff。
- peer disconnected/failed 的重建上限。
- tab hidden/visible。
- owner/receiver 刷新。
- server restart、room expired、session expired。
- 网络操作都可取消；旧 generation 不回写新 room。

### Gate

- M0 所有核心 Given/When/Then 在 2.0 通过。
- 没有只显示 spinner 而不给超时/重试的无限等待状态。
- 多接收者某一端失败不会错误终止其他端。
- 视觉和文案由产品基线逐项签收。

## 11. M8：跨浏览器、性能、无障碍与安全

### 浏览器矩阵

- Chromium stable。
- Firefox stable。
- WebKit/Safari stable。
- 桌面和至少一个真实移动设备。
- direct、STUN、TURN relay。

### 性能

- 锁定 WASM gzip/brotli 预算。
- 测量 shell 可见、WASM ready、room ready、peer connected。
- 100 MiB buffered 与 5 GiB streamed 传输的吞吐、CPU、RSS/JS heap/WASM memory 和磁盘写入。
- progress render rate、长任务和交互延迟。
- Axum/SQLite 在 2C2G 做并发、soak 和 restart。

### 无障碍

- keyboard-only 全流程。
- dialog focus trap/return focus。
- aria-live 不因高频进度刷屏。
- 对比度、触控尺寸、缩放 200%、reduced-motion。
- axe 自动检查 + 人工读屏抽查。

### 安全

- Origin/CSRF、cookie flags、CSP、安全 headers。
- 房间码枚举、join spam、WS flood、超大 frame、畸形 protocol。
- capability 泄漏、日志敏感字段和文件名注入。
- cargo audit/deny、SBOM、容器非 root。

### Gate

- P0/P1 问题为零。
- 所有已知浏览器差异都有明确用户反馈或安全降级。
- 性能预算达标；未达标项不可只用“Rust 应该更快”解释。
- 威胁模型和安全测试报告归档。

## 12. M9：2.0 独立预发布

### 部署方式

- 2.0 使用独立域名/子域、cookie namespace 和 SQLite volume。
- CI 构建 release server + Dioxus static assets 的不可变镜像。
- Nginx 配置 HTTPS/WSS；coturn 使用生产等价配置。
- 预发布不读取、不写入 1.x 数据库。

### 验证

- 内部 dogfood 完整流程。
- 合成双浏览器定时传输。
- 小范围真实用户测试。
- 观察错误率、连接成功率、TURN 使用率、传输完成率、WASM 加载失败率。
- 演练 server restart、DB backup/restore、coturn failure 和镜像回退。

### Gate

- 至少覆盖一个完整房间过期/maintenance 周期。
- 关键指标稳定且无内存持续增长。
- 回滚只需要入口切回 1.x，不共享 2.0 数据库。
- 用户明确确认视觉和功能结果达到 2.0 发布标准。

## 13. M10：生产切换与 1.x 退役

### 首次切换

1. 发布 2.0 不可变镜像并完成 readiness/smoke。
2. 入口将新访问导向 2.0；1.x 使用独立地址保留。
3. 明确告知 1.x 临时房间不能跨到 2.0，或等待其自然过期。
4. 观察 room create/join、WS attach、peer connect、transfer completion 和 WebAssembly 加载。
5. 触发停止条件时直接把入口切回 1.x；不转换 2.0 数据库给 Bun。

### 停止条件

- 核心流程 smoke 失败。
- WebRTC 建连率或传输完成率显著低于 1.x 基线。
- 特定主流浏览器大面积失败。
- WASM 加载/初始化失败明显增长。
- SQLite error、hub queue saturation、进程重启或内存增长。
- 文件 hash 错误、错误文件下载或任何隐私/安全事件。

### 退役条件

- 2.0 覆盖完整业务周期并稳定。
- 最近一次回滚与恢复演练成功。
- 1.x 没有仍需处理的活跃临时房间。
- 文档、监控、值班和事故手册已切换。
- 1.x 代码删除作为独立提交/PR，不与首发切流合并。

## 14. 测试与 CI 最终形态

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --locked
cargo build -p p2p-server --release --locked
dx build --web --release
wasm-pack test --headless --chrome crates/browser-platform
python scripts/verify.py protocol
python scripts/verify.py e2e --browser chromium
python scripts/verify.py e2e --browser firefox
python scripts/verify.py e2e --browser webkit
python scripts/verify.py visual
python scripts/check-doc-links.py
git diff --check
```

说明：实际 WASM test runner 在 M2 根据 Dioxus 工具链确认；命令名称可以调整，但 browser-platform 必须有真实浏览器测试。

## 15. 推荐提交切片

1. `docs(rust): define 2.0 greenfield architecture and experience baseline`
2. `spike(web): prove dioxus webrtc data channel viability`
3. `chore(rust): scaffold workspace web server and ci`
4. `feat(domain): add session room and access state machines`
5. `feat(protocol): define v2 control and data channel frames`
6. `feat(server): add session room access and sqlite v2`
7. `feat(server): add realtime presence and signaling hub`
8. `feat(web): add room creation approval and peer flow`
9. `feat(transfer): add single receiver file pipeline`
10. `feat(transfer): add multi receiver outcomes and recovery`
11. `feat(web): complete visual accessibility and motion parity`
12. `test(release): add cross browser performance and security gates`
13. `build(deploy): publish isolated 2.0 release`
14. `refactor: retire 1.x after production observation`

每个提交/PR 必须写：用户可见结果、非目标、风险、验证命令、资源/协议变化和回退方式。

## 16. 第一批可执行任务

开始编码时只执行以下批次，不立即重写全部 UI：

### Batch A：体验基线

- 创建 M0 文档目录。
- 自动截取 1.x 三种 viewport 和核心状态。
- 补齐当前难以稳定进入的错误/恢复 fixture。
- 记录头像进入、dialog、toast、transfer 的动效参数。

### Batch B：Dioxus/WebRTC spike

- 创建隔离 spike crate，不连接当前生产 API。
- Dioxus 两端 + Axum signal + web-sys PeerConnection。
- 100 MiB 文件、BLAKE3、backpressure、cancel、cleanup。
- Chromium/Firefox/WebKit/relay 报告。

### Batch C：架构确认

- 根据 spike 结果提交 ADR：锁定 Dioxus，或切换 Leptos/Yew/React fallback。
- 只有 ADR 通过后才创建正式 workspace 和大规模 implementation backlog。

## 17. 2.0 完成定义

- 生产前端应用逻辑、共享协议、领域、传输和后端均由 Rust 实现。
- UI 的页面、视觉、响应式、动效、文案反馈和无障碍达到 M0 基线。
- 用户可以稳定创建/加入房间、批准接收者并完成多接收者文件传输。
- 文件字节不经过业务服务器，直接或经 TURN 在 WebRTC 数据面流动。
- 大文件发送有背压和内存上限，接收文件有完整性验证。
- Chrome、Firefox、Safari/WebKit 与真实移动设备通过发布矩阵。
- 领域、协议、服务端、WASM 平台层和端到端测试全绿。
- 可观察性、性能、安全、备份、部署和回滚演练完成。
- 2.0 独立生产观察期结束后，1.x 才被安全退役。
