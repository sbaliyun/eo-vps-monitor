/**
 * 公开 API：站点设置、节点列表、实时数据（HTTP 轮询）、历史图表、网站监控。
 */

import { Hono } from 'hono';
import type { PingTask } from '../db/types';
import { adminSettingsOf, publicSettingsOf, readCore, sortedClients, toClientView, metaVersionOf } from '../store/core';
import type { CoreDoc, LiveEntry } from '../store/types';
import { buildLiveSnapshot, markViewerActive, readLiveEntries, viewerTtlMs } from '../store/live';
import { queryGpu, queryPing, queryRecords, readNodeDoc, recentRecords } from '../store/history';
import { readWebsites, runtimeFor, toPublicWebsiteMonitor, listChecks } from '../store/websites';
import { readSiteLogo } from '../store/themes';
import { toPublicClient, type PublicClient } from '../utils/public-client';
import { base64ToBytes } from '../utils/theme-package';
import { maybeRunMaintenance } from '../services/maintenance';
import { noStoreJson, publicRateLimit, readIntParam, services, wantsIncludeHidden, type AppContext, type HonoEnv } from './common';

export const publicRoutes = new Hono<HonoEnv>();

const MAX_PUBLIC_RECORD_RANGE_MS = 3 * 24 * 60 * 60 * 1000 + 60_000;
const SITE_LOGO_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

export function publicClientsOf(core: CoreDoc, entries: Map<string, LiveEntry>, includeHidden: boolean): PublicClient[] {
  return sortedClients(core)
    .filter(client => includeHidden || !client.hidden)
    .map(client => toPublicClient(toClientView(client, entries.get(client.uuid)?.m)));
}

function nodesOf(clients: PublicClient[]) {
  return clients.map(client => ({ ...client, tags: client.tags ? client.tags.split(';').filter(Boolean) : [] }));
}

function visibleClient(core: CoreDoc, uuid: string, includeHidden: boolean): boolean {
  const client = core.clients.find(item => item.uuid === uuid);
  return Boolean(client && (includeHidden || !client.hidden));
}

/** 访客在看实时数据（前端在活跃窗口内带 viewer=active）时，让 Agent 切到高频上报，并顺带执行维护。 */
async function afterLiveRead(c: AppContext, core: CoreDoc): Promise<void> {
  const app = services(c);
  if (c.req.query('viewer') === 'active') {
    try {
      await markViewerActive(app, viewerTtlMs(adminSettingsOf(core)));
    } catch (error) {
      console.warn('[live] mark viewer failed:', error instanceof Error ? error.message : String(error));
    }
  }
  if (app.kv.remaining() >= 4) app.waitUntil(maybeRunMaintenance(app, 'viewer'));
}

publicRoutes.get('/public', async (c) => {
  const core = await readCore(services(c));
  return noStoreJson(publicSettingsOf(core));
});

publicRoutes.get('/public/bootstrap', async (c) => {
  const limited = publicRateLimit(c, 'bootstrap', 120);
  if (limited) return limited;
  const app = services(c);
  const includeHidden = await wantsIncludeHidden(c);
  const core = await readCore(app);
  const entries = await readLiveEntries(app, core);
  const clients = publicClientsOf(core, entries, includeHidden);
  const now = app.now();
  const response = noStoreJson({
    settings: publicSettingsOf(core),
    clients,
    nodes: nodesOf(clients),
    live: buildLiveSnapshot(core, entries, includeHidden, now),
    metadata_version: metaVersionOf(core),
    snapshot_at: now,
    server_time: now,
  });
  await afterLiveRead(c, core);
  return response;
});

publicRoutes.get('/clients', async (c) => {
  const app = services(c);
  const includeHidden = await wantsIncludeHidden(c);
  const core = await readCore(app);
  return noStoreJson(publicClientsOf(core, await readLiveEntries(app, core, 10_000), includeHidden));
});

publicRoutes.get('/nodes', async (c) => {
  const app = services(c);
  const includeHidden = await wantsIncludeHidden(c);
  const core = await readCore(app);
  return noStoreJson(nodesOf(publicClientsOf(core, await readLiveEntries(app, core, 10_000), includeHidden)));
});

async function liveResponse(c: AppContext): Promise<Response> {
  const limited = publicRateLimit(c, 'live', 240);
  if (limited) return limited;
  const app = services(c);
  const includeHidden = await wantsIncludeHidden(c);
  const core = await readCore(app);
  const entries = await readLiveEntries(app, core);
  const snapshot = buildLiveSnapshot(core, entries, includeHidden, app.now());
  await afterLiveRead(c, core);
  return noStoreJson(snapshot);
}

publicRoutes.get('/live', liveResponse);
publicRoutes.get('/live/clients', liveResponse);
publicRoutes.get('/ws/live', liveResponse);

// ESA 函数不提供 WebSocket 服务端：返回 404，前端直接走 HTTP 轮询。
publicRoutes.get('/ws/live-token', (c) => c.json({ error: 'WebSocket 不可用，请使用 HTTP 轮询', polling: true }, 404));

function validateRange(start: string, end: string): string | null {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return '时间范围格式无效';
  if (endMs < startMs) return '结束时间不能早于开始时间';
  if (endMs - startMs > MAX_PUBLIC_RECORD_RANGE_MS) return '公开历史查询最多支持 3 天时间范围';
  return null;
}

function cursorMs(value: string | undefined): number | null | 'invalid' {
  const text = (value || '').trim();
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 'invalid';
}

function wantsPaged(c: AppContext): boolean {
  return c.req.query('paged') === 'true' || c.req.query('page') !== undefined || c.req.query('cursor') !== undefined;
}

function pagedResult<T>(data: T[], limit: number) {
  return { data, total: data.length, page: 1, limit, has_more: false };
}

publicRoutes.get('/recent/:uuid', async (c) => {
  const limited = publicRateLimit(c, 'history', 120);
  if (limited) return limited;
  const app = services(c);
  const uuid = c.req.param('uuid');
  const includeHidden = await wantsIncludeHidden(c);
  const core = await readCore(app);
  if (!visibleClient(core, uuid, includeHidden)) return noStoreJson([]);
  const doc = await readNodeDoc(app, uuid);
  return noStoreJson(recentRecords(doc, readIntParam(c.req.query('limit'), 30, 150)));
});

publicRoutes.get('/records/load', async (c) => {
  const limited = publicRateLimit(c, 'history', 120);
  if (limited) return limited;
  const uuid = c.req.query('uuid');
  if (!uuid) return c.json({ error: '缺少 uuid 参数' }, 400);
  const start = c.req.query('start');
  const end = c.req.query('end');
  if (start && end) {
    const rangeError = validateRange(start, end);
    if (rangeError) return c.json({ error: rangeError }, 400);
  }
  const cursor = cursorMs(c.req.query('cursor'));
  if (cursor === 'invalid') return c.json({ error: 'cursor 参数无效' }, 400);
  const app = services(c);
  const includeHidden = await wantsIncludeHidden(c);
  const core = await readCore(app);
  const limit = readIntParam(c.req.query('limit'), 500, 1000);
  if (!visibleClient(core, uuid, includeHidden)) return noStoreJson(wantsPaged(c) ? pagedResult([], limit) : []);
  const doc = await readNodeDoc(app, uuid);
  const now = app.now();
  const endMs = Math.min(end ? Date.parse(end) : now, cursor ?? Number.POSITIVE_INFINITY);
  const startMs = start ? Date.parse(start) : endMs - 3600_000;
  const records = start || end
    ? queryRecords(doc, startMs, endMs, limit)
    : recentRecords(doc, readIntParam(c.req.query('limit'), 150, 500));
  return noStoreJson(wantsPaged(c) ? pagedResult(records, limit) : records);
});

publicRoutes.get('/records/gpu', async (c) => {
  const limited = publicRateLimit(c, 'history', 120);
  if (limited) return limited;
  const uuid = c.req.query('uuid');
  if (!uuid) return c.json({ error: '缺少 uuid 参数' }, 400);
  const start = c.req.query('start');
  const end = c.req.query('end');
  if (start && end) {
    const rangeError = validateRange(start, end);
    if (rangeError) return c.json({ error: rangeError }, 400);
  }
  const cursor = cursorMs(c.req.query('cursor'));
  if (cursor === 'invalid') return c.json({ error: 'cursor 参数无效' }, 400);
  const app = services(c);
  const includeHidden = await wantsIncludeHidden(c);
  const core = await readCore(app);
  const limit = readIntParam(c.req.query('limit'), 100, 2000);
  if (!visibleClient(core, uuid, includeHidden)) return noStoreJson(wantsPaged(c) ? pagedResult([], limit) : []);
  const doc = await readNodeDoc(app, uuid);
  const endMs = Math.min(end ? Date.parse(end) : app.now(), cursor ?? Number.POSITIVE_INFINITY);
  const records = queryGpu(doc, start ? Date.parse(start) : null, endMs, limit);
  return noStoreJson(wantsPaged(c) ? pagedResult(records, limit) : records);
});

publicRoutes.get('/records/ping', async (c) => {
  const limited = publicRateLimit(c, 'history', 120);
  if (limited) return limited;
  const uuid = c.req.query('uuid');
  const taskId = Number.parseInt(c.req.query('task_id') || '0', 10);
  if (!uuid || !taskId) return c.json({ error: '缺少参数' }, 400);
  const cursor = cursorMs(c.req.query('cursor'));
  if (cursor === 'invalid') return c.json({ error: 'cursor 参数无效' }, 400);
  const app = services(c);
  const includeHidden = await wantsIncludeHidden(c);
  const core = await readCore(app);
  const limit = readIntParam(c.req.query('limit'), 120, 720);
  if (!visibleClient(core, uuid, includeHidden)) return noStoreJson(wantsPaged(c) ? pagedResult([], limit) : []);
  const doc = await readNodeDoc(app, uuid);
  const records = queryPing(doc, taskId, { limit, cursorMs: cursor ?? undefined });
  return noStoreJson(wantsPaged(c) ? pagedResult(records, limit) : records);
});

publicRoutes.get('/records/ping/batch', async (c) => {
  const limited = publicRateLimit(c, 'history', 120);
  if (limited) return limited;
  const uuid = c.req.query('uuid');
  const specs: Array<{ taskId: number; limit: number; intervalSec: number }> = [];
  const seen = new Set<number>();
  for (const raw of (c.req.query('task_specs') || '').split(',')) {
    const [taskText, limitText, intervalText] = raw.split(':');
    const taskId = Number.parseInt(taskText || '', 10);
    if (!Number.isInteger(taskId) || taskId <= 0 || seen.has(taskId)) continue;
    seen.add(taskId);
    specs.push({ taskId, limit: readIntParam(limitText, 120, 720), intervalSec: readIntParam(intervalText, 60, 86_400) });
    if (specs.length >= 16) break;
  }
  for (const raw of (c.req.query('task_ids') || '').split(',')) {
    const taskId = Number.parseInt(raw.trim(), 10);
    if (!Number.isInteger(taskId) || taskId <= 0 || seen.has(taskId) || specs.length >= 16) continue;
    seen.add(taskId);
    specs.push({ taskId, limit: readIntParam(c.req.query('limit'), 120, 720), intervalSec: 60 });
  }
  if (!uuid || specs.length === 0) return c.json({ error: '缺少参数' }, 400);
  const cursor = cursorMs(c.req.query('cursor'));
  if (cursor === 'invalid') return c.json({ error: 'cursor 参数无效' }, 400);
  const app = services(c);
  const includeHidden = await wantsIncludeHidden(c);
  const core = await readCore(app);
  if (!visibleClient(core, uuid, includeHidden)) return noStoreJson({});
  const doc = await readNodeDoc(app, uuid);
  const result: Record<string, unknown> = {};
  for (const spec of specs) {
    // 按请求的时间跨度截取：limit 个点 × 采样间隔。
    const spanMs = spec.limit * spec.intervalSec * 1000;
    const endMs = cursor ?? app.now();
    result[String(spec.taskId)] = queryPing(doc, spec.taskId, { limit: spec.limit, startMs: endMs - spanMs, cursorMs: endMs });
  }
  return noStoreJson(result);
});

function publicPingTasks(core: CoreDoc, includeHidden: boolean): PingTask[] {
  const visible = new Set(core.clients.filter(client => includeHidden || !client.hidden).map(client => client.uuid));
  const settings = adminSettingsOf(core);
  const interval = Math.min(3600, Math.max(60, Number(settings.ping_record_persist_interval_sec) || 120));
  return core.ping_tasks
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || (a.id ?? 0) - (b.id ?? 0))
    .flatMap((task) => {
      if (task.all_clients) return [{ ...task, clients: [], interval_sec: interval }];
      const clients = task.clients.filter(uuid => visible.has(uuid));
      return clients.length > 0 ? [{ ...task, clients, interval_sec: interval }] : [];
    });
}

publicRoutes.get('/task/ping', async (c) => {
  const includeHidden = await wantsIncludeHidden(c);
  const core = await readCore(services(c));
  return noStoreJson(publicPingTasks(core, includeHidden));
});

publicRoutes.get('/websites', async (c) => {
  const limited = publicRateLimit(c, 'websites', 120);
  if (limited) return limited;
  const app = services(c);
  const includeHidden = await wantsIncludeHidden(c);
  const hours = readIntParam(c.req.query('hours'), 24, 72);
  const core = await readCore(app);
  const monitors = core.websites
    .filter(monitor => includeHidden || !monitor.hidden)
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.id - b.id);
  if (monitors.length === 0) return noStoreJson([]);
  const doc = await readWebsites(app);
  const sinceSec = Math.floor(app.now() / 1000) - hours * 3600;
  return noStoreJson(monitors.map(monitor => toPublicWebsiteMonitor(monitor, runtimeFor(doc, monitor), 500, sinceSec)));
});

publicRoutes.get('/websites/:id/checks', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'Not Found' }, 404);
  const app = services(c);
  const includeHidden = await wantsIncludeHidden(c);
  const core = await readCore(app);
  const monitor = core.websites.find(item => item.id === id && (includeHidden || !item.hidden));
  if (!monitor) return c.json({ error: 'Not Found' }, 404);
  const doc = await readWebsites(app);
  const checks = listChecks(monitor, runtimeFor(doc, monitor), readIntParam(c.req.query('limit'), 120, 500)).map(check => ({
    checked_at: check.checked_at,
    ok: check.ok,
    effective_status: check.effective_status,
    effective_reason: check.effective_reason,
    status_code: check.status_code,
    raw_status_code: check.raw_status_code,
    latency_ms: check.latency_ms,
  }));
  return noStoreJson(checks);
});

publicRoutes.get('/websites/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'Not Found' }, 404);
  const app = services(c);
  const includeHidden = await wantsIncludeHidden(c);
  const core = await readCore(app);
  const monitor = core.websites.find(item => item.id === id && (includeHidden || !item.hidden));
  if (!monitor) return c.json({ error: 'Not Found' }, 404);
  const doc = await readWebsites(app);
  return noStoreJson(toPublicWebsiteMonitor(monitor, runtimeFor(doc, monitor), readIntParam(c.req.query('limit'), 120, 500), 0));
});

publicRoutes.get('/site-logo', async (c) => {
  const logo = await readSiteLogo(services(c));
  if (!logo || !SITE_LOGO_TYPES.has(logo.type)) return c.body(null, 404);
  return new Response(base64ToBytes(logo.data), {
    headers: {
      'Content-Type': logo.type,
      'Cache-Control': 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; script-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    },
  });
});
