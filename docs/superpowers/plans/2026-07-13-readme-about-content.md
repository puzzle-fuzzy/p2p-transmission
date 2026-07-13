# README 与 About 内容完善 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完善 P2P Transmission 的产品说明、普通用户指南、开发与部署入口，并在 Web 应用中增加统一的 About 弹窗，让用户能够理解传输方式、隐私边界、使用限制和当前构建信息。

**Architecture:** 根目录 README 负责项目总览和入口导航，`docs/user-guide.md` 负责普通用户任务说明，各工作区 README 保留技术细节。Web 端在大厅和房间顶部共用一个 `AboutDialog`，构建版本由 `VITE_APP_VERSION` 在构建时注入，未注入时显示“开发构建”。本次不增加路由、不修改房间授权、WebRTC、SQLite 或 TURN 协议。

**Tech Stack:** Bun 1.3.14、TypeScript、React 19、Vite、Tailwind CSS 4、Vitest、Testing Library、Playwright Chromium、Markdown、Python 3 文档检查脚本、Docker Compose。

## Global Constraints

- 只描述当前实现已经保证的行为：产品地址是 `https://p2p.yxswy.com`；文本和文件通过浏览器 WebRTC DataChannel 传输；API 负责临时身份、房间、加入授权和 WebSocket 信令；coturn 只中继加密 WebRTC 流量。
- 明确说明 6 位房间码是公开标识而不是授权凭证；邀请链接包含加入权限，只发送给可信接收者。
- 明确说明房间默认有效期 30 分钟、单批最多 10 个文件且总大小最多 100 MiB、API 重启后 SQLite 会恢复生命周期内的数据但在线 WebSocket 会断开、当前部署是单 API 实例。
- 不写“绝对安全”“服务器完全无法接触任何数据”等超出实现边界的承诺，不添加仓库中不存在的许可证、隐私政策法律文本、客服或第三方服务承诺。
- About 不读取 visitor token、room session、邀请 token 或其他敏感状态；构建版本必须来自 `import.meta.env.VITE_APP_VERSION`，不能来自用户输入。
- 沿用当前深色 surface、紫色 accent、琥珀色文字和原生 `<dialog>` 模式；不引入路由系统、独立 About 页面或新的动画依赖。
- 工作区已有大量未提交的功能和部署改动，实施时只修改本计划列出的文件；计划提交只能暂存本计划文件，不能覆盖或回滚 `.vscode/settings.json` 等已有改动。

---

## 1. 建立文档入口和可重复的链接检查

### Files

- Create: `docs/user-guide.md`
- Create: `scripts/check-doc-links.py`
- Modify: `README.md`
- Modify: `apps/web/README.md`
- Modify: `services/api/README.md`
- Modify: `deploy/README.md`
- Modify: `package.json`

### Steps

- [ ] 将根目录 `README.md` 重排为以下顺序：产品定位与生产地址、30 秒快速使用、隐私与安全模型、使用限制、项目结构与数据流、本地开发、验证命令、腾讯云单机部署、故障排查、相关文档和当前单机边界。
- [ ] 在根 README 的快速使用中写清楚创建房间、分享邀请链接、通过房间码申请加入、房主批准、浏览器建立点对点连接、发送文本或文件的最短路径；所有链接使用仓库内相对路径或生产域名 `https://p2p.yxswy.com`。
- [ ] 新建 `docs/user-guide.md`，按普通用户任务编写“创建房间”“使用邀请链接加入”“只知道房间码时申请加入”“房主处理申请”“发送文本和文件”“房间过期与网络问题”“隐私提醒”章节。每个失败场景都同时写出发生原因和下一步动作，避免要求读者先理解 API、WebRTC 或 TURN 术语。
- [ ] 在用户指南中明确：邀请链接本身包含加入权限；房间码只用于定位房间；关闭标签页、刷新或切换网络可能导致当前连接重建；重要文件应保留原始备份；需要中继时 coturn 只转发加密 WebRTC 流量。
- [ ] 更新 `apps/web/README.md` 的产品地址、Bun 版本、用户指南入口、10 文件/100 MiB 限制、`off/api/static` ICE 模式、`relay` 验收方式和真实 Chromium E2E 命令；保留已有前端配置细节。
- [ ] 更新 `services/api/README.md` 的根 README、用户指南和部署文档链接，并把 SQLite 的恢复范围、在线连接重连行为及“单 API 实例、不承诺多实例同步”写入运行边界；保留已有 API、WebSocket、测试和配置细节。
- [ ] 更新 `deploy/README.md` 的产品地址、Bun 1.3.14、用户指南入口和单机边界；保留腾讯云安全组、宿主机 Nginx、Docker Compose、SQLite 数据目录、coturn 证书和 TURN 验收命令。
- [ ] 新建 `scripts/check-doc-links.py`。脚本使用 UTF-8 读取 `README.md`、`docs/user-guide.md`、`apps/web/README.md`、`services/api/README.md`、`deploy/README.md`，解析 Markdown 相对链接，跳过 `http://`、`https://`、`mailto:`、锚点和代码块中的内容，并以仓库根目录为基准检查目标文件或目录存在；发现失效链接时打印文件、链接和解析路径并返回非零退出码。
- [ ] 在根 `package.json` 增加脚本 `check:docs: "python scripts/check-doc-links.py"`，确保 Windows 环境也通过 Python 执行，不依赖 PowerShell 的编码行为。

### Verification

```bash
bun run check:docs
git diff --check
```

Expected result: 文档链接检查成功，且没有空白错误、断行错误或不可解析的仓库内链接。

## 2. 增加构建版本元数据并接入部署构建

### Files

- Create: `apps/web/src/lib/app-meta.ts`
- Create: `apps/web/src/lib/app-meta.test.ts`
- Modify: `apps/web/src/App.tsx`
- Modify: `deploy/web/Dockerfile`
- Modify: `deploy/compose.yml`
- Modify: `deploy/.env.example`

### Steps

- [ ] 在 `apps/web/src/lib/app-meta.ts` 导出 `getAppVersion(environment)` 和 `appVersion`。实现规则是：去除 `VITE_APP_VERSION` 两端空白；值为空、未定义或未注入时返回“开发构建”；非空值原样作为构建版本展示。环境参数类型复用配置模块已有的只读字符串映射形状，避免把 `import.meta.env` 绑定到测试环境。
- [ ] 在 `apps/web/src/lib/app-meta.test.ts` 覆盖未定义、空白字符串和显式版本号三种情况，并断言显式版本号不会被改写成伪造的默认版本。
- [ ] 修改 `deploy/web/Dockerfile`，增加 `ARG VITE_APP_VERSION=`，并将它与现有的 `VITE_API_URL`、`VITE_TURN_MODE`、`VITE_STUN_URLS` 一起传给 `bun run --cwd apps/web build`。默认留空，使本地或未配置生产版本时由前端显示“开发构建”。
- [ ] 修改 `deploy/compose.yml` 的 `web.build.args`，增加 `VITE_APP_VERSION: ${VITE_APP_VERSION:-}`；不把版本写入 API 运行时环境，也不把任何 secret 暴露给前端构建。
- [ ] 在 `deploy/.env.example` 的 Web 构建配置区增加 `VITE_APP_VERSION=1.0.50`，并注释“发布新版本时按实际发布版本修改”；保持示例文件不含真实 TURN secret、IP、证书或密码。

### Verification

```bash
bun run --cwd apps/web test -- app-meta.test.ts
bun run --cwd apps/web typecheck
```

Expected result: 版本 fallback 和显式版本测试通过，TypeScript 构建类型检查通过。

## 3. 实现可访问的 AboutDialog 组件

### Files

- Create: `apps/web/src/components/AboutDialog.tsx`
- Create: `apps/web/src/components/AboutDialog.test.tsx`

### Steps

- [ ] 定义 `AboutDialogProps`：`version: string` 和 `onClose(): void`。组件内部只使用这两个输入，不读取任何房间、visitor、邀请或传输状态。
- [ ] 复用 `ShareDialog` 的原生 `<dialog>` 生命周期模式：挂载后调用 `showModal()`，聚焦关闭按钮；卸载时关闭仍打开的 dialog；使用 `aria-labelledby` 关联标题；在 `onCancel` 中阻止默认行为后调用一次 `onClose`；关闭按钮调用同一个幂等关闭处理。
- [ ] 使用标题“关于 P2P Transmission”和一句话“不注册，不上传，直接把内容传给对方。”，并按设计放置四段内容：
  - “它是怎么工作的”：创建临时房间、确认加入、浏览器直连或必要时通过 TURN 中继。
  - “隐私与安全”：DataChannel 传输文本和文件；API 负责会话、授权和信令；API 不保存或中继应用载荷；TURN 只中继加密流量；邀请链接包含加入权限。
  - “使用前知道”：房间默认 30 分钟；单批最多 10 个文件、总大小最多 100 MiB；网络限制可能需要 TURN；重要文件应保留备份。
  - “构建信息”：显示 `https://p2p.yxswy.com` 和传入的 `version`。
- [ ] 将内容放在可滚动的现有深色弹窗表面中，关闭按钮名称为“关闭”，保留现有 `prefers-reduced-motion` 行为，不添加营销夸张或法律声明。
- [ ] 在 `AboutDialog.test.tsx` 覆盖：标题与关键文案出现、显式版本展示、`aria-labelledby` 关系、挂载后打开并聚焦关闭按钮、点击“关闭”触发回调、Escape 对应的 `cancel` 事件触发回调，以及弹窗文本不包含任何模拟的 visitor 或邀请 token。

### Verification

```bash
bun run --cwd apps/web test -- AboutDialog.test.tsx
```

Expected result: AboutDialog 单元测试全部通过，且测试只依赖现有 jsdom dialog 夹具。

## 4. 将两个入口接入同一个 About 状态

### Files

- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/App.test.tsx`

### Steps

- [ ] 在 `App.tsx` 引入 `AboutDialog` 和 `appVersion`，增加一个 `aboutOpen` 状态以及 `openAbout`/`closeAbout` 处理函数，保证大厅和房间入口只切换同一个布尔状态。
- [ ] 在正常大厅 `RoomJoin` 容器底部增加文字按钮“关于 P2P Transmission”；按钮使用普通按钮语义、可见焦点样式和最小触摸高度，不改变建房、加入或恢复流程。
- [ ] 在房间顶部操作区增加 info 图标按钮，`aria-label` 和 `title` 都使用“关于 P2P Transmission”；发送者和接收者都能看到，接收者的退出按钮仍保留。
- [ ] 在 App 的其他 dialog 渲染区域增加 `aboutOpen && <AboutDialog version={appVersion} onClose={closeAbout} />`，让两个入口打开完全相同的组件与文案。
- [ ] 在 `App.test.tsx` 增加大厅入口测试：在现有 lobby 测试环境点击“关于 P2P Transmission”，断言 About 标题、生产地址和“开发构建”可见，点击关闭后 dialog 不再打开。
- [ ] 在 `App.test.tsx` 增加房间入口测试：使用现有 `enterRoom('sender')` 或 `enterRoom('receiver')` 辅助流程，点击 info 按钮，断言出现相同的 About 标题和关闭行为；测试结束沿用现有卸载清理。

### Verification

```bash
bun run --cwd apps/web test -- App.test.tsx
bun run --cwd apps/web lint
bun run --cwd apps/web typecheck
```

Expected result: 大厅和房间入口都只打开一个 AboutDialog，既有房间流程测试不受影响。

## 5. 用真实 Chromium E2E 覆盖 About 不影响主流程

### Files

- Modify: `apps/web/e2e/room-transfer.spec.ts`

### Steps

- [ ] 在现有双浏览器上下文测试中，发送者创建房间前先打开大厅 About，断言真实 Chromium 中能看到标题、生产地址和使用限制，再点击“关闭”。
- [ ] 发送者创建房间后再次点击房间顶部的“关于 P2P Transmission”，断言它与大厅使用同一标题和关闭按钮，关闭后继续执行原有加入批准、文本传输和文件传输流程。
- [ ] 不通过 mock WebRTC、mock fetch 或 jsdom 替代该验证；继续使用现有 API、WebSocket、coturn/WebRTC 和两个真实浏览器上下文。

### Verification

```bash
bun run e2e
```

Expected result: About 的大厅入口和房间入口在真实 Chromium 中均可用，原有“批准 peer、传输文本和文件”的 E2E 仍然通过。

## 6. 全量验证、生产构建与腾讯云同步

### Files

- Verify: all files changed by steps 1–5
- Deploy source: `deploy/.env.example`, `deploy/compose.yml`, `deploy/web/Dockerfile`

### Steps

- [ ] 运行文档链接检查、全量 lint/test/typecheck/build 和真实浏览器 E2E；同时运行 `git diff --check`，确认没有编码、空白或 Markdown 链接问题。
- [ ] 在生产构建中使用 Bun 1.3.14 和明确的 `VITE_APP_VERSION=1.0.50`，重新构建 Web 镜像；API、SQLite 数据目录、TURN 证书和宿主机 Nginx 配置保持现状，不修改协议或数据库结构。
- [ ] 在腾讯云主机执行 Compose 更新，确认 API、Web、coturn 健康检查通过；不删除现有容器卷、不清理现有 PostgreSQL/mihomo/headscale 等非本项目服务。
- [ ] 用 Python UTF-8 脚本访问 `https://p2p.yxswy.com/health` 并断言 HTTP 200、响应 JSON 的 `ok` 为 `true`；用真实浏览器打开生产地址，确认大厅 About 显示生产地址和构建版本，再创建房间确认房间顶部入口可用。
- [ ] 最终记录变更文件、验证命令和生产健康检查结果；如果远端部署失败，只保留本地已验证变更并报告具体失败命令，不回滚用户已有改动。

### Verification

```bash
bun run check:docs
bun run verify -- --force
bun run e2e
git diff --check
```

Expected result: 本地完整验证通过，生产健康检查为 `200` 且 `ok: true`，About 文案和构建信息与当前腾讯云单机部署一致。

## Self-review checklist

- [ ] README、用户指南、三个工作区 README 和 About 的产品事实一致，没有把房间码写成授权凭证。
- [ ] 文档没有引入仓库不存在的许可证、法律承诺、账号体系、历史记录或云端文件存储功能。
- [ ] About 的两个入口共用一个组件和一个状态，版本来自构建环境且有“开发构建” fallback。
- [ ] 单元测试覆盖 About 内容、无敏感状态、关闭语义和版本 fallback；E2E 覆盖两个真实浏览器入口并保留文本/文件传输验证。
- [ ] 所有代码文件路径、脚本名称、命令和环境变量与当前仓库结构一致；计划中没有未定义的占位内容。
- [ ] 生产步骤明确保持 Bun 1.3.14、SQLite 持久化范围、单 API 实例和现有腾讯云宿主机服务边界。
