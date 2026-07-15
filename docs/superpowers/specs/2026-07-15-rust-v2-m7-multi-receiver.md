# Rust 2.0 M7：多接收者传输阶段结果

> 结论：**M7 的多接收者底座与定向/广播垂直切片通过。** 后续已完成最多 10 文件、5 GiB 流式写盘、同页面恢复和发送/接收页刷新恢复；粘贴文本与重试历史仍待补齐。

## 1. 用户可见结果

- 一个房间可以同时为多位在线接收者建立独立 WebRTC DataChannel。
- 发送者可以在熟悉的扁平弹层中全选、清空或逐位选择接收者。
- 只选择一人时，其他接收者不会收到文件请求；选择全部后，每位接收者独立确认。
- 完成、拒绝、取消和失败按接收者分别展示，一个人的结果不会终止其他人的传输。
- 多接收者展示聚合进度和本轮结果摘要，单接收者原有标题、下载和校验体验保持不变。

界面继续使用 1.x 的深灰背景、紫色主操作、细边框、系统字体和不超过 12px 的圆角。没有新增渐变、阴影、玻璃效果或装饰性动效；状态变化只沿用 160ms 过渡与既有 reduced-motion 规则。

## 2. 多 peer 运行时

Dioxus Web 不再持有一个全局 `RtcPeer`，而是使用以远端 `peer_id` 为键的 peer 集合：

- offer/answer、ICE、DataChannel 与传输状态按远端隔离；
- 信令只路由给房间快照中允许的远端 peer；
- 新接收者上线后创建自己的连接，掉线只清理对应连接；
- 单 peer 最多重试两次，失败不会 reset 其他已就绪 peer；
- UI 继续保留聚合 RTC 状态，同时使用 per-peer ready 状态决定所选接收者能否发送。

页面刷新快照后会立即同步 peer 集合，避免“房间显示两人、RTC 只连接一人”的陈旧状态。

## 3. 独立传输与结果

同一个浏览器 `File` 句柄会克隆给每个被选择的 `RtcPeer`，每位接收者获得独立 transfer ID、接受决定、进度、BLAKE3 完成确认和终态。发送方只聚合展示，不把多个接收者压成一个协议传输，因此：

- 定向发送不会向未选中的 DataChannel 写 manifest；
- 一位接收者拒绝时，其他接收者仍可继续接收和校验；
- 取消会逐一通知本轮仍活跃的 peer；
- 聚合进度按每个接收者的总字节数计算，不会因一人完成而虚报 100%。

## 4. 加入申请竞态修复

真实三浏览器测试暴露并修复了两处时序问题：

1. 第一项批准已通过实时消息生效，但 HTTP 收尾尚未完成时，第二项申请曾显示可点击却被全局锁静默丢弃。现在锁定期间按钮明确显示“处理中”，`JoinDecided` 到达后立即释放。
2. 新成员通过异步 bootstrap 才进入本地快照时，刷新完成后曾未同步 RTC peer 集合。现在快照刷新和 peer 同步连续执行。

这两项修复同样改善了快速连续批准、上线和恢复场景。

## 5. 自动化验证

新增三独立 browser context 用例：

1. 两位接收者依次申请并获批准；
2. 发送者取消选择第二位，只向第一位发送；
3. 确认第二位没有收到请求；
4. 再次选择全部并广播；
5. 第一位完成、第二位拒绝；
6. 发送者同时看到“已完成”和“已拒绝”的独立结果。

该流程在 1440px desktop 与 390px mobile 均通过。固定视觉截图：

- [接收者选择器（桌面）](../../rust-v2/screenshots/m7-recipient-picker-desktop-chromium.png)
- [接收者选择器（移动）](../../rust-v2/screenshots/m7-recipient-picker-mobile-chromium.png)
- [独立结果（桌面）](../../rust-v2/screenshots/m7-multi-result-desktop-chromium.png)
- [独立结果（移动）](../../rust-v2/screenshots/m7-multi-result-mobile-chromium.png)

本批通过：

```text
cargo test -p p2p-web                         # 3 passed
cargo clippy -p p2p-web --target wasm32-unknown-unknown -- -D warnings
python -X utf8 scripts/test_v2_e2e.py         # 15 passed, 1 skipped
```

100 MiB desktop 实际下载大小和 SHA-256 回归继续通过；mobile 仍按既有策略明确跳过该大文件压力项。

## 6. 后续进展

用户将目标文件体积提高到约 5 GB 后，多文件页面实现先暂停，避免继续固化内存接收模型。协议底座已新增 `buffered` 与 `streamed` 两种明确模式、5 GiB streamed 总量上限、分段提交/ACK、恢复游标和逐文件完成摘要，详见 [5 GiB 流式传输协议底座](./2026-07-15-rust-v2-m7-large-file-protocol.md)。

该路径现已完成桌面 Chromium 单文件、1/5 GiB 实盘压力、同页面 DataChannel 恢复和最多 10 文件批次。批量传输使用一个 manifest、逐文件 writer/摘要/恢复游标；真实断线测试证明已完成文件不会重传。完整结果见 [5 GiB 与批量流式传输记录](./2026-07-15-rust-v2-m7-large-file-protocol.md)。选择器和结果区只扩展必要信息，继续保持当前视觉方向。
