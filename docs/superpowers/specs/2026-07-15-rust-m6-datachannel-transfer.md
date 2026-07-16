# Rust M6：DataChannel 单文件传输结果

> 结论：**M6 单接收者垂直切片通过，可以进入 M7 完整体验等价。** TURN relay、Firefox/WebKit 与真实 Safari 仍是 M8 发布硬门禁，不在本阶段伪装完成。

## 1. 用户可见结果

两个已批准并在线的浏览器现在可以完成一条真实文件链路：

1. 发送者选择一个不超过 100 MiB 的文件；
2. 接收者看到文件名和大小，并明确接收或拒绝；
3. 双方显示发送/接收进度，传输期间可以取消；
4. 接收端收到完整字节后计算 BLAKE3；
5. 只有字节数和 BLAKE3 都匹配时，接收端才生成“保存文件”；
6. 发送端收到接收端完成确认后才显示发送完成；
7. 完成、拒绝或取消后，双方可以留在当前房间继续下一次传输。

页面仍保持 1.x 的深灰、紫色、细边框和紧凑信息层级，没有增加渐变、阴影、玻璃效果或装饰性动效。新增进度条只做 160ms 线性宽度过渡，并受 `prefers-reduced-motion` 约束。

## 2. 正式浏览器平台边界

`p2p-browser-platform::rtc` 接管了 spike 中可复用的浏览器能力：

- `RTCPeerConnection`、offer/answer 与 trickle ICE；
- ordered、reliable DataChannel；
- File slice、ArrayBuffer、Blob 与 object URL；
- BLAKE3 发送/接收校验；
- DataChannel 回调、PeerConnection、Closure、timer 与 object URL 清理；
- native stub，使 workspace 的本机检查仍可覆盖应用边界。

RTC 事件先封装为 Dioxus `Callback`，再进入组件 runtime，避免原生回调直接访问丢失 scope 的 signal。协议 `Signal` 在 Web 层显式别名为 `ProtocolSignal`，不会覆盖 Dioxus 的响应式 `Signal`。

## 3. 信令顺序与恢复

本阶段修复了两类只在快速重复双浏览器测试中出现的协商时序：

- `setLocalDescription` 可能先产生 ICE candidate。平台层现在先缓存本地 candidate，确保 offer/answer 已经通过 WebSocket 发出后再按顺序释放，远端不会把新候选误加到旧协商阶段。
- DataChannel 打开事件存在极小的注册竞态。安装回调后会同步检查 `readyState`，已经打开时补发一次 ready 事件。

发送端协商 3 秒未就绪时会检查通道真实状态；仍未就绪则清理旧 PeerConnection 并重试，最多两次。重试使用当前 `RtcPeer` identity 防止旧 timer 改写新房间，最终失败会给用户明确错误，不无限显示连接中。五轮连续重复的桌面传输用例为 15/15 通过，其中慢路径由自动重试恢复。

## 4. 文件协议与资源上限

正式链路复用 `p2p-protocol` 与 `p2p-transfer` 的约束：

- 一个 transfer manifest 在 M6 必须且只能包含一个文件；
- 单文件上限 100 MiB；
- 二进制 chunk header 使用 `P2P2` magic、协议版本、transfer/file ID、offset 与 payload length；
- chunk 为 64 KiB；
- DataChannel 发送缓冲高水位 4 MiB、低水位 1 MiB；
- 高水位暂停后优先等待 `bufferedamountlow`，并有 250ms 轮询兜底；
- 进度事件最短间隔 50ms，末块始终上报；
- 待处理 ICE signal 队列与传输状态都有限制，不无限增长。

接收端当前使用受 100 MiB 上限保护的 Blob fallback。多文件、拖拽、流式落盘和多接收者调度属于 M7/M8，不在 M6 页面中提前暴露。

## 5. 完整性与生命周期

发送端对原始 File 分块增量计算 BLAKE3，并在所有 chunk 发完后发送 `Complete(bytes, blake3)`。接收端按 offset 严格接收、拒绝乱序或越界 frame，随后比较：

- manifest 声明大小；
- 实际接收字节数；
- sender BLAKE3；
- receiver BLAKE3。

任何一项不一致都会发送协议错误且不创建下载地址。校验成功后接收端创建 object URL，向发送端回传完成确认。新下载替换旧下载、RTC reset、退出房间或组件 Drop 时都会 revoke object URL；DataChannel 和 PeerConnection 的事件处理器会在 close 前移除。

## 6. UI 状态

Dioxus `AppModel` 新增独立 RTC 与 transfer presentation state，覆盖：

- 等待接收者、正在建连、连接失败/断开；
- 选择文件、等待确认、收到请求；
- 发送/接收进度、等待完整性确认；
- 拒绝、取消、失败和完成；
- 接收端保存文件。

文件名使用单行省略并保留 title，大小独立显示；完成态只显示“校验通过”，完整 64 位 hash 放在 title 中。错误信息映射为中文用户提示，不向页面泄露 SDP、ICE、cookie 或 capability。

## 7. 自动化验证

Playwright 的独立 browser context 覆盖：

- 房间创建、申请、批准、双方 DataChannel ready；
- 128 KiB 多 chunk 文件发送、接收确认与实际下载字节比较；
- 同一房间连续发送 0 B、Unicode 文件名和未知 MIME 文件；
- 接收者拒绝后双方留在房间；
- 发送者在接收确认前取消；
- 100 MiB 上限文件发送、BLAKE3 完成确认、下载大小与流式 SHA-256 比较；
- desktop 1440px 与 mobile 390px；
- M5 房间恢复、头像单次入场、About/GitHub、readiness 和无水平溢出回归。

固定视觉截图：

- [发送者桌面端](../../release/screenshots/m6-transfer-owner-desktop-chromium.png)
- [接收者桌面端](../../release/screenshots/m6-transfer-receiver-desktop-chromium.png)
- [发送者移动端](../../release/screenshots/m6-transfer-owner-mobile-chromium.png)
- [接收者移动端](../../release/screenshots/m6-transfer-receiver-mobile-chromium.png)

通过的门禁：

```text
python -X utf8 scripts/verify.py
python -X utf8 scripts/test_e2e.py
```

Rust workspace 共 55 项测试通过；native/WASM strict Clippy、release server、Dioxus release build、TypeScript lint/typecheck、文档链接和 diff whitespace 均通过。标准 Playwright 矩阵为 13 passed、1 skipped；100 MiB 只在 desktop 执行，mobile 项明确跳过。额外协商压力回归为 15/15。

## 8. M7 起点

M7 将从“一个发送者到一个接收者的一份文件”扩展到完整体验矩阵：多接收者选择与独立结果、多文件、拖拽/粘贴、重试历史、房间过期/恢复、完整 dialog 焦点管理、Toast 时序与所有错误状态。视觉继续以 M0/1.x 基线逐项签收，不重新设计页面。
