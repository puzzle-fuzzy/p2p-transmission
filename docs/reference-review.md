# WebRTC 参考材料对照与采纳记录

本文记录此前规划文档与 `webrtc/samples` 对当前项目的适用性判断。原始规划材料已从仓库移除，
因此本文只保留可复核的采纳依据，避免后续再次把教学样例、愿景文档和生产约束混在一起。

## 参考范围

- 规划文档：此前审查过的 V1.0–V4.1 规划材料；原始文件不再作为仓库内容分发。
- 官方样例：[`webrtc/samples`](https://github.com/webrtc/samples)，审查时固定在提交
  `6e2c5a117aa860d66d874f7c0df0ef9a3e2cd74e`（2026-07-14）。
- 当前实现：Rust/Axum 控制面、Dioxus WebAssembly 客户端、WebRTC DataChannel 数据面、
  coturn、SQLite 控制面持久化、Playwright 浏览器与公网发布门禁。

官方样例是单 API 教学材料，不承担房间权限、协议版本、负载上限、断线恢复、流式写盘或生产
运维职责。本次只复用行为模式，没有复制样例代码。

## 已采纳

| 参考中的优质部分 | 当前项目判断 | 本次处理 |
| --- | --- | --- |
| 在 `setLocalDescription()` 完成后发送浏览器实际采用的 `localDescription` | 比发送 `createOffer()` / `createAnswer()` 的原始返回值更贴近浏览器最终协商状态 | Offer 和 Answer 均改为在设置本地描述后读取规范化 SDP；现有 negotiation id、epoch 和候选队列继续隔离陈旧异步结果 |
| 依据 SCTP 消息边界控制 DataChannel 单条消息大小 | 规划文档建议的 1–4 MiB chunk 不适合作为跨浏览器默认值；官方 datachannel 样例会受 `maxMessageSize` 约束 | 默认 payload 从 64 KiB 收紧到 32 KiB，并增加“协议头 + payload 不超过保守 64 KiB 边界”的跨层测试；协议仍可接收不超过现有限额的合法帧 |
| `bufferedAmount` 高低水位与 `bufferedamountlow` 恢复发送 | 是必要的内存与主线程保护 | 当前实现已经具备 4 MiB / 1 MiB 水位、事件唤醒、竞态后二次检查和超时兜底，保留现状 |
| 通过候选与 `getStats()` 验证 TURN，而不是只看“连接成功” | 对生产网络诊断有直接价值 | 当前公网门禁已强制 `iceTransportPolicy=relay`，检查 relay candidate 和 stats 后完成真实文件、文本传输，保留现状 |
| 明确区分通道加密与身份可信 | 参考安全文档提出了身份层目标，但其“AES-GCM + 安全交换”没有给出可验证的密钥认证协议 | README 与用户指南补充当前匿名版本的边界：DTLS 保护传输内容，邀请 capability / 房主审批控制加入，但不等于独立的现实身份认证 |
| 网络中断后恢复传输 | 正确，但不能只写“ICE Restart”而忽略应用状态 | 当前实现重建 PeerConnection、刷新短期 TURN 配置，并以 8 MiB segment 的 BLAKE3 检查点恢复流式传输；比直接调用 `restartIce()` 更符合当前单一发起方模型 |

## 保留当前设计，不照搬

### 协商模型

`perfect-negotiation` 适用于双方都可能触发 `negotiationneeded` 的对称媒体应用。当前产品由房主
单向创建 DataChannel 和 Offer，接收者只回答；同时使用 negotiation id、connection epoch、
远端描述状态和有界 ICE 队列处理乱序及陈旧结果。直接引入 polite/impolite 双方协商会增加第二套
状态机，现阶段没有收益。若未来允许双方动态创建通道或加入音视频，再重新评估。

### ICE 恢复

参考材料倾向在原连接上执行 ICE Restart。当前项目在失败后重建 PeerConnection，可同时替换已经
轮换的短期 TURN 凭据，并把 DataChannel 生命周期与应用检查点恢复放在同一个 generation 边界内。
这不是遗漏，而是有意选择。只有实测证明重建连接显著慢于 ICE Restart 时才值得增加双路径。

### 大文件协议

规划文档提出 1 MiB chunk、chunk 状态数组和 SHA-256。当前实现采用更保守的 32 KiB DataChannel
payload、8 MiB 提交段、16 MiB 确认窗口、逐段及整文件 BLAKE3，并直接写入用户选择的目标文件。
它能避免巨大消息的互操作风险，也不会为 5 GiB 文件发送庞大的离散 chunk 位图，因此保留当前协议。

### 服务端扩展

Redis、多信令节点、多地域 STUN/TURN 只有在单实例容量、地域连接成功率或 TURN 成本数据触发阈值
后才有价值。当前单 Axum 实例、SQLite 控制面和进程内在线连接是明确部署边界，不能仅因路线文档
提到“生产”就提前分布式化。

## 暂不采纳或拒绝

- **1–4 MiB DataChannel 消息**：与官方样例的 `maxMessageSize` 约束冲突，也会放大内存峰值和
  浏览器间差异。
- **仅增加 AES-GCM 就宣称更强端到端身份安全**：没有经过认证的密钥交换或带外安全码时，额外
  加密层不能解决恶意信令方替换密钥的问题。
- **“WebRTC 保证 P2P”**：TURN relay 仍是 WebRTC 的正常路径；准确表述应是正文不进入应用
  服务器，必要时由 TURN 中继加密流量。
- **现在引入 Tauri、移动端、QUIC、iroh 或 AI 选路**：这些是独立产品阶段，不应混入当前 Web
  版本的正确性改造。
- **没有测量依据的连接成功率、10 GiB/几十 GiB 或数千连接承诺**：只保留能由现有压力、浏览器
  和公网门禁复现的指标。

## 后续触发条件

以下工作有价值，但需要观测数据或产品范围变化后再启动：

1. 如果公网失败仍难定位，在客户端增加非敏感 ICE candidate error 诊断，并只记录错误码、
   transport 和服务器标识，不记录邀请、TURN 凭据或地址详情。
2. 如果需要向用户明确展示直连或中继，复用公网 E2E 已有的 selected candidate pair 解析，只展示
   `direct` / `relay`，不展示 IP。
3. 如果双方都能主动创建通道或加入媒体轨道，改用完整 Perfect Negotiation，并增加 glare、rollback
   和乱序 candidate 浏览器测试。
4. 如果威胁模型包含不可信信令服务，先设计可比较的短认证码或其他经过认证的密钥交换，再讨论
   应用层加密；不能从“再包一层 AES”开始。

## 验证要求

本记录关联的实现改动必须至少通过：

```bash
python scripts/verify.py
python scripts/test_e2e.py
python scripts/test_e2e.py --interop
git diff --check
```

涉及 TURN、候选策略或生产配置时，还必须执行公网强制 relay 门禁，不能用本机直连结果替代。
