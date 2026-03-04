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

相关文件参考：
- Compose 配置：[docker-compose.pg.yml](file:///d:/AI-work/openclaw/openclaw-src/docker-compose.pg.yml#L29-L41)
- 安装脚本：[setup.sh](file:///d:/AI-work/openclaw/openclaw-src/setup.sh)

提示：
- 默认绑定 127.0.0.1；如需从外网访问，可使用宿主网络或在启动命令中加入 `--bind lan`。

## 部署指南 (Linux 原生)

无需 Docker，直接在 Linux 上部署网关与 PG（支持一键化）。

1. **拉取代码**：
   ```bash
   git clone https://github.com/woshimcs/openclaw-pg.git
   cd openclaw-pg
   ```
2. **执行原生部署**：
   ```bash
   chmod +x setup.sh
   ./setup.sh native
   ```
   - 自动生成 `.env`（OPENCLAW_GATEWAY_TOKEN、OPENCLAW_PG_PASSWORD）
   - 安装 Node 22 + pnpm，支持无锁文件回退安装
   - 构建项目与 Control UI
   - 安装 PostgreSQL、创建 `openclaw` 用户与 `openclaw_audit` 数据库
   - 创建并启用 systemd 服务 `openclaw`
3. **验证**：
   ```bash
   systemctl status openclaw
   curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:18789/healthz
   ```

## 仅用 Git 拉取一键部署

- Docker 模式：`./setup.sh`
- 原生模式：`./setup.sh native`

两种模式均会：
- 生成 `.env` 并写入网关密钥与 PG 密码
- 创建 `config.json`（由 `config.example.json` 生成）
- 挂载/创建 `workspace/` 目录以持久化工作区

## 运行要求

- Node.js >= 22
- PostgreSQL >= 13

## 目录说明
- `src/audit/`：PG 审计运行时与入库逻辑
- `src/config/`：审计配置 schema / hints / UI labels
- `ui/src/ui/views/`：Control UI 配置入口

## CLI 安装（npm / pnpm）

若希望像官方安装页面一样通过 CLI 快速使用（无需容器）：

- npm：
  ```bash
  npm install -g openclaw@latest
  openclaw onboard --install-daemon
  ```
- pnpm：
  ```bash
  pnpm add -g openclaw@latest
  pnpm approve-builds -g        # 首次安装需批准带构建脚本的包
  openclaw onboard --install-daemon
  ```

安装后验证：
```bash
openclaw doctor         # 检查配置问题
openclaw status         # 网关状态
openclaw dashboard      # 打开浏览器 UI
```

PATH 故障排查（找不到 openclaw 命令时）：
```bash
node -v
npm -v
npm prefix -g
echo "$PATH"
```
- 若 `$(npm prefix -g)/bin`（macOS/Linux）或 `$(npm prefix -g)`（Windows）不在 PATH，需加入：
  ```bash
  export PATH="$(npm prefix -g)/bin:$PATH"
  ```
  Windows 将 `npm prefix -g` 的输出加到系统 PATH。

更多安装方式与维护指引见文档：[install/index.md](file:///d:/AI-work/openclaw/openclaw-src/docs/install/index.md)

## 授权
MIT
