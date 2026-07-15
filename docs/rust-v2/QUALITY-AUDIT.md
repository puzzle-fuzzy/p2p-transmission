# Rust 2.0 发布质量审计

审计日期：2026-07-16
审计对象：`https://p2p.yxswy.com` 与 `rust-dev` 分支
状态：修复前基线；完成修复后将在本文追加复验结果。

## Anti-Patterns Verdict

**通过。界面没有明显的 AI 生成式视觉特征。** 当前实现保持了 1.x 的深色工具型基线，没有渐变文字、玻璃拟态、营销式卡片、无意义大标题或弹跳动效。视觉系统克制且与产品任务匹配。

## Audit Health Score

| # | Dimension | Score | Key Finding |
|---|---|---:|---|
| 1 | Accessibility | 2/4 | 初始页自动化得分 95，但模态框缺少完整焦点管理，文档语言缺失，焦点轮廓对比不足 |
| 2 | Performance | 2/4 | Lighthouse 74；1.3 MB WASM 未压缩、无长期缓存，空 HTML 根节点使 LCP 达 8.2 s |
| 3 | Responsive Design | 3/4 | 桌面与 390 px 布局稳定；少量交互目标仅 40 px |
| 4 | Theming | 3/4 | 核心 token 完整且深色主题符合基线；仍有 28 个散落的颜色字面量 |
| 5 | Anti-Patterns | 4/4 | 无明显 AI slop，动效克制且只使用 transform/opacity |
| **Total** | | **14/20** | **Good — 解决 P1 后可达到发布级质量** |

## Executive Summary

- Audit Health Score：**14/20（Good）**
- 问题计数：**P0 0 / P1 6 / P2 6 / P3 1**
- Lighthouse：Performance **74**、Accessibility **95**、Best Practices **100**
- 关键性能指标：FCP **1.2 s**、LCP **8.2 s**、TBT **0 ms**、CLS **0.01**、总传输 **1,337 KiB**
- RustSec：**407 个依赖，0 个漏洞，0 个警告**

## Detailed Findings by Severity

### P1 Major

#### [P1] 模态框没有完整的键盘焦点生命周期

- **Location**：`v2/apps/web/src/main.rs` 中 TransferRequestDialog、RecipientPickerDialog、JoinRequestDialog、ShareDialog、AboutDialog
- **Category**：Accessibility
- **Impact**：键盘和读屏用户打开弹窗后，焦点可能留在背景页面，Tab 可继续访问被遮挡的控件，关闭后也无法可靠回到触发位置。
- **WCAG/Standard**：WCAG 2.2 — 2.1.2、2.4.3；ARIA Authoring Practices — Modal Dialog Pattern
- **Recommendation**：改用原生 `dialog.showModal()`，为可关闭弹窗支持 Escape，并让浏览器负责焦点约束与恢复；必须决策的弹窗应拦截 Escape。
- **Suggested command**：`/harden`

#### [P1] 页面缺少文档语言

- **Location**：Dioxus 自动生成的 `index.html`；项目当前没有 `v2/apps/web/index.html`
- **Category**：Accessibility
- **Impact**：读屏器无法可靠选择中文发音规则。
- **WCAG/Standard**：WCAG 2.2 — 3.1.1（Level A）
- **Recommendation**：提供自定义 Dioxus index 模板并设置 `lang="zh-CN"`。
- **Suggested command**：`/harden`

#### [P1] 焦点指示器对比度不足

- **Location**：`v2/apps/web/assets/main.css` 的 `:focus-visible`
- **Category**：Accessibility / Theming
- **Impact**：`#5e11d1` 在 `#2d2d2d` 上仅约 **1.62:1**，低视力与键盘用户难以定位焦点。
- **WCAG/Standard**：WCAG 2.2 — 2.4.11（最低 3:1）
- **Recommendation**：保留品牌紫作为主按钮色，新增更亮的专用 focus token。
- **Suggested command**：`/normalize`

#### [P1] 首屏为空且 WASM 未压缩/缓存

- **Location**：`v2/apps/web/Dioxus.toml`、缺失的自定义 index、`deploy/v2/nginx/p2p.yxswy.com.conf`
- **Category**：Performance
- **Impact**：弱网下用户在 WASM 下载和初始化前只看到空白页；Lighthouse LCP **8.2 s**。WASM 原始大小约 **1.3 MB**，gzip 后约 **491 KB**。
- **WCAG/Standard**：Core Web Vitals / perceived performance
- **Recommendation**：加入与现有样式一致的静态启动状态；为 JS/WASM 启用 gzip；对带哈希的 `/assets/` 设置 immutable 缓存。
- **Suggested command**：`/optimize`

#### [P1] 根文档仍描述 Bun 与 100 MiB 限制

- **Location**：`README.md`
- **Category**：Release integrity / UX copy
- **Impact**：用户和维护者会得到错误的运行架构、健康检查地址和文件上限，可能错误拆包或按旧服务排障。
- **Recommendation**：将根文档切换为 Rust 2.0、Axum、Dioxus、5 GiB 和 `/health/ready` 的真实生产说明；把 1.x 明确标记为历史基线。
- **Suggested command**：`/harden`

#### [P1] 自动发布前没有 SQLite 在线备份

- **Location**：`deploy/scripts/deploy-release.py`
- **Category**：Release reliability
- **Impact**：若未来迁移修改数据库，运行时回滚可以恢复旧镜像，却不能恢复迁移前的数据文件。
- **Recommendation**：在启动新镜像前使用 Python `sqlite3.Connection.backup()` 创建权限受限的在线备份，并实施有限保留策略；备份失败时中止发布。
- **Suggested command**：`/harden`

### P2 Minor

#### [P2] 部分触控目标只有 40 px

- **Location**：`recipient-picker-trigger`、`recipient-picker-tools button`
- **Category**：Responsive / Accessibility
- **Impact**：移动端误触概率增加。
- **WCAG/Standard**：WCAG 2.2 — 2.5.8（建议至少 44×44 CSS px）
- **Recommendation**：统一提升到 44 px，不改变视觉风格。
- **Suggested command**：`/adapt`

#### [P2] 正式 HTTPS 缺少 HSTS

- **Location**：`deploy/v2/nginx/p2p.yxswy.com.conf`
- **Category**：Security
- **Impact**：首次访问仍可能遭遇降级路径；当前 80 端口虽然重定向，但浏览器不会记住 HTTPS 强制策略。
- **Recommendation**：增加一年期、非 preload 的 HSTS，并确保所有 HTTPS location 都返回该头。
- **Suggested command**：`/harden`

#### [P2] 依赖漏洞检查没有成为 CI 门禁

- **Location**：`.github/workflows/rust-v2.yml`
- **Category**：Supply chain
- **Impact**：本次 RustSec 为 0 漏洞，但未来锁文件引入公告依赖时不会自动阻止发布。
- **Recommendation**：在 native job 增加 RustSec audit 检查。
- **Suggested command**：`/harden`

#### [P2] GitHub Dependabot alerts 未启用

- **Location**：Repository security settings
- **Category**：Supply chain
- **Impact**：GitHub 不会主动产生依赖安全告警。
- **Recommendation**：代码侧增加 RustSec CI；仓库设置权限可用时再启用 Dependabot alerts。
- **Suggested command**：`/harden`

#### [P2] 文档提交也会触发约 24 分钟生产镜像重建

- **Location**：`.github/workflows/rust-v2.yml`
- **Category**：CI/CD performance
- **Impact**：无运行时代码变化也会消耗构建资源并进行不必要的生产滚动发布。
- **Recommendation**：为 push 增加准确的 paths，并保留手动验证入口。
- **Suggested command**：`/optimize`

#### [P2] 颜色 token 使用不完全

- **Location**：`v2/apps/web/assets/main.css`
- **Category**：Theming
- **Impact**：28 个颜色字面量让对比修正与后续一致性维护更容易漂移。
- **Recommendation**：只提取重复且有语义的文字、边框、悬停和 focus token，不改变现有视觉值。
- **Suggested command**：`/normalize`

### P3 Polish

#### [P3] `/favicon.ico` 回退为应用 HTML

- **Location**：Dioxus 资产与 index 模板
- **Category**：Performance / Polish
- **Impact**：浏览器额外请求返回错误 MIME 的 HTML，书签也缺少稳定图标。
- **Recommendation**：复用 1.x favicon 并在自定义 index 中显式声明。
- **Suggested command**：`/polish`

## Patterns & Systemic Issues

- 2.0 功能测试与大文件恢复设计已经很完整，但发布基础设施仍有“候选版可运行、稳定版运维门禁未完全固化”的特征。
- 组件普遍具备 ARIA label、status 和 alert，主要无障碍缺口集中在所有自制模态框共享的焦点模型。
- 性能问题来自传输与缓存策略，不是 JavaScript 主线程：TBT 为 0 ms、CLS 为 0.01。

## Positive Findings

- 生产 CSP、`nosniff`、Referrer Policy、Permissions Policy、Origin 校验、HttpOnly/SameSite/Secure cookie 和请求体限制均已实现。
- Docker 以 UID 10001、只读根文件系统、drop all capabilities 和 no-new-privileges 运行。
- 所有动效使用 transform/opacity，并已有 `prefers-reduced-motion` 降级。
- 桌面与移动端布局均有固定 E2E 截图；主要交互普遍达到 44 px。
- 5 GiB 实测完成 5,368,709,120 字节、640 个 8 MiB 段、两次断线续传与四处内容标记校验。
- RustSec 对 407 个依赖报告 0 个漏洞和 0 个警告。

## Recommended Actions

1. **[P1] `/harden`** — 原生模态焦点、HTML lang、SQLite 发布前备份、HSTS、RustSec CI 与真实文档
2. **[P1] `/optimize`** — 静态启动状态、WASM/JS gzip、哈希资产 immutable cache、CI paths
3. **[P2] `/adapt`** — 把剩余 40 px 交互目标统一到 44 px
4. **[P2] `/normalize`** — 增加 focus/文字/边框语义 token，修正焦点对比但保持原样式
5. **[P3] `/polish`** — favicon、文档链接和发布前细节复验

修复完成后重新运行本审计与 Lighthouse，并在下方记录修复后得分。
