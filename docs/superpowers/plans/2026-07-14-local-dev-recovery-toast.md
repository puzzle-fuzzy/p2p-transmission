# 本地开发连接恢复与 Toast 布局实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让项目本地开发默认使用独立的 API 端口 `3332`，并将全局 Toast 调整为右上角、无紫色描边且比例更紧凑。

**Architecture:** API 继续从 `PORT` 环境变量读取端口，仅改变未配置时的开发默认值；Web 继续允许 `VITE_API_URL` 覆盖，仅改变未配置时的默认 API 地址。Toast 只调整自身定位和视觉 class，不改变消息状态、自动消失、tone 语义或可访问性属性。

**Tech Stack:** Bun 1.3.14、TypeScript、Elysia、React 19、Vite、Tailwind CSS v4、Vitest、Testing Library。

## Global Constraints

- 本地默认 API 端口必须为 `3332`，生产显式设置的 `PORT` 必须继续生效。
- Web 没有 `VITE_API_URL` 时必须请求 `http://localhost:3332`，显式 URL 必须继续生效。
- Toast 必须固定在右上角，窄屏不能溢出，最大宽度约为 `320px`。
- Toast 容器不得使用紫色描边；错误、成功、普通提示的图标和语义保持不变。
- 关闭按钮继续保留至少 44px 的触控区域及现有无障碍属性。
- 使用项目已锁定的 Bun 1.3.14 运行测试、lint、typecheck 和 build。
- 不修改其他项目端口，不自动终止占用 `3000` 的进程，不改变生产环境的显式端口配置。

---

### Task 1: 隔离本地 API 默认端口并同步 Web 默认地址

**Files:**
- Modify: `services/api/src/config.ts:24`，将 `DEFAULT_PORT` 从 `3000` 改为 `3332`。
- Modify: `services/api/src/config.test.ts:7-24`，更新未配置端口时的期望值。
- Modify: `apps/web/src/lib/config.ts:17-18`，让 `getApiBaseUrl` 可接收可选环境对象并将默认地址改为 `http://localhost:3332`。
- Modify: `apps/web/src/lib/config.test.ts:1-8`，导入 `getApiBaseUrl` 并添加默认值/显式值测试。
- Modify: `apps/web/.env.example:1`，将示例 API 地址改为 `http://localhost:3332`。
- Modify: `services/api/.env.example:2`，将示例 `PORT` 改为 `3332`。

**Interfaces:**
- Consumes: 现有 `ClientEnvironment`、`loadApiConfig(environment)` 和 `VITE_API_URL`/`PORT` 环境变量。
- Produces: `getApiBaseUrl(environment?: ClientEnvironment): string`；不改变无参数调用方的行为，只改变无配置时的默认值。

- [ ] **Step 1: 先更新配置测试，明确新的默认值和覆盖行为**

在 `services/api/src/config.test.ts` 中把现有断言改为：

```ts
expect(config).toEqual({
  port: 3332,
  // 其余字段保持原断言不变
})
```

在 `apps/web/src/lib/config.test.ts` 的 import 中加入 `getApiBaseUrl`，并加入：

```ts
describe('API endpoint config', () => {
  test('uses the isolated local API port by default', () => {
    expect(getApiBaseUrl({})).toBe('http://localhost:3332')
  })

  test('honors an explicit API URL and trims its trailing slash', () => {
    expect(getApiBaseUrl({ VITE_API_URL: 'https://api.example.com/' }))
      .toBe('https://api.example.com')
  })
})
```

- [ ] **Step 2: 运行新增/更新的配置测试，确认旧代码按预期失败**

运行：

```text
bun test services/api/src/config.test.ts
bun run --cwd apps/web test -- src/lib/config.test.ts
```

预期：API 默认端口断言失败（实际仍为 `3000`），Web 默认地址断言失败（实际仍为 `http://localhost:3000`）。

- [ ] **Step 3: 修改 API 与 Web 的最小默认值实现**

`services/api/src/config.ts` 使用：

```ts
const DEFAULT_PORT = 3332
```

`apps/web/src/lib/config.ts` 使用可测试但保持现有无参调用兼容的实现：

```ts
export const getApiBaseUrl = (
  environment: ClientEnvironment = import.meta.env,
) => trimTrailingSlash(environment.VITE_API_URL ?? 'http://localhost:3332')
```

同步把两个 `.env.example` 中的开发默认值改为 `3332`，不新增真实密钥或本地 `.env` 文件。

- [ ] **Step 4: 运行配置测试，确认默认值和覆盖行为通过**

运行：

```text
bun test services/api/src/config.test.ts
bun run --cwd apps/web test -- src/lib/config.test.ts
```

预期：API 配置测试全部通过；Web 配置测试全部通过。

- [ ] **Step 5: 提交端口隔离变更**

```text
git add services/api/src/config.ts services/api/src/config.test.ts apps/web/src/lib/config.ts apps/web/src/lib/config.test.ts apps/web/.env.example services/api/.env.example
git commit -m "fix: isolate local API development port"
```

### Task 2: 将 Toast 调整到右上角并移除紫色描边

**Files:**
- Create: `apps/web/src/components/ui/Toast.test.tsx`，覆盖右上角定位、无描边、紧凑比例和关闭按钮。
- Modify: `apps/web/src/components/ui/Toast.tsx:13-66`，调整 tone class、viewport 定位和 surface 尺寸。

**Interfaces:**
- Consumes: 现有 `ToastState`、`ToastTone` 和 `ToastViewport({ toast, onDismiss })` props。
- Produces: 相同的 `ToastViewport` API；DOM 仍提供 `alert/status`、`aria-live`、`aria-atomic` 和“关闭提示”按钮。

- [ ] **Step 1: 写出 Toast 的失败测试**

创建 `apps/web/src/components/ui/Toast.test.tsx`：

```tsx
// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import './test/dom'
import ToastViewport from './Toast'

describe('ToastViewport', () => {
  test('anchors alerts to the upper-right without a colored border', () => {
    render(
      <ToastViewport
        toast={{ id: 1, message: '连接服务器失败，请检查网络后重试', tone: 'error' }}
        onDismiss={vi.fn()}
      />,
    )

    const viewport = screen.getByRole('alert')
    const surface = viewport.firstElementChild

    expect(viewport.className).toContain('right-4')
    expect(viewport.className).toContain('top-4')
    expect(viewport.className).not.toContain('left-1/2')
    expect(viewport.className).toContain('w-[min(320px,calc(100vw-2rem))]')
    expect(surface).not.toBeNull()
    expect(surface?.className).not.toMatch(/\bborder(?:-|\b)/u)
    expect(surface?.className).toContain('min-h-10')
    expect(screen.getByRole('button', { name: '关闭提示' })).toBeTruthy()
  })
})
```

- [ ] **Step 2: 运行 Toast 测试，确认现有样式按预期失败**

运行：

```text
bun run --cwd apps/web test -- src/components/ui/Toast.test.tsx
```

预期：测试失败，因为当前 Toast 使用 `left-1/2`、`360px` 宽度、`border` 和 `min-h-11`。

- [ ] **Step 3: 修改 Toast 的定位和尺寸 class**

将 viewport 调整为：

```tsx
className="fixed right-4 top-4 z-50 w-[min(320px,calc(100vw-2rem))] sm:right-6 sm:top-6"
```

将 surface 调整为：

```tsx
className={`toast-surface flex min-h-10 items-center gap-2.5 rounded-xl px-3 py-2.5 ${styles.container}`}
```

将三种 tone 的 `container` 都改为无 border：

```ts
error: { container: 'bg-surface-elevated text-amber-50/80', ... }
success: { container: 'bg-surface-elevated text-amber-50/80', ... }
info: { container: 'bg-surface-elevated text-amber-50/70', ... }
```

保留关闭按钮 `size-11`、`aria-label="关闭提示"`、tone role/live region，以及 `focus-visible:ring-accent` 的键盘焦点反馈。

- [ ] **Step 4: 运行 Toast 测试，确认布局契约通过**

运行：

```text
bun run --cwd apps/web test -- src/components/ui/Toast.test.tsx
```

预期：测试通过。

- [ ] **Step 5: 提交 Toast 变更**

```text
git add apps/web/src/components/ui/Toast.tsx apps/web/src/components/ui/Toast.test.tsx
git commit -m "fix(web): refine toast placement and sizing"
```

### Task 3: 集成验证与本地启动回归

**Files:**
- No source changes expected. If a verification exposes a regression, modify only the file that owns the failing behavior and add the corresponding test before fixing it.

**Interfaces:**
- Consumes: Task 1 的 `3332` 默认 API 配置和 Task 2 的 Toast DOM contract。
- Produces: 可从干净启动流程验证的本地开发配置，以及完整验证结果。

- [ ] **Step 1: 检查工作树和补丁格式**

运行：

```text
git diff --check
git status --short
```

预期：没有空白错误；只有本计划执行中预期的改动或提交记录。

- [ ] **Step 2: 用 Bun 探测默认 API 端口与访客初始化接口**

启动 `bun services/api/src/index.ts`，不设置 `PORT`，使用 Python 临时探测脚本访问：

```text
http://127.0.0.1:3332/health
POST http://127.0.0.1:3332/v1/visitors
```

预期：健康检查返回 200，访客接口返回 200；探测结束后只终止本次探测进程，不触碰其他项目进程。

- [ ] **Step 3: 运行完整质量门禁**

运行：

```text
bun run verify
bun run e2e
```

预期：lint、单元测试、typecheck、build 和真实浏览器 E2E 全部通过。

- [ ] **Step 4: 检查最终差异并提交验证文档（如有必要）**

运行：

```text
git diff --check
git status --short
git log -3 --oneline
```

若验证只产生已提交代码，不新增文档；向用户说明当前仍需重启已有的 `bun run dev` 进程，使新的默认端口配置生效。

## Plan self-review

- Spec coverage: 端口冲突根因、默认端口、前端默认地址、显式覆盖、Toast 右上角、无紫色描边、尺寸调整、移动端不溢出、无障碍保留、验证和重启说明均有对应任务。
- Placeholder scan: 计划没有使用占位标记或“稍后实现”等模糊语句；每个代码变更步骤给出了目标文件、实际内容和命令。
- Type consistency: `getApiBaseUrl(environment?: ClientEnvironment): string` 与现有无参调用兼容；Toast props 和 `ToastState` 不变；API `loadApiConfig` 签名不变。
