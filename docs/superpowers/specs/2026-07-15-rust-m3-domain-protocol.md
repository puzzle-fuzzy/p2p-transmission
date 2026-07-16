# Rust M3：Domain 与共享协议结果

> 日期：2026-07-15<br>
> 分支：`rust-dev`<br>
> 结论：**M3 通过，可以进入 M4 Axum 控制面。**

## 1. 本阶段边界

M3 只建立纯 Rust 领域规则、传输计算和 wire contract，不接 SQLite、不启动真实 WebSocket hub，也不修改 Dioxus 页面样式。2.0 前端继续严格沿用 1.x 的页面结构、视觉和克制动效。

## 2. Domain 模型

`p2p-domain` 不依赖 serde、Axum、数据库或浏览器 API。它包含：

- `SessionId`、`RoomId`、`RoomCode`、`PeerId`、`RequestId`、`TransferId`、`FileId` 强类型 ID。
- `EpochMillis`、`DurationMillis`、`Revision`，以及可注入 `Clock`、`IdGenerator`、`RandomSource`。
- session 过期状态机。
- room、membership、join request 与 presence 状态机。
- sender/receiver 分离的文件传输状态机。

### 2.1 房间不变量

- room revision 只在用户可见状态实际变化时增加一次。
- join request 的批准、拒绝、取消和过期是终态，不能反转。
- 重复 request/decision/cancel/complete 返回幂等结果，不重复产生事件。
- attach generation 防止旧连接的 detach 把新连接错误标记为离线。
- room 过期后拒绝新的业务命令。
- 每个状态变化后都可运行 `verify_invariants` 检查成员、请求、owner 和 revision 一致性。

### 2.2 传输不变量

- manifest 最多 10 个文件、总计最多 100 MiB，并拒绝重复 file id。
- 每个 receiver 有独立状态与 outcome；sender summary 只做聚合，不覆盖单个接收方结果。
- progress 必须单调且不得超过 manifest 总大小。
- completed、rejected、cancelled、failed 均为不可逆终态。
- 重放同一个 terminal 命令不会重复生成事件。

## 3. 共享协议

`p2p-protocol` 使用独立 wire DTO，不让序列化格式污染领域模型。M4 的 Axum boundary 将负责在 DTO 与 domain newtype 之间转换。

### 3.1 HTTP

- session、create room、request join、decide join、leave room 请求 DTO。
- session 和 room bootstrap 响应 DTO。
- 统一 `ErrorEnvelope` 与有限错误码集合。
- `parse_http_body` 在反序列化前执行 64 KiB body 上限，再校验版本和字段约束。

### 3.2 WebSocket realtime

- client：attach/detach、signal、heartbeat、event ack。
- server：attached/snapshot、join、presence、signal、room expired、error。
- JSON frame 最大 64 KiB，SDP/ICE signal 最大 32 KiB。
- 所有消息包含显式 `ProtocolVersion { major, minor }`；当前为 `2.0`，major 必须匹配，minor 不得高于当前实现。

### 3.3 DataChannel

- JSON control：manifest、decision、start、cancel、complete、error。
- 固定 53-byte binary chunk header：magic、协议版本、frame type、transfer id、file id、offset、payload length。
- 单 chunk 最大 64 KiB；decoder 校验 magic、版本、类型、长度和 offset overflow。
- control frame 在解析前限制为 64 KiB。

黄金样例作为独立 fixture 保存在 `rust/crates/protocol/tests/fixtures`，用于锁定 HTTP、WebSocket 与 DataChannel JSON 的编码结果。

## 4. Transfer 计算层

`p2p-transfer` 现在包含：

- high/low watermark 背压策略。
- 对零长度、尾块、超大 `u64` 文件都安全的 `ChunkPlan`。
- 单调、有上界、重复更新幂等的 `ProgressCounter`。

分片规划使用 checked arithmetic，生成式测试验证首块从 0 开始、尾块精确落在 total bytes、越界索引无结果。

## 5. 验证结果

核心 M3 测试共 32 项：

| crate | 测试 | 覆盖重点 |
| --- | ---: | --- |
| `p2p-domain` | 15 | ID/时间、session、room/join/presence、transfer 状态机、生成式命令序列 |
| `p2p-protocol` | 12 | HTTP/WS/DataChannel、黄金样例、大小/版本限制、任意输入不 panic |
| `p2p-transfer` | 5 | 背压、分片边界、进度、生成式覆盖 |

执行 gate：

```text
cargo fmt --all -- --check
cargo clippy -p p2p-domain -p p2p-protocol -p p2p-transfer --all-targets --locked -- -D warnings
cargo test --workspace --locked
cargo clippy -p p2p-browser-platform -p p2p-web --target wasm32-unknown-unknown --locked -- -D warnings
cargo build -p p2p-server --release --locked
python -X utf8 scripts/dev.py --profile release --build-only
python -X utf8 scripts/test_e2e.py
```

最终执行结果：上述工程 gate 全部通过；全工作区 native 共 35 项测试通过，Dioxus WASM release 构建成功，桌面与移动 Chromium 共 2 项 ?? shell E2E 通过，28 个仓库内文档链接通过检查。

## 6. M4 起点

下一阶段将从全新 SQLite schema 与 repository transaction boundary 开始，再把这些状态机接到 Axum HTTP API 和 bounded WebSocket hub。M4 不复用 1.x 数据库、接口或 Bun 服务，也不改变既有前端样式。
