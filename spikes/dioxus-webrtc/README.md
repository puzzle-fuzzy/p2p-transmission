# Dioxus + Axum + WebRTC 技术验证

这个 spike 只验证 WebRTC 的最高风险边界，不是正式产品实现。

## 当前验证内容

- Dioxus Web/WASM 页面。
- Axum WebSocket signaling relay。
- 两个浏览器之间的 offer/answer/trickle ICE。
- ordered/reliable DataChannel。
- 文本消息。
- File slice → ArrayBuffer → DataChannel → Blob download。
- BLAKE3 完整性校验。
- `buffered_amount` high/low watermark 背压。
- 取消和浏览器资源释放入口。

## 启动

终端一：

```bash
cargo run --manifest-path spikes/dioxus-webrtc/Cargo.toml -p p2p-spike-server
```

终端二：

```bash
cd spikes/dioxus-webrtc/web
dx serve --web --addr 127.0.0.1 --port 8080 --open false
```

在两个独立浏览器 context 打开 <http://127.0.0.1:8080>，使用相同 room，先后点击连接。
第一个 peer 会在第二个 peer 加入后发起 WebRTC offer。

自动化验证：

```bash
python scripts/test_rust_spike.py --file-mib 8 --browser all
python scripts/test_rust_spike.py --file-mib 100 --browser chromium
```

测试使用合成字节，不读取或上传用户文件。

Windows Playwright WebKit 当前不暴露 `RTCPeerConnection`，测试会通过 capability detection
明确跳过。它不能代替 Safari 验收；真实 Safari 必须在 macOS/iOS 设备或 runner 上单独通过。

## 限制

- signaling server 只适合本地 spike，没有认证、持久化和生产限流。
- 当前接收端为了生成 Blob 下载会在 128 MiB 上限内保留 chunk；正式版需要 capability detection 和流式落地方案。
- 当前背压使用 high/low watermark 的异步轮询；正式平台层将切换为 `bufferedamountlow` 唤醒并保留超时兜底。
- 本地默认没有 STUN/TURN；公网/relay 验证需要显式 RTC 配置。
