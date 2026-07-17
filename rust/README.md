# P2P Transmission

这里是与 1.x 独立的 Rust 正式工程。它保留产品体验与功能结果，不兼容旧 API、协议或数据库。

正式地址：[https://p2p.yxswy.com](https://p2p.yxswy.com)。生产部署与回滚步骤见[发布手册](../docs/release/RELEASE.md)。

## 当前版本

当前正式版本：

- Axum 在根路径服务端渲染共享匿名大厅，Dioxus Web/WASM 交互岛在就绪后无闪烁接管。
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

默认构建 Dioxus release 资源并由 Axum 在 <http://127.0.0.1:3410> 同源提供。根路径 `/`
是唯一应用入口；Axum 启动时只渲染并组装一次公开大厅，浏览器状态留在独立 WASM 岛中。
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

`test_e2e.py` 默认只运行快速桌面 Chromium smoke 层。轻量性能基线、完整浏览器矩阵和 opt-in 大文件压力门禁分别运行：

```bash
python scripts/test_e2e.py --performance
python scripts/test_e2e.py --full
python -X utf8 scripts/test_large_file.py --size-gib 1 --profile baseline
```

`verify.py` 覆盖 Rust 格式、native/wasm Clippy、测试、server release 和 Dioxus release 构建；浏览器 smoke、性能基线、完整回归与压力门禁分层运行，避免日常检查误触耗时场景。性能基线只硬性约束结构与 `CLS <= 0.1`，其余耗时指标用于观察趋势。

生产容器、环境变量、备份和回滚步骤见 [`../docs/release/RELEASE.md`](../docs/release/RELEASE.md)。
