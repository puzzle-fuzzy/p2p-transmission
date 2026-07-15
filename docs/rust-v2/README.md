# Rust 2.0 视觉记录

这里保存 Rust 2.0 各里程碑的固定视口截图，用于与 [`docs/product-baseline`](../product-baseline/README.md) 的 1.x 体验基线比较。

2.0 的生产发布、5 GiB 边界、备份与回滚说明见 [`RELEASE.md`](RELEASE.md)。

M2 当前截图：

- [`m2-shell-desktop-chromium.png`](screenshots/m2-shell-desktop-chromium.png)
- [`m2-shell-mobile-chromium.png`](screenshots/m2-shell-mobile-chromium.png)

M5 房间截图：

- [`m5-room-owner-desktop-chromium.png`](screenshots/m5-room-owner-desktop-chromium.png)
- [`m5-room-receiver-desktop-chromium.png`](screenshots/m5-room-receiver-desktop-chromium.png)
- [`m5-room-owner-mobile-chromium.png`](screenshots/m5-room-owner-mobile-chromium.png)
- [`m5-room-receiver-mobile-chromium.png`](screenshots/m5-room-receiver-mobile-chromium.png)

M6 单文件传输截图：

- [`m6-transfer-owner-desktop-chromium.png`](screenshots/m6-transfer-owner-desktop-chromium.png)
- [`m6-transfer-receiver-desktop-chromium.png`](screenshots/m6-transfer-receiver-desktop-chromium.png)
- [`m6-transfer-owner-mobile-chromium.png`](screenshots/m6-transfer-owner-mobile-chromium.png)
- [`m6-transfer-receiver-mobile-chromium.png`](screenshots/m6-transfer-receiver-mobile-chromium.png)

刷新命令：

```bash
python scripts/capture_v2_shell.py
python scripts/test_v2_e2e.py --capture-room --capture-transfer
```

截图只记录实现状态，不授权改变 1.x 的视觉方向。2.0 默认保持同样的页面气质和使用层级。
