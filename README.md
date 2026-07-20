# P2P Transmission

P2P Transmission 是一个无需注册的临时点对点文本与文件传输工具。正式地址：
[https://p2p.yxswy.com](https://p2p.yxswy.com)。

当前生产版本使用 Rust：Axum 在唯一主入口 `/` 服务端渲染匿名大厅，浏览器随后接管独立的
Dioxus WebAssembly 交互岛，并通过 WebRTC DataChannel 传输正文。服务端首屏不读取房间、
Cookie 或浏览器会话状态；Axum 只处理临时会话、房间、加入审批、WebSocket 信令和短期
TURN 凭据，不接收或保存文本与文件正文。根路径 `/` 是唯一应用入口，其他 HTML 路径返回
404。

Axum SSR 只负责快速、稳定的匿名首屏，不尝试服务端渲染私密房间或 WebRTC 状态；它是当前
架构的一部分，不是旧前端兼容层。当前应用协议固定为 `5.1`，HTTP、WebSocket 和 DataChannel
只接受完全匹配的版本与字段集合；旧邀请 query、旧 Cookie、旧本地会话和旧恢复数据库均不会
被读取或迁移。

页面支持安装为 PWA，并缓存根应用壳层与当前版本浏览器资源；房间、信令和实际传输仍要求联网。
邀请链接始终由页面直接复制到剪贴板，不调用系统分享；收到文件请求或完成校验时可显示系统通知。

## 快速使用

1. 房主打开正式地址并创建房间。
2. 房主把邀请链接发给可信接收者；只有房间码时，接收者需要提交申请并等待房主批准。
3. 页面显示接收者已连接后，选择目标接收者并发送文本或文件。
4. 文本等待页面显示“已送达”；文件等待双方显示完成及 BLAKE3 校验结果后，再关闭标签页。

完整操作和故障处理见[普通用户指南](docs/user-guide.md)。

## 文件大小与浏览器边界

- 每批最多 10 个文件，总大小最多 5 GiB（5,368,709,120 字节），不是每个文件各 5 GiB。
- 单个不超过 100 MiB 的文件使用内存缓冲接收，可在 Chromium 和 Firefox 中使用。
- 超过 100 MiB 的单文件以及多文件批次使用流式写盘，接收端需要桌面版 Chrome 或 Edge，
  并在开始前选择目标文件或文件夹。
- 流式传输按分段确认进度，支持同页面断线、刷新、网络切换和系统休眠后的检查点恢复；
  仍应保留原文件，不要把临时传输当作备份。
- 无法直连时会使用 coturn 中继加密的 WebRTC 流量。大文件中继会消耗相同量级的公网流量，
  实际速度和费用取决于双方网络与服务器带宽。

5 GiB 桌面 Chromium 实盘门禁、恢复策略和已知限制见
[生产发布手册](docs/release/RELEASE.md#5-gib-文件边界)。

## 隐私与安全边界

- 房间码只是 6 位房间标识，不是加入凭据；房主仍需批准仅凭房间码提交的申请。
- 邀请链接包含加入 capability，应像一次性凭据一样只发给可信接收者，不要公开到日志、
  工单、群组或截图中。
- 文本和文件通过 WebRTC DataChannel 传输。TURN 只中继 DTLS 加密流量，Axum 和 SQLite
  不保存应用载荷。
- DTLS 保护传输中的内容，但当前匿名版本不提供独立的带外身份校验，也不把房间审批或邀请
  capability 描述为现实身份认证；高威胁场景应由双方通过独立渠道确认对方和邀请链接。
- 房间默认有效期为 6 小时。系统不提供账号、云端历史、匿名性或永久可用承诺。
- 生产运行单个 Axum 实例；SQLite 保存生命周期内的控制面状态，在线连接仍位于进程内存。
  服务重启会断开 WebSocket，浏览器会重新连接并恢复仍有效的会话。

## Rust 工程结构

```text
rust/apps/web                 Dioxus WebAssembly 前端
rust/apps/server              Axum 同源 Web/API/WebSocket 服务
rust/crates/browser-platform  浏览器、WebRTC 与流式文件系统适配
rust/crates/domain            房间与会话领域模型
rust/crates/protocol          HTTP、信令和 DataChannel 协议
rust/crates/transfer          分段、校验、背压与恢复状态机
rust/crates/ui-shell          Axum SSR 与 Dioxus Web 共用的匿名大厅组件
e2e                           当前 Rust Web 的 Playwright 浏览器验收
deploy/production             生产容器与 Nginx 配置
deploy/scripts                原子发布、SQLite 备份与回滚脚本
```

浏览器验收使用 Bun 安装 Playwright；Bun 不进入生产运行时或浏览器 bundle。

## 本地开发

需要 Rust 1.97、`wasm32-unknown-unknown` target 和 Dioxus CLI 0.7.6。仓库脚本负责构建前端
并由 Axum 同源提供：

```bash
python scripts/dev.py
```

默认本地地址是 `http://127.0.0.1:3410`。生产地址始终是
[https://p2p.yxswy.com](https://p2p.yxswy.com)，请勿把本地地址作为公开入口。

## 验证

```bash
python scripts/verify.py
python scripts/test_e2e.py
python scripts/test_e2e.py --interop
python -X utf8 -m unittest discover -s deploy/scripts -p "test_*.py"
git diff --check
```

`scripts/test_e2e.py` 默认只运行快速 Chromium smoke 层（页面壳、无障碍、房间码交互、
文本同意流与 128 KiB DataChannel 文件传输）。`--interop` 让 Firefox/WebKit 建立房间与
点对点连接、完成缓冲文件传输，并验证大文件不支持时的明确回退；
单浏览器性能基线、完整浏览器回归与压力测试必须显式运行：

```bash
python scripts/test_e2e.py --performance
python scripts/test_e2e.py --full
python -X utf8 scripts/test_large_file.py --size-gib 1 --profile baseline
```

性能契约记录导航、FCP、LCP、CLS 与 WASM 可交互标记，并对响应结束、DOM 可交互、
FCP、LCP、应用可交互和 `CLS <= 0.1` 设置宽松但可执行的发布上限。

完整验证覆盖 native/WASM 格式与 Clippy、Rust 单元/集成测试、release 构建、浏览器入口
gzip 体积预算、Chromium/Firefox/WebKit 浏览器矩阵、无障碍门禁、真实 DataChannel 传输
以及部署脚本。`Cargo.lock` 还会在 CI 中通过 RustSec 审计，已知漏洞、警告或前端体积回退
会阻止发布。

## 生产部署

`main` 分支的生产工作流在测试通过后构建固定版本镜像，通过 SSH 暂存到腾讯云，并保留
上一镜像、环境、Nginx、Compose 与数据库回滚状态。公网会实际验证健康检查、应用壳层、
CSS、启动脚本、Service Worker、哈希 JS 和 WASM；全部通过后才确认发布，否则自动回滚。
SQLite 一致性备份保留最近 10 份；定时维护还会用 age 加密后上传到独立 rclone 远端，
再实际下载、解密并执行一次性恢复演练。

公网端口：

- TCP `80`、`443`：HTTPS/WSS 和跳转。
- TCP/UDP `3478`：TURN。
- TCP `5349`：TURN TLS。
- UDP `49160-49259`：coturn relay 范围。

完整环境变量、备份、回滚和验收流程见
[生产发布手册](docs/release/RELEASE.md)。

## 故障排查

| 现象 | 处理方式 |
| --- | --- |
| 页面无法连接服务器 | 确认打开正式 HTTPS 地址；维护者检查 `/health/ready`、Nginx 和容器日志。 |
| 房间码无效或房间结束 | 创建新房间并发送新的邀请链接或房间码。 |
| 加入申请长时间等待 | 保持双方页面打开，让房主处理申请；失效后重新提交。 |
| 大文件接收按钮不可用 | 接收端改用桌面 Chrome 或 Edge，并允许页面选择目标文件或文件夹。 |
| 传输暂停或提示磁盘空间不足 | 释放足够空间、恢复文件权限后使用页面的继续操作；不要删除未完成目标文件。 |
| 两端一直连接中 | 切换稳定网络重试；维护者检查 TURN 域名、证书、端口与 UDP relay 范围。 |

当前视觉记录与发布资料位于 [发布文档索引](docs/release/README.md)。
