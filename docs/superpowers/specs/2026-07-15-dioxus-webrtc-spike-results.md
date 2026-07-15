# Dioxus + Axum + WebRTC 技术验证结果

> 日期：2026-07-15<br>
> 分支：`rust-dev`<br>
> 结论：**有条件通过 M1，继续采用 Dioxus + Axum 进入 M2；真实 Safari 与 TURN relay 仍是生产前硬 gate。**

## 1. 验证目的

本次 spike 不复用 1.x API 或前端组件，只回答一个问题：Dioxus/WASM 能否在保持平台边界可控的前提下，完成浏览器间的 WebRTC 建连、文件分片、背压和完整性校验。

实现位于 [`spikes/dioxus-webrtc`](../../../spikes/dioxus-webrtc/README.md)，产品体验基线位于 [`docs/product-baseline`](../../product-baseline/README.md)。

## 2. 固定技术栈

| 组件 | 验证版本/配置 |
| --- | --- |
| Rust | 1.97.0，edition 2024 |
| Dioxus / CLI | 0.7.6 |
| Axum | 0.8.9 |
| `web-sys` | 0.3.103 |
| DataChannel | ordered + reliable |
| 文件分片 | 64 KiB |
| 发送背压 | high 4 MiB / low 1 MiB |
| 接收内存硬上限 | 128 MiB（仅 spike） |

## 3. 已证明的链路

- Axum WebSocket 按 room/peer 转发 offer、answer 和 trickle ICE。
- 两个独立浏览器 context 能建立真实 `RTCPeerConnection` 和 DataChannel。
- 文本可双端传递。
- 文件按 `File.slice → ArrayBuffer → DataChannel → Blob` 传递。
- 接收端按实际字节重算 BLAKE3；校验一致后才生成下载。
- 发送循环监测 `buffered_amount`，超过 high watermark 后暂停继续读取。
- 页面退出和重新连接路径会关闭 DataChannel、PeerConnection、WebSocket，并释放 object URL。
- Serde 共享协议 crate 能在 native Rust 中测试；浏览器专属 `JsValue`/`Closure` 集中在 Web 平台模块。

## 4. 自动化结果

| 场景 | 结果 | 观测 |
| --- | --- | --- |
| 1.x 既有 E2E | 通过 | 3/3 |
| 1.x 视觉基线采集 | 通过 | 13 张核心状态截图 |
| Chromium，8 MiB | 通过 | BLAKE3 一致；本轮峰值 `buffered_amount` 196,608 B |
| Firefox，8 MiB | 通过 | BLAKE3 一致；峰值 `buffered_amount` 65,536 B |
| Chromium，100 MiB | 通过 | BLAKE3 一致；本轮峰值 262,144 B；重复运行最高观测 4,206,096 B，均小于 5 MiB 测试上限 |
| Windows Playwright WebKit | 跳过 | 运行时未暴露 `RTCPeerConnection`，无法代表真实 Safari |

100 MiB 在一次较慢的运行中达到 4,206,096 B，越过 4 MiB high watermark 后仍保持在测试上限内；本地 loopback 较快时峰值会明显更低。结果证明当前发送队列没有按文件大小线性堆积，但 M6 仍需加入可重复的慢接收端测试。当前接收端仍因 Blob 下载持有全部 chunk，因此这项结果只证明发送侧有界，不等于正式版已经解决大文件接收内存问题。

## 5. 工程发现

1. WebRTC 连接状态和 DataChannel 状态必须分开建模。`PeerConnection::Connected` 不等于通道已可发送，UI 与测试都应以 channel open 作为发送能力的权威状态。
2. `web-sys` 的 offer/answer Promise 返回 JavaScript dictionary。平台层先显式检查 `sdp` 字段，再做窄范围 unchecked cast；这一转换不得扩散到 UI 或领域代码。
3. Playwright 的内存 buffer 上传有 50 MiB 限制。大文件测试改用操作系统临时文件，并在测试结束删除，避免测试工具自身成为错误瓶颈。
4. spike 的背压用短间隔异步轮询验证 high/low watermark。正式平台层应使用 `bufferedamountlow` 事件唤醒，并保留超时兜底。
5. Windows Playwright WebKit 缺少 WebRTC 能力。必须在 macOS Safari 和至少一台真实 iOS 设备运行同一行为断言，不能把“测试跳过”解释为兼容性通过。

## 6. 决策

继续使用以下 2.0 方向：

- 前端：Dioxus Web/WASM。
- 控制面与 signaling：Axum。
- 共享领域与协议：纯 Rust crates。
- 浏览器能力：单独的 `browser-platform` crate，限制 `web-sys` 和 JS interop 的传播范围。
- 产品验收：复用 Playwright 进行跨浏览器行为和视觉验证，但它不进入生产 bundle。

当前没有证据要求切换到 Leptos、Yew 或 React fallback。Dioxus 已经证明能承载最危险的浏览器链路；后续框架风险主要转为生命周期、可维护性和产品规模下的性能，需要在 M5/M6 的正式 vertical slice 中继续验证。

## 7. 进入 M2 的条件与遗留 gate

可以立即进入 M2，建立正式 Rust workspace、CI、AppShell 与 health endpoint。以下事项仍必须在相应阶段关闭：

- 在真实 Safari/macOS 与 iOS 上完成文本、8 MiB、100 MiB、取消和清理验证。
- 使用 coturn 强制 relay，验证 TURN credential、超时和失败反馈。
- 将背压从轮询改为 `bufferedamountlow` 事件驱动。
- 接收端优先流式落地；Blob fallback 设置明确 capability 和大小限制。
- 完成流式接收后再验证 1 GiB，避免用扩大内存上限伪造通过。
- 增加主动取消、一端刷新、慢接收者、hash mismatch 和资源泄漏自动化。

真实 Safari 或 TURN 若暴露阻断性差异，先在独立 spike 中解决；不能在正式产品组件里堆叠浏览器特判。

## 8. 可复现命令

```bash
cargo fmt --manifest-path spikes/dioxus-webrtc/Cargo.toml --all -- --check
cargo test --manifest-path spikes/dioxus-webrtc/Cargo.toml -p p2p-spike-protocol -p p2p-spike-server --locked
cargo clippy --manifest-path spikes/dioxus-webrtc/Cargo.toml -p p2p-spike-protocol -p p2p-spike-server --all-targets -- -D warnings
cargo clippy --manifest-path spikes/dioxus-webrtc/Cargo.toml -p p2p-spike-web --target wasm32-unknown-unknown -- -D warnings
# M1 spike 从 spikes/dioxus-webrtc/web 目录执行：
dx build --web --release --debug-symbols false --locked
python scripts/test_rust_spike.py --file-mib 8 --browser all
python scripts/test_rust_spike.py --file-mib 100 --browser chromium
python scripts/check-doc-links.py
git diff --check
```

## 9. 下一步

M2 创建正式的 `apps/server`、`apps/web`、`crates/domain`、`crates/protocol`、`crates/transfer` 和 `crates/browser-platform`，并把 spike 作为参考保留，不直接复制成产品目录。第一条正式 vertical slice 仍只包含 AppShell、Axum health、同源静态资源和完整 CI，不提前混入房间业务。
