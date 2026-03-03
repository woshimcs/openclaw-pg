# OpenClaw PG 审计版

这是 OpenClaw 的 PG 审计增强版本，专注于把会话、模型输出、工具执行与记忆文件变更落地到 PostgreSQL，便于审计、追踪与回放。

## 核心改进
- PG 审计落库：审计事件写入 Postgres（批量入库、失败保留队列等待下次 flush）。
- 事件覆盖：用户问答、模型回复、工具调用、内部 hook 事件都可入库。
- 记忆文件 diff：记忆文件变更统一 diff 后写入 memory patches 表，带版本号与 hash。
- UI 配置入口：Control UI 增加 Audit 分组，支持直接配置 PG 连接与审计开关。
- 安全提示：PG 连接串标记为敏感字段，UI 默认密码输入展示。

## 快速启用
在配置中打开审计并设置 PG 连接串：

```json
{
  "audit": {
    "enabled": true,
    "teamId": "team-1",
    "instanceId": "gateway-1",
    "pg": {
      "connectionString": "postgres://user:pass@host:5432/db",
      "schema": "public",
      "eventsTable": "openclaw_audit_events",
      "memoryTable": "openclaw_memory_patches",
      "maxBatchSize": 200,
      "flushIntervalMs": 1000
    },
    "agentEvents": {
      "enabled": true,
      "streams": ["tool", "assistant"]
    },
    "memory": {
      "enabled": true,
      "includeGlobs": ["memory/**/*.md", "MEMORY.md"],
      "ignoreGlobs": ["**/node_modules/**", "**/.git/**"]
    }
  }
}
```

也可以在 Control UI 的 Audit 分组里直接配置上述字段。

## 事件落库说明
- 问答与消息：内部 hook 的 message/command/agent/gateway/session 事件写入事件表。
- 模型回复：assistant 流事件写入事件表。
- 工具调用：tool 流的 start/update/result 写入事件表。
- 记忆变更：memory 开关开启时写入 memory patches 表，含 diff 和版本号。

## 默认表结构
默认创建：
- `public.openclaw_audit_events`
- `public.openclaw_memory_patches`

表结构由程序在启动时自动创建。

## 部署指南 (Docker)

本仓库提供了一键式 Docker 部署脚本，包含 OpenClaw 网关和 PostgreSQL 数据库。

1. **拉取代码**：
   ```bash
   git clone https://github.com/woshimcs/openclaw-pg.git
   cd openclaw-pg
   ```

2. **一键启动**：
   ```bash
   chmod +x setup.sh
   ./setup.sh
   ```
   该脚本会自动创建 `config.json`，并启动包含 PG 和 OpenClaw 的 Docker 服务。

3. **访问网关**：
   - Gateway UI: `http://localhost:18789`
   - Token/PG 密码：首次运行由 `setup.sh` 自动生成并写入 `.env`
   - PG 连接串：`postgres://openclaw:${OPENCLAW_PG_PASSWORD}@postgres:5432/openclaw_audit`

4. **持久化数据**：
   - 数据库数据存储在 docker volume `pgdata` 中。
   - OpenClaw 配置文件挂载在当前目录的 `config.json`。
   - 工作区数据挂载在当前目录的 `workspace/`。

## 运行要求

- Node.js >= 22
- PostgreSQL >= 13

## 目录说明
- `src/audit/`：PG 审计运行时与入库逻辑
- `src/config/`：审计配置 schema / hints / UI labels
- `ui/src/ui/views/`：Control UI 配置入口

## 授权
MIT
