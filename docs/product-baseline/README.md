# P2P Transmission 1.x 产品体验基线

本目录记录当前实现必须保持的用户体验结果。它不是旧代码或旧协议的兼容规范。

## 基线内容

- [页面与状态](states.md)
- [核心用户流程](flows.md)
- [动效](motion.md)
- [无障碍](accessibility.md)
- [性能与运行边界](performance.md)
- `screenshots/`：固定 viewport 下的视觉状态

## 刷新截图

截图采集默认跳过，避免普通 E2E 修改仓库文件。在仓库根目录运行：

```bash
CAPTURE_V1_BASELINE=1 bun run --cwd apps/web e2e v1-baseline.spec.ts
```

Windows 环境由 Python 包装环境变量：

```bash
python scripts/capture_v1_baseline.py
```

采集会启动内存数据库和隔离的两个 Chromium context，不使用生产数据。

## 使用方式

验收比较用户目标、页面语义和视觉结果，不比较：

- HTTP path、JSON 字段或 WebSocket frame。
- React/Dioxus 组件树。
- Bun/Rust 内部状态和数据库表。
- 随机头像、房间码和动态时间文本的逐像素值。

视觉差异必须先判断它是有意优化、平台渲染差异还是体验退化。所有有意改变都应在设计记录中说明。
