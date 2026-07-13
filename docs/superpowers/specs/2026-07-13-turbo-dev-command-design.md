# Turbo 开发命令迁移设计

日期：2026-07-13

## 背景

根目录 `package.json` 当前使用 `turbo run dev --parallel` 启动 Web 和 API。Turbo 2.10.4 已提示 `--parallel` 将被移除，推荐通过任务定义描述长驻任务和任务关系。

## 目标

- 移除根开发命令中的已废弃 `--parallel` 参数。
- 保持现有行为：一次执行 `bun run dev` 仍同时启动 `apps/web` 和 `services/api` 的 `dev` 脚本。
- 继续使用 `turbo.json` 中 `dev.persistent: true` 表示开发服务不会自然结束。
- 不改变 Web/API 的端口、热更新、环境变量或其他开发脚本。

## 方案

将根目录脚本从：

```json
"dev": "turbo run dev --parallel"
```

改为：

```json
"dev": "turbo run dev"
```

当前 `turbo.json` 已将 `dev` 定义为 `persistent: true`，因此不需要继续使用 CLI 层面的并行参数。Turbo 会根据 workspace 中的任务定义启动两个独立的开发服务。

## 范围边界

- 修改：根目录 `package.json` 的 `dev` 脚本。
- 保持：`turbo.json`、`apps/web/package.json`、`services/api/package.json` 及所有应用代码不变。
- 不新增依赖，不修改 lockfile，不改变生产构建或 CI 工作流。

## 验收标准

1. `bun run dev` 的 Turbo 启动输出不再包含 `--parallel is deprecated` 警告。
2. Web 和 API 两个 `dev` 任务都能被 Turbo 启动。
3. `bun run verify` 继续通过，证明配置改动没有影响 lint、测试、类型检查和构建。

## 风险与回滚

风险很低，主要风险是不同 Turbo 版本对长驻任务的调度表现不同；项目当前固定使用 lockfile 中的 Turbo 版本并已在 Turbo 2.10.4 下复现警告。

如需回滚，只需将根脚本恢复为原值；但这会重新出现 Turbo 的废弃参数警告。
