# 发布与视觉记录

这里保存当前实现的固定视口截图，用于检查桌面端和移动端的页面结构、状态表达与视觉回归。

生产发布、5 GiB 边界、备份与回滚说明见 [`RELEASE.md`](RELEASE.md)。

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
python scripts/capture_shell.py
python scripts/test_e2e.py --capture-room --capture-transfer
```

截图只记录当前实现状态。视觉方向与交互原则以仓库根目录的 [`DESIGN.md`](../../DESIGN.md) 为准。
