# Rust M2 工程基线结果

> 日期：2026-07-15<br>
> 分支：`rust-dev`<br>
> 结论：**M2 通过，可以进入 M3 domain/protocol 状态机设计与实现。**

## 1. 交付范围

M2 建立了不依赖 Bun 生产服务的正式 Rust 工程：

- 根 Cargo workspace、`Cargo.lock` 与 Rust 1.97.0 固定工具链。
- [`rust/apps/web`](../../../rust/apps/web/Cargo.toml)：Dioxus Web/WASM AppShell。
- [`rust/apps/server`](../../../rust/apps/server/Cargo.toml)：Axum health、build metadata、SPA fallback 与同源静态资源。
- `domain`、`protocol`、`transfer`、`browser-platform`、`test-support` 独立 crates。
- Python 开发、验证、E2E 与截图脚本。
- native、wasm、E2E 三个独立 GitHub Actions jobs。

1.x React/Bun 代码继续保留为产品基线；2.0 位于独立 `rust/` 命名空间，不复用旧 API、协议或数据库。

## 2. 运行边界

Axum 当前提供：

- `GET /health/live`：进程存活。
- `GET /health/ready`：返回共享协议定义的 readiness JSON。
- `GET /api/meta`：产品、版本和 API major。
- 其他应用路由：Dioxus `index.html` fallback。

Dioxus 通过 `browser-platform` crate 请求同源 `/health/ready`；UI 和领域层不直接处理 `JsValue`。默认开发脚本使用 release Web 资源，因为独立于 `dx serve` 托管 debug 资源会注入延迟出现的开发重建遮罩。

## 3. 视觉约束

M2 AppShell 直接对齐 1.x 首页基线：

- `#2d2d2d` 纯色背景。
- 居中 `384px` 窄栏与相同移动端边距。
- 六位房间码格、44px 按钮、低对比说明文字和底部 About/GitHub。
- 仅保留状态脉冲、dialog/scrim 的短时 transform/opacity 动效。
- `prefers-reduced-motion` 下关闭非必要动效。

房间表单在 M2 明确显示为未接入，不伪造可用功能。截图见 [`docs/release`](../../release/README.md)。后续默认保持这一视觉语言，不进行未经确认的自由改版。

## 4. 验证结果

| Gate | 结果 |
| --- | --- |
| Rust format | 通过 |
| Native Clippy `-D warnings` | 通过 |
| Native tests | 7/7 通过 |
| WASM/browser-platform Clippy | 通过 |
| Axum release build | 通过 |
| Dioxus release build | 通过 |
| Desktop Chromium AppShell E2E | 通过 |
| 390px Chromium AppShell E2E | 通过 |
| 应用内真实浏览器检查 | About、readiness 刷新通过；console error 为零 |
| 文档链接 / `git diff --check` | 通过 |

E2E 同时检查 heading/landmark、GitHub 链接、About dialog、同源 health JSON、服务重新检查和横向溢出。

## 5. 复现

```bash
python scripts/dev.py
python scripts/verify.py
python scripts/test_e2e.py
python scripts/capture_shell.py
```

完整启动和目录说明见 [`rust/README.md`](../../../rust/README.md)。

## 6. 下一步

M3 先实现纯 Rust 的 session、room、membership、join request 与 transfer 状态机，再扩展 wire protocol。此阶段仍不接数据库或完整页面，优先锁定状态转移、幂等行为、版本字段、解析上限和 property tests。
