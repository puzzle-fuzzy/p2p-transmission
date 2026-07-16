# P2P Transmission

这里是与 1.x 独立的 Rust 正式工程。它保留产品体验与功能结果，不兼容旧 API、协议或数据库。

正式地址：[https://p2p.yxswy.com](https://p2p.yxswy.com)。生产部署与回滚步骤见[发布手册](../docs/release/RELEASE.md)。

## 当前版本

当前正式版本：

- Axum 原生 HTML 首页、按需加载的 Dioxus Web/WASM 房间应用与同源服务。
- 房间、邀请、加入审批、多人接收和 WebRTC 传输。
- 小文件内存接收，以及超过 100 MiB、最大约 5 GiB 的直接磁盘流式接收。
- 刷新、断网、系统休眠和浏览器后台恢复后的检查点续传。
- SQLite 控制面持久化、TURN 临时凭据、安全响应头、限流与健康检查。
- Chromium 桌面/移动端 E2E，以及 Firefox 的缓冲传输和大文件降级验证。

当前实现不兼容 1.x API、协议或数据库。大文件正文始终通过 WebRTC 传输，不经过 Axum 或 SQLite。

## 启动

```bash
python scripts/dev.py
```

默认构建 Dioxus release 资源并由 Axum 在 <http://127.0.0.1:3410> 同源提供。根路径由 Axum
直接返回可交互的原生 HTML，Dioxus 应用位于 `/app` 并只在创建、加入或恢复房间时加载。
release Web 资源不会注入依赖 `dx serve` 的开发遮罩。

如需单独检查 debug 构建：

```bash
python scripts/dev.py --profile debug --build-only
```

## 验证

```bash
python scripts/verify.py
python scripts/test_e2e.py
```

`verify.py` 覆盖 Rust 格式、native/wasm Clippy、测试、server release 和 Dioxus release 构建；浏览器 E2E 单独运行，便于 CI 分 job。

生产容器、环境变量、备份和回滚步骤见 [`../docs/release/RELEASE.md`](../docs/release/RELEASE.md)。
