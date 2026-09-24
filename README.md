# ESA VPS Monitor

ESA VPS Monitor 是一个运行在 **阿里云 ESA 函数和 Pages** 上的轻量 VPS 探针面板：

- **ESA 函数和 Pages**：托管前端静态资源和 API。
- **ESA 边缘存储（EdgeKV）**：保存配置、实时状态和历史数据，不需要外部数据库。
- **Go Agent**：在服务器上采集指标，通过 HTTP 上报给函数。

本项目移植自 [kadidalax/cf-vps-monitor](https://github.com/kadidalax/cf-vps-monitor)（Cloudflare Workers + Durable Objects + Supabase 版）。前端、Agent 和大部分业务规则沿用原项目；存储层、实时与定时调度针对 ESA 重写。

## 特性

- **服务器监控**：在线状态、CPU、GPU、内存、Swap、磁盘、负载、温度、网络速率、月度流量、账单、到期时间、系统信息、IPv4/IPv6、进程数、TCP/UDP 连接数。
- **实时看板**：有人查看页面时，Agent 自动切到快速上报（默认 5 秒）；无人查看时按 120 秒批量上报。
- **Ping 监控**：支持 ICMP、TCP、HTTP Ping 任务，由 Agent 执行并展示延迟历史。
- **网站监控**：支持 HTTP/HTTPS GET/HEAD，可由 ESA 边缘或指定 Agent 节点探测；TCP 检测必须交给 Agent（见下文“限制”）。
- **后台管理**：节点增删改、批量隐藏/删除、拖拽排序、Agent Token 轮换、安装命令生成、审计日志、用量估算、加密备份恢复、MFA 两步验证。
- **通知**：Telegram 和 Webhook（飞书、钉钉、企业微信、Slack、Discord 或自定义模板），可用于离线、到期、负载和网站监控告警。
- **主题**：内置 `monitor` 和 `aurora` 主题，支持主题包、自定义 CSS、图片和字体资源。

## 架构

| 目录 | 说明 |
| --- | --- |
| `frontend/` | React + Vite + Radix UI，构建产物 `frontend/dist` 作为 ESA Pages 静态资源 |
| `worker/` | Hono API。`src/esa-entry.ts` 是 ESA 函数入口，`src/store/` 是 EdgeKV 数据层，构建产物为 `worker/dist/esa-entry.js` |
| `agent/` | Go Agent 与 Unix/Windows 安装脚本 |
| `scripts/` | 函数打包（`build-esa.mjs`）、本地开发服务器（`dev-server.mjs`）、安全检查 |
| `esa.jsonc` | ESA 函数和 Pages 项目配置：入口、静态资源目录、构建命令 |

### 与 Cloudflare 版的差异

| Cloudflare 版 | ESA 版 |
| --- | --- |
| Supabase Postgres | EdgeKV：数据存为少量 JSON 文档（配置、实时分片、每节点历史、网站监控、审计日志等） |
| Durable Objects + WebSocket 实时推送 | 页面轮询 `/api/live/clients`；Agent 通过 `/api/clients/policy` 得知是否有人在看，并切换上报间隔 |
| Cron Triggers | 维护任务（离线/到期告警、网站检测、清理）在 Agent 拉取策略和访客访问时顺带触发；也可以另外配置外部定时器（见下文） |
| Agent WebSocket 上报 | Agent 默认 `--mode http` |
| SMTP 邮件 | 不支持（ESA 函数不能建立 TCP 连接），可以用 Webhook 转发到邮件服务 |

## 部署

### 1. 创建 EdgeKV 命名空间

在 ESA 控制台打开 **边缘计算 → 函数和 Pages → KV 存储**，创建一个命名空间，例如 `esa-vps-monitor`。名称需要与下面的 `KV_NAMESPACE` 变量一致。

### 2. 准备 Agent 发布

安装脚本会从**你自己仓库**的 GitHub Releases 下载 Agent 二进制：

1. Fork 本仓库（或推送到你自己的 GitHub 仓库）。
2. 如果你的仓库不是 `sbaliyun/esa-vps-monitor`，把以下位置改成你的 `owner/repo`：
   - `frontend/src/utils/projectLinks.ts`
   - `agent/install.sh`、`agent/install-linux.sh`、`agent/install-windows.ps1` 中的 `CF_MONITOR_REPOSITORY`
   - `worker/src/app.ts` 中 `/agent/install*.sh|ps1` 的跳转地址
3. 在 GitHub 打开 **Actions → Agent Release → Run workflow**，填入版本号（例如 `v2.1.0`）并运行，生成 Agent 二进制。

### 3. 创建函数并部署

**方式 A：控制台导入 GitHub 仓库（推荐）**

1. 在 ESA 控制台打开 **函数和 Pages → 创建 → 导入 GitHub 仓库**，选择你的仓库。
2. 仓库根目录的 `esa.jsonc` 优先于控制台里的构建配置：
   - 安装命令 `npm ci`
   - 构建命令 `npm run build`
   - 函数入口 `./worker/dist/esa-entry.js`
   - 静态资源目录 `./frontend/dist`（SPA 回退）
3. 按下表配置环境变量，然后触发部署。

**方式 B：esa-cli**

```bash
npm ci
npx esa-cli login                 # 或者设置 ESA_ACCESS_KEY_ID / ESA_ACCESS_KEY_SECRET 环境变量
npx esa-cli env set KV_NAMESPACE=esa-vps-monitor -e production
npx esa-cli secret put JWT_SECRET -e production
npm run deploy                    # 等于 npm run build && esa-cli deploy
```

**方式 C：GitHub Actions**

1. 在仓库 Secrets 中添加 `ESA_ACCESS_KEY_ID` 和 `ESA_ACCESS_KEY_SECRET`，使用具有 ESA 函数和 Pages 权限的 RAM 用户 AccessKey。
2. 手动运行 **Actions → Deploy to ESA**。

> ESA 每次部署都会绑定当时的变量快照。修改变量后，需要重新部署（或提交新版本）才会生效。

### 4. 环境变量

| 名称 | 必填 | 说明 |
| --- | --- | --- |
| `JWT_SECRET` | 是 | 后台会话签名密钥，至少 32 字节。请设为 Secret。 |
| `KV_NAMESPACE` | 建议 | EdgeKV 命名空间名称，默认 `esa-vps-monitor`。 |
| `ADMIN_RECOVERY_KEY` | 否 | 在登录页重置管理员账号时使用的恢复密钥；未设置时使用 `JWT_SECRET`。 |
| `CRON_SECRET` | 否 | 外部定时触发地址的密钥；未设置时由 `JWT_SECRET` 派生。 |
| `LIVE_SHARDS` | 否 | 实时状态分片数（1–4，默认 1）。节点很多且同时高频上报时调大可以减少写入冲突，代价是读取实时数据时 KV 读取次数增加。 |
| `KV_OPS_PER_REQUEST` | 否 | 单次请求的 KV 操作预算（默认 8），请按你的 ESA 套餐限制调整。 |
| `SUBREQUESTS_PER_REQUEST` | 否 | 单次请求的出站请求预算（默认 4，用于网站检测和通知）。 |

### 5. 初始化

1. 打开 `https://你的域名/db-init`，自检部署状态：KV 命名空间是否可用、`JWT_SECRET` 是否有效。
2. 打开 `/login`。首次登录时创建唯一的管理员账号。

## 使用流程

1. 登录后台，在“服务器”中添加节点。
2. 打开节点的安装命令（Unix 自动检测或 Windows），复制后在 VPS 上执行。生成的命令已经带上 `--mode http`。
3. 需要 Ping 监控时，在“Ping”中创建任务；需要网站监控时，在“网站”中创建目标。
4. 需要告警时，在“通知”中配置 Telegram 或 Webhook。

同一台服务器可以安装多个 Agent 实例，每个安装命令都带独立的 `instance-id`。

卸载单个 Unix 实例：

```bash
wget -qO- 'https://raw.githubusercontent.com/sbaliyun/esa-vps-monitor/refs/heads/main/agent/install.sh' | sh -s -- --uninstall -i 实例ID
```

卸载单个 Windows 实例：

```powershell
.\install-windows.ps1 -Uninstall -i '实例ID'
```

### 外部定时触发（可选）

ESA 函数没有定时触发器。维护任务（离线/到期告警、网站检测、清理）在 Agent 拉取策略和访客访问时顺带执行，最多每分钟执行一次。**如果所有节点都离线、又没有人访问站点，维护任务就会停止。** 如果需要在这种情况下仍能收到离线告警：

- 后台 **设置 → 通用设置** 会显示完整的触发地址：`https://你的域名/api/cron?key=...`。
- 用任意外部定时服务（GitHub Actions、cron-job.org、另一台服务器上的 crontab 等）每 1–5 分钟请求一次该地址。
- 同一页面也可以点击“立即执行维护”。

## 从 cf-vps-monitor 迁移

1. 在旧部署后台 **设置 → 站点设置** 下载加密备份。
2. 在新部署创建管理员后，在 **设置 → 站点设置** 上传该备份。
3. 备份会恢复：
   - 站点设置
   - 节点（含 Agent Token）
   - Ping 任务
   - 通知规则
   - 网站监控

   历史数据、审计日志和主题不会迁移。
4. 对每个节点，从新后台复制安装命令，原地重装 Agent：上报地址和上报方式变了，但 Token 仍然有效。

## 限制与用量

- **EdgeKV 是最终一致的**：在一个边缘节点写入的数据，可能要几秒到几十秒后才能在其他节点读到。短时间内反复修改配置时，偶尔可能出现互相覆盖。
- **单次请求的 KV 和出站请求预算**：代码按 `KV_OPS_PER_REQUEST` 和 `SUBREQUESTS_PER_REQUEST` 控制用量。边缘侧的网站检测和通知会分摊到多次维护中执行。
- **历史数据**：
  - 最多保留 72 小时。
  - 最近 4 小时按记录间隔保存，更早的数据聚合成 10 分钟一个点。
  - 每个节点的历史是一个 KV 文档。
- **不支持 SMTP 和 TCP**：ESA 函数不能建立 TCP 连接，所以不支持 SMTP 邮件；TCP 类型的网站监控必须开启 Agent 探测。
- **用量估算**：后台 **设置 → 通用设置** 会根据节点数和各项间隔，估算每日的函数请求数、KV 读写次数和存储量。实际计费和免费额度以 ESA 控制台为准。

## 本地开发

```bash
npm ci
npm run build              # 构建前端和函数 bundle
npm run dev                # 本地 ESA 模拟服务器 http://localhost:8787（KV 持久化到 .dev/kv.json）
npm run dev:frontend       # Vite 开发服务器，/api 代理到 8787
```

常用检查：

```bash
npm run verify             # lint + 构建 + JS/Go 测试 + 依赖安全检查
```

## 安全

- 后台登录使用 HttpOnly 会话 Cookie，非安全写请求需要 CSRF 校验，支持 TOTP 两步验证和敏感操作二次验证。
- 登录失败按 IP 以及 IP + 账号两个维度限流，并记录审计日志。
- Agent 使用节点 Token 认证（按哈希比对），后台可轮换节点 Token。
- Ping 和网站探测会拦截内网、回环、链路本地、组播、保留地址和元数据地址。
- 恢复密钥只在本次请求中比对，不会被保存。

## 许可证

本项目使用 [MIT License](LICENSE)，基于 [kadidalax/cf-vps-monitor](https://github.com/kadidalax/cf-vps-monitor)。

## 参考文档

- [ESA 产品文档](https://help.aliyun.com/zh/edge-security-acceleration/esa/)
- [ESA 函数和 Pages：构建与 esa.jsonc](https://help.aliyun.com/zh/edge-security-acceleration/esa/user-guide/build-pages)
- [ESA CLI（esa-cli）](https://www.npmjs.com/package/esa-cli)
