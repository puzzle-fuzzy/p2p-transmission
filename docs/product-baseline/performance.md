# 性能与运行边界基线

## 当前明确边界

- 房间默认有效 30 分钟。
- 单批最多 10 个文件。
- 单批总大小最多 100 MiB。
- 文件和粘贴文本通过 WebRTC DataChannel；API 不接收业务载荷。
- 网络不能直连时允许使用 TURN relay。

## 已验证基线

- 2026-07-15，本地 Chromium、内存 SQLite、无 STUN/TURN：
  - 3 个真实浏览器 E2E 全部通过。
  - 总耗时约 12.5 秒。
  - 覆盖双 context 审批、粘贴文本、文件接收、定向和广播。

该数字只用于发现明显回归，不是线上 SLO，也不代表公网吞吐。

## 需要补齐的测量

- HTML shell 可见时间、WASM 下载/编译/ready 时间。
- 创建房间、批准加入、WebSocket attach 和 PeerConnection connected 延迟。
- direct 与 TURN relay 的 1 MiB、100 MiB、1 GiB 吞吐。
- 发送/接收 CPU、WASM memory、JS heap、主线程长任务。
- `buffered_amount` 达到 high watermark 后的暂停与恢复。
- 取消、失败、退出房间后的内存和资源回落。
- 2C2G 目标机的 Axum/SQLite 并发、soak 和重启恢复。

## 发布预算原则

- 预算以 M1 spike 实测结果锁定，不预先虚构一个数字。
- WASM 体积、首次 ready、建连和传输任一明显差于 1.x，都必须解释并修复或得到明确接受。
- “Rust 更快”不是性能证据；只接受同设备、同浏览器、同网络条件下的测量。
