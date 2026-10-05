# EO VPS Monitor

运行在 **腾讯云 EdgeOne Pages + 原生 KV** 上的 VPS 监控面板，不需要 Supabase 或 SQL 数据库。

此版本以 [sbaliyun/esa-vps-monitor](https://github.com/sbaliyun/esa-vps-monitor) 的 HTTP/KV 实现为基础，移植 [sbaliyun/cf-vps-monitor](https://github.com/sbaliyun/cf-vps-monitor) 的监控业务。ESA 参考仓库可能需要授权访问。保留节点管理、公开状态页、历史曲线、Ping、网站监控、Telegram/Webhook 通知、主题和加密配置备份。当前代码不是 Cloudflare 最新分支的逐项等价移植。

## 快速部署

### 1. 构建

使用 Node.js 24.5.0 或更新的兼容版本。在本仓库根目录执行：

```bash
npm ci
npm run build
```

完整部署目录是 **`edgeone-dist/`**，包括前端、`edge-functions/`、`edgeone.json` 和 Agent 源码归档。只上传 `frontend/dist/` 会缺少 API。

### 2. 创建 EdgeOne Pages 项目

可以选择以下一种方式：

- **导入 Git 仓库**：将此版本推送到自己的仓库，控制台导入该仓库，根目录为本仓库根目录。安装命令 `npm ci`，构建命令 `npm run build`，输出目录 `edgeone-dist`，Node.js 24.5.0。根目录 `edgeone.json` 已配置这些选项。
- **本地 CLI 部署**：创建或选择一个“直接上传”类型的 Pages 项目，登录后部署完整产物：

```bash
npx edgeone login
npx edgeone pages deploy ./edgeone-dist -n 你的项目名称 -e production
```

CLI 输出是部署证据，本地构建成功不代表已经上线。有关产物中的函数目录和 CLI 参数，参见 [EO 官方部署文档](https://edgeone.cloud.tencent.com/pages/document/162936923278893056)。

### 3. 绑定 KV 并设置密钥

在 **该 Pages 项目** 的 KV 存储中创建命名空间，绑定变量名必须是 **`MONITOR_KV`**。这是具体 KV binding，不是填写命名空间名称的字符串。

| 配置 | 必填 | 用途 |
| --- | --- | --- |
| `MONITOR_KV` | 是 | Pages 原生 KV binding |
| `JWT_SECRET` | 是 | 至少 32 字节的随机会话签名密钥 |
| `ADMIN_RECOVERY_KEY` | 是 | 至少 32 字节的独立随机管理员初始化/恢复密钥，与 JWT 密钥使用不同值 |
| `CRON_SECRET` | 建议 | 外部定时任务的密钥；未设置时由 JWT 密钥派生 |
| `AGENT_REPOSITORY` | 否 | 可公开下载 Agent Release 的 `owner/repo`；默认 `sbaliyun/cf-vps-monitor` |
| `LIVE_SHARDS` | 否 | 实时状态分片数，1–4，默认 1；增加分片会增加读取次数 |
| `KV_OPS_PER_REQUEST` | 否 | 应用基础 KV 操作预算，默认 8；完整实时快照会按节点数补足必需读取额度，维护仍使用基础预算 |
| `SUBREQUESTS_PER_REQUEST` | 否 | 应用自己的出站请求预算，默认 4 |
| `CURRENT_GIT_COMMIT` | 否 | 构建版本展示；构建时也会读取本地 Git HEAD |

以上预算不是 EO 套餐的官方限额。实际额度和计费以控制台为准。绑定、密钥或变量变更后重新部署，并分别检查 production/preview 环境。

生成两个不同的随机密钥，例如将下面命令运行两次，分别保存：

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

### 4. 初始化管理员

1. 打开 `https://你的域名/db-init`，检查 KV 与两项密钥。
2. 打开 `/login`，首次使用会显示 **“创建管理员”** 表单。填写 `ADMIN_RECOVERY_KEY`、用户名和新密码；已有账号的重置入口是“忘记密码”。
3. 返回登录页，用创建的账号密码登录。普通首次登录不会自动创建管理员。
4. 后台添加节点，复制安装命令，在 VPS 上执行。

恢复密钥只应由管理员持有。后台账号保持单个；不要并发进行初始化、恢复或配置修改。此版本禁用 MFA、一次性恢复码和相关接口：KV 缺少原子消费能力。导入的旧账号如启用了 MFA，须通过管理员恢复流程重置。

### 5. Agent 安装

安装命令默认 **`--mode http`**，从你的 EO 站点 `/agent/install.sh` 或 `/agent/install-windows.ps1` 获取脚本。无需访问私有 ESA 仓库。

安装器先尝试下载 `AGENT_REPOSITORY` 的 Release；默认下载源没有可用 Release 时，从当前站点下载本版本 Agent 源码归档并编译。这条路径需要 VPS 安装 Go，具体最低版本以 `agent/go.mod` 为准，同时需要能下载 Go 模块。无 Go 且无可用 Release 时安装器会明确报错，不会假装安装成功。

可将本版本推送到自己的公开仓库，修复下文的依赖安全门禁后运行 **Actions → Agent Release** 发布二进制，然后设置 `AGENT_REPOSITORY=你的用户名/仓库名` 并重新部署。避免将与当前面板不兼容的 Agent Release 作为下载源。

公开 CF Agent 的基本 HTTP 上报协议可兼容；**SSL 证书探测需要本版本 Agent**，其他来源的旧 Agent 可能没有该功能。安装后的可用性应以节点真实上报为准。

### 6. 告警的定时触发

离线、到期、负载、网站检测等维护任务随 Agent 拉取策略和访客访问触发。没有任何请求时，边缘函数不会自行运行。

为了在所有节点掉线、无人访问时仍检测告警，配置外部定时器，每 1–5 分钟请求一次：

```bash
curl --fail -X POST 'https://你的域名/api/cron' \
  -H 'Authorization: Bearer 你设置的CRON_SECRET'
```

也支持 `/api/cron?key=密钥`，后台“设置 → 通用设置”可复制地址；支持请求头的定时器优先使用 Bearer。这里没有实现或假设 EO 自带 Cloudflare Cron Triggers。

## 使用与限制

| Cloudflare 原方案 | 本 EO 版本 |
| --- | --- |
| Supabase/Postgres | 原生 KV 文档，包含配置、每节点历史、实时状态、告警、网站状态和审计 |
| Durable Objects / WebSocket | HTTP Agent 上报 + 前端轮询 |
| Cron Triggers | 请求触发维护 + 外部定时器 |
| SQL 事务 / 原子更新 | KV 读改写，无事务、CAS 或原子锁 |
| SMTP | Telegram/Webhook；SMTP 和边缘 TCP 检测不可用，TCP 可由 Agent 检测 |

**数据一致性**：EO KV 是最终一致存储，[官方文档](https://pages.edgeone.ai/document/kv-storage) 提醒跨节点同步可能需要约 60 秒。登录后的新节点、Token 轮换、改密码、删除或隐藏节点可能暂时未在其他节点生效。同一节点的上报跨边缘副本读取旧文档后写回，可能覆盖较新的采样并永久丢失部分历史；并发后台保存也可能互相覆盖。建议单管理员顺序保存、每节点只运行一个 Agent。此版适合接受这些限制的个人监控面板，不提供数据库级一致性。

**在线状态**：完整实时快照逐个读取节点自己的状态，最多 8 个读取并发；共享汇总只作为兜底，不能因基础预算不足漏掉其他在线节点。基础信息上报先核对节点自己的最新心跳，避免旧汇总覆盖已有状态。EO 在线有效期同时覆盖空闲上传周期、最长 60 秒的 KV 缓存及 30 秒调度余量；默认空闲上传 120 秒时，至少在最后收到上报后的 210 秒内保持在线。真正停止上报后超过有效期仍会离线，历史记录不延长在线状态。

**维护与通知**：KV 租约只能尽力减少重复维护，不能保证互斥、恰好一次发送或准点告警。高并发、KV 延迟、外部通知失败或应用预算耗尽可能导致重复、推迟或漏发。登录限流也主要是进程内尽力保护。

**实时与历史**：页面有人查看时默认 5 秒上报，无人查看时默认 120 秒。短期历史保留最近 4 小时的精细数据，更旧的数据聚合为 10 分钟均值，总保留时间最多 72 小时。实时状态、在线状态和流量累积也会受 KV 一致性影响。

**大小与容量**：应用将单个 KV value 限制为 900 KiB，并编码逻辑键以符合 EO 键名规则。EO 边缘函数请求体为 1 MiB、单函数代码包为 5 MiB，参见 [官方函数限制](https://pages.edgeone.ai/document/edge-functions)。EO 模式中 Logo 原图上限 600 KiB，主题 ZIP/备份文件上限 800 KiB，完整上传请求体上限 900 KiB。备份导出会提前检查加密内容和最终 JSON 大小，超限返回 413。节点过多、大量 Ping/审计/资源文件可能耗尽单文档或套餐额度；发生 413 时应缩小数据或降低历史密度。

**备份迁移**：保留 CF 配置备份格式，可导入经过校验的节点、Ping、网站和通知配置。备份不包含旧 SQL 历史、实时数据、主题资源或管理员密码；它不是完整数据库迁移。已有 Supabase 数据不自动搬运。超出 EO 上限的备份需在源面板拆分或缩小后再导入。

**网站与 SSL**：HTTP/HTTPS 可由边缘函数或 Agent 检测；TCP 和 SSL 证书读取交给 Agent。SSL、网站和离线通知均依赖上述维护触发机制与请求预算。

**更新源**：后台“关于”默认不检查私有 ESA 仓库，也不会将 ESA 代码提示为 EO 更新。填写自己的公开 EO 仓库地址后才检查该仓库 `main` 分支；私有仓库的匿名检查会失败。

## 本地开发与检查

```bash
npm ci
npm run build
npm run dev -- --port 8787
```

本地服务器使用真实 EO 入口和模拟 `MONITOR_KV`，数据存入 `.dev/eo-kv.json`。终端仅提供本地开发用默认密钥，勿用于生产。本地模拟无法复现真实跨边缘节点一致性和 EO CPU 额度。

```bash
npm run lint
npm run test:js
npm run test:go
npm run security:check
```

Go 测试需要 Go；PowerShell 行为测试需要 `pwsh`；安装器权限测试需要 Linux/相应服务管理器，部分本地测试会明确跳过。

EO 构建为 Hono 4.13.7 的字符串 JWT 密钥判断与 HMAC 哈希参数增加兼容处理。云端对照测试确认 HMAC 导入使用嵌套的 hash 对象会返回 `Param Invalid`，使用 `hash: "SHA-256"` 字符串则可完成签验；构建将对应 HMAC 参数规范为字符串，同时支持缺少全局 `CryptoKey` 构造器的环境。签名与验证仍由 Hono 完成；升级 Hono、改变对应源码或模块加载路径时构建会失败，需要先审核兼容处理。`/api/setup/status` 会实际检查会话签名和验证；失败时返回并记录经过密钥和令牌脱敏的异常名称、消息、堆栈与失败步骤，同时使用公开合成密钥对照运行 HMAC 参数，不返回令牌、签名或密钥。

密码自检会用公开的 PBKDF2 标准向量核对 EO 的计算结果，再验证随机盐的内存往返；不读写账号、KV 或 Cookie。EO 登录异常 500 还会返回经过凭据脱敏的 `diagnostic`，区分密码验证、会话签名、Cookie 与限流存储等失败阶段。登录页持续显示失败提示，可展开「错误详情」；普通账号密码错误仍返回 401。Pages 当前[日志分析](https://pages.edgeone.ai/zh/document/log-analysis)尚未支持 Edge Functions 日志，在线排障可直接查看接口中的诊断。

本次迁移的本地验证：前后端类型检查及生产构建通过；Worker 240 项、前端 129 项测试通过（前端测试需要可用的 PowerShell `pwsh`）；管理员初始化到 Agent 上报/历史查询的真实 EO 入口通过；源码路由及部署产物均通过官方 CLI 打包方式和入口注入后的实际 VM 调用，其中六个入口均在没有 `CryptoKey` 和 Node 全局对象的环境中通过登录、会话 Cookie 与 CSRF 验证；Go Agent 全量测试通过，源码归档实际编译为 macOS ARM64、Linux AMD64、Windows AMD64。安装器回退和 Release 版本行为也已验证。已连接腾讯云项目进行运行时排障并确认 HMAC 参数差异；实际管理员账号登录仍需在浏览器验证。

完整仓库回归不能在当前 macOS 环境宣称全绿：原有 Linux 服务/权限夹具存在平台差异，已在未修改的 ESA 基线复现。另修复了原有 IPv6 测试夹具：BSD 平台同时模拟 `ping6`，避免误调用真实网络；Go 业务源码没有改动。

当前依赖审计发现 Tailwind 3 的 `braces` 链有 5 项 high 报告，集中在构建工具依赖；`npm audit --omit=dev` 为 0 项，但包含开发依赖的检查仍失败。`npm audit` 给出的完整修复建议是升级 Tailwind 4。没有为了迁移静默跳过安全检查：`security:check` 会失败，GitHub Actions 的 Deploy 和 Agent Release 工作流也会受此安全门禁阻止。这项主要版本升级需另行验证。

## 目录

| 路径 | 内容 |
| --- | --- |
| `edgeone.json` | 构建设置、SPA 回退、API 不缓存 |
| `edge-functions/` | EO 源码路由：API、Agent 安装器、ping |
| `worker/src/edgeone-entry.ts` | EO `onRequest({ request, env })` 入口、可信 clientIp、binding 校验 |
| `worker/src/platform/kv.ts` | EO KV 适配、键/值大小检查、请求缓存 |
| `worker/src/store/` | 复用并调整的 KV 数据模型 |
| `frontend/` | React 面板与公开状态页 |
| `agent/` | Go 探针和安装器 |
| `scripts/build-edgeone.mjs` | 生成完整 `edgeone-dist/` |
| `.github/workflows/deploy-edgeone.yml` | 手动部署；需 `EDGEONE_API_TOKEN` Secret 和 `EDGEONE_PROJECT_NAME` Variable |

`esa-entry.ts` 与 `build-esa.mjs` 仅保留为原测试的兼容入口，正式 EO 构建不使用它们。构建目录、开发 KV、密钥文件不纳入提交。

Git 项目的根 `edge-functions/` 路由引用构建生成的 `worker/dist/edgeone-entry.js`。EO 后端打包器不支持直接将安装器 `.sh/.ps1` 当文本导入，因此必须先完成 `npm run build`，不能省略构建命令。

## 许可

MIT。原项目作者与许可证信息保留在源码和 `LICENSE` 中。
