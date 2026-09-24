/**
 * Agent 接口（HTTP 模式）。
 */

import { Hono } from 'hono';
import { adminSettingsOf } from '../store/core';
import { localRateLimit } from '../store/ratelimit';
import { authenticateAgent, buildAgentPolicy, extractReportItems, ingestReports, pingTasksForClient } from '../services/agent';
import { maybeRunMaintenance } from '../services/maintenance';
import { flushAudit } from '../services/notify';
import { clientIp, isObject, services, type AppContext, type HonoEnv } from './common';
import { readJsonWithLimit } from '../utils/request-body';

export const agentRoutes = new Hono<HonoEnv>();

const REPORT_MAX_BODY_BYTES = 512 * 1024;

function bearerToken(c: AppContext): string {
  const header = c.req.header('Authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

async function requireAgent(c: AppContext) {
  const app = services(c);
  const ip = clientIp(c);
  const attempt = localRateLimit(`agent-auth-attempt:${ip}`, 600, 60_000, app.now());
  if (!attempt.allowed) {
    c.header('Retry-After', String(attempt.retryAfter));
    return { response: c.json({ error: '请求过于频繁' }, 429) };
  }
  const token = bearerToken(c);
  const auth = token ? await authenticateAgent(app, token) : null;
  if (!auth) {
    const failure = localRateLimit(`agent-auth-failure:${ip}`, 20, 60_000, app.now());
    if (!failure.allowed) {
      c.header('Retry-After', String(failure.retryAfter));
      return { response: c.json({ error: '认证失败次数过多，请稍后重试' }, 429) };
    }
    return { response: c.json({ error: 'Unauthorized' }, 401) };
  }
  return { auth };
}

agentRoutes.post('/register', (c) => c.json({ error: '自动注册已移除，请在后台添加节点后使用安装命令' }, 410));

agentRoutes.get('/policy', async (c) => {
  const result = await requireAgent(c);
  if ('response' in result) return result.response;
  const app = services(c);
  const policy = await buildAgentPolicy(app, result.auth.core, result.auth.client);
  // 顺带执行定时维护（ESA 没有 Cron）。
  if (app.kv.remaining() >= 4) app.waitUntil(maybeRunMaintenance(app, 'agent'));
  return c.json(policy);
});

agentRoutes.post('/report', async (c) => {
  const result = await requireAgent(c);
  if ('response' in result) return result.response;
  const app = services(c);
  const { core, client } = result.auth;
  const limited = localRateLimit(`agent-report:${client.uuid}`, 120, 60_000, app.now());
  if (!limited.allowed) {
    c.header('Retry-After', String(limited.retryAfter));
    return c.json({ error: `请求过于频繁，请 ${limited.retryAfter} 秒后重试` }, 429);
  }
  const parsed = await readJsonWithLimit(c.req.raw, REPORT_MAX_BODY_BYTES);
  if (!parsed.ok) {
    return parsed.reason === 'too_large'
      ? c.json({ error: `上报数据不能超过 ${REPORT_MAX_BODY_BYTES} 字节` }, 413)
      : c.json({ error: '上报数据 JSON 格式错误' }, 400);
  }
  if (!isObject(parsed.body)) return c.json({ error: '上报数据必须是 JSON 对象' }, 400);
  const items = extractReportItems(parsed.body);
  if (items.length === 0) return c.json({ error: '上报数据不能为空' }, 400);
  try {
    const ingest = await ingestReports(app, core, client, items, clientIp(c, ''));
    app.waitUntil(flushAudit(app, Number(adminSettingsOf(core).audit_log_preserve_time || 2160)));
    return c.json({ success: true, persisted: ingest.persisted, accepted: ingest.accepted });
  } catch (error) {
    console.error('[agent] report failed:', error instanceof Error ? error.message : String(error));
    return c.json({ error: '上报失败' }, 500);
  }
});

agentRoutes.get('/ping/tasks', async (c) => {
  const result = await requireAgent(c);
  if ('response' in result) return result.response;
  const settings = adminSettingsOf(result.auth.core);
  const interval = Math.min(3600, Math.max(60, Number(settings.ping_record_persist_interval_sec) || 120));
  const tasks = pingTasksForClient(result.auth.core, result.auth.client.uuid, interval);
  if (c.req.query('format') === 'v2') return c.json({ tasks, next_poll_sec: tasks.length ? 3600 : 600 });
  return c.json(tasks);
});

agentRoutes.post('/uploadBasicInfo', (c) => c.json({ error: '请升级 Agent：基础信息已随 /api/clients/report 上报' }, 410));
agentRoutes.post('/ping/result', (c) => c.json({ error: '请升级 Agent：Ping 结果已随 /api/clients/report 上报' }, 410));

// ESA 函数不支持 WebSocket 服务端：提示以 HTTP 模式运行 Agent。
agentRoutes.get('/report', (c) => c.json({
  error: 'ESA 部署不支持 WebSocket 上报，请使用 --mode http（或设置 CF_MONITOR_MODE=http）重新安装 Agent',
  mode: 'http',
}, 426));
