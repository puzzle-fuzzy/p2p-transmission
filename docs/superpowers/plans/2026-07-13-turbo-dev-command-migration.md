# Turbo 开发命令迁移 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or **superpowers:executing-plans** to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 移除 Turbo `dev` 命令中已废弃的 `--parallel` 参数，同时保持 Web 和 API 开发服务并行启动。

**Architecture:** 保留现有 workspace 任务结构和 `turbo.json` 的 `dev.persistent: true` 配置，只修改根 `package.json` 的命令入口，让 Turbo 根据 workspace 中的 `dev` 任务启动两个长驻服务。

**Tech Stack:** Bun 1.3.14、Turbo 2.10.4、Bun workspaces、Vite、Bun API watch mode。

## Global Constraints

- 根开发命令必须继续使用 `bun run dev`。
- 不修改 `turbo.json`、`apps/web/package.json`、`services/api/package.json` 或应用代码。
- 不新增依赖，不修改 `bun.lock`，不改变生产构建和 CI 工作流。
- 保留 `turbo.json` 中 `dev.cache: false` 和 `dev.persistent: true`。

---

### Task 1: Remove the deprecated Turbo CLI flag

**Files:**
- Modify: `X:\p2p-transmission\package.json` (`scripts.dev`)
- Test: `X:\p2p-transmission\turbo.json` remains unchanged and continues to define the persistent `dev` task

**Interfaces:**
- Consumes: workspace `dev` scripts from `apps/web/package.json` and `services/api/package.json`.
- Produces: root command `bun run dev` invoking `turbo run dev` without deprecated flags.

- [x] **Step 1: Confirm the current command and task definition**

Run:

```bash
bun run dev -- --help
```

Expected: Turbo reports the current command path and the existing `--parallel is deprecated` warning is reproducible or the command exits after help output; do not leave a dev server running from this probe.

- [x] **Step 2: Change only the root script**

In `X:\p2p-transmission\package.json`, replace exactly:

```json
"dev": "turbo run dev --parallel"
```

with:

```json
"dev": "turbo run dev"
```

Do not alter the dependency list, lockfile, workspace list, or any package-level scripts.

- [x] **Step 3: Verify the persisted task configuration is unchanged**

Run a UTF-8 Python check:

```bash
python -c "import json; from pathlib import Path; p=json.loads(Path('turbo.json').read_text(encoding='utf-8')); assert p['tasks']['dev']['cache'] is False; assert p['tasks']['dev']['persistent'] is True"
```

Expected: exit code 0 with no assertion failure.

- [x] **Step 4: Verify the new command and project checks**

Run:

```bash
bun run dev
bun run verify
```

Expected: `bun run dev` starts the Web and API `dev` tasks without the `--parallel is deprecated` warning. Stop the two development processes after confirming startup. `bun run verify` passes lint, tests, typecheck, and build.

- [x] **Step 5: Review and commit the focused change**

Run:

```bash
git diff --check
git diff -- package.json turbo.json
git status --short
git add package.json
git commit -m "fix: remove deprecated turbo dev flag"
```

Expected: the staged diff contains only the root `package.json` script change; the pre-existing `.vscode/settings.json` local change remains unstaged.
