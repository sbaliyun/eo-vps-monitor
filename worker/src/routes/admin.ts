/**
 * 管理员 API（已通过 adminAuth 鉴权）。
 */

import { Hono } from 'hono';
import type { Client, OfflineNotification, ExpiryNotification, LoadNotification, PingTask, WebsiteMonitor } from '../db/types';
import { SETTING_SCHEMA, buildAdminSettings, sanitizeSettingsForStorage } from '../settings/schema';
import { generateAgentToken, hashAgentToken, validateClientCreateInput, validateClientUpdateInput } from '../utils/client';
import { validatePingTaskInput } from '../utils/ping-task';
import { validateExpiryNotificationInput, validateLoadNotificationInput, validateOfflineNotificationInput } from '../utils/notification';
import { maskSecretPreview, isMaskedSecretPreview } from '../utils/secret-preview';
import { checkWebsiteMonitorHttp, validateWebsiteMonitorInput } from '../utils/website-monitor';
import { readRequestBytesWithLimit } from '../utils/request-body';
import { bytesToBase64 } from '../utils/theme-package';
import { adminSettingsOf, defaultStoredClient, findClient, mutateCore, readCore, sortedClients, toClientView } from '../store/core';
import type { CoreDoc, StoredClient, StoredWebsiteMonitor } from '../store/types';
import { pruneLiveEntries, readLiveEntries } from '../store/live';
import { nodeKey } from '../store/history';
import { applyWebsiteCheck, listChecks, mutateWebsites, readWebsites, runtimeFor, toWebsiteMonitor } from '../store/websites';
import { readAlerts } from '../store/alerts';
import { listAuditLogs } from '../store/audit';
import { SITE_LOGO_KEY } from '../store/themes';
import { queueAudit } from '../services/notify';
import { accountRoutes } from './admin-account';
import { systemAdminRoutes } from './admin-system';
import { readIntParam, readJsonObject, readJsonObjectOrArray, services, type AppContext, type HonoEnv } from './common';

export const adminRoutes = new Hono<HonoEnv>();

adminRoutes.route('/', accountRoutes);
adminRoutes.route('/', systemAdminRoutes);

const MAX_SITE_LOGO_BYTES = 1024 * 1024;
const SETTINGS_SCOPE_KEYS: Record<string, readonly string[]> = {
  site: ['site_title', 'site_subtitle', 'site_description', 'language', 'script_domain', 'site_logo_url'],
  ssl: ['ssl_probe_client', 'ssl_expiry_notify_days'],
  general: [
    'record_enabled', 'record_preserve_time', 'ping_record_preserve_time', 'live_poll_active_interval_sec',
    'live_poll_idle_interval_sec', 'live_poll_active_max_duration_sec', 'record_persist_interval_sec',
    'ping_record_persist_interval_sec', 'record_high_watermark_rows', 'record_high_watermark_bytes',
    'capacity_daily_view_minutes', 'offline_confirm_rounds', 'audit_log_preserve_time',
  ],
  notification: [
    'notification_method', 'telegram_bot_token', 'telegram_chat_id', 'email_smtp_host', 'email_smtp_port',
    'email_smtp_security', 'email_smtp_username', 'email_smtp_password', 'email_smtp_from_address',
    'email_smtp_from_name', 'email_smtp_recipients', 'email_smtp_auth_method', 'webhook_url', 'webhook_format',
    'webhook_secret', 'webhook_method', 'webhook_content_type', 'webhook_headers_json', 'webhook_body_template',
    'webhook_username', 'webhook_password', 'webhook_retry_count', 'enable_ip_change_notification',
    'offline_notify_never_reported',
  ],
  update: ['update_repository_url'],
};

function username(c: AppContext): string {
  return c.get('username') || 'admin';
}

function audit(c: AppContext, action: string, detail: string, level = 'info'): void {
  queueAudit(services(c), username(c), action, detail, level);
}

function hideToken(client: Client): Omit<Client, 'token' | 'token_hash'> {
  const { token: _token, token_hash: _hash, ...safe } = client;
  return safe;
}

async function adminClientViews(c: AppContext, core: CoreDoc): Promise<Array<Omit<Client, 'token' | 'token_hash'>>> {
  const entries = await readLiveEntries(services(c), null, 5_000);
  return sortedClients(core).map(client => hideToken(toClientView(client, entries.get(client.uuid)?.m)));
}

function parseUniqueStringList(value: unknown, maxItems = 500): { ok: true; values: string[] } | { ok: false; error: string } {
  if (!Array.isArray(value)) return { ok: false, error: 'uuids 必须是数组' };
  const values = [...new Set(value.map(item => String(item || '').trim()).filter(Boolean))];
  if (values.length === 0) return { ok: false, error: 'uuids 不能为空' };
  if (values.length > maxItems) return { ok: false, error: `一次最多处理 ${maxItems} 个节点` };
  return { ok: true, values };
}

/** 删除节点时同步清理配置中的引用。 */
function pruneClientReferences(core: CoreDoc, removed: Set<string>) {
  const result = { ping_tasks_updated: 0, load_notifications_updated: 0, load_notifications_deleted: 0, expiry_notifications_deleted: 0, offline_notifications_deleted: 0 };
  core.ping_tasks = core.ping_tasks.flatMap((task) => {
    if (task.all_clients || !task.clients.some(uuid => removed.has(uuid))) return [task];
    result.ping_tasks_updated += 1;
    const clients = task.clients.filter(uuid => !removed.has(uuid));
    return clients.length > 0 ? [{ ...task, clients }] : [];
  });
  core.load_notifications = core.load_notifications.flatMap((rule) => {
    if (rule.clients.length === 0 || !rule.clients.some(uuid => removed.has(uuid))) return [rule];
    const clients = rule.clients.filter(uuid => !removed.has(uuid));
    if (clients.length === 0) {
      result.load_notifications_deleted += 1;
      return [];
    }
    result.load_notifications_updated += 1;
    return [{ ...rule, clients }];
  });
  const offlineBefore = core.offline_notifications.length;
  core.offline_notifications = core.offline_notifications.filter(item => !removed.has(item.client));
  result.offline_notifications_deleted = offlineBefore - core.offline_notifications.length;
  const expiryBefore = core.expiry_notifications.length;
  core.expiry_notifications = core.expiry_notifications.filter(item => !removed.has(item.client));
  result.expiry_notifications_deleted = expiryBefore - core.expiry_notifications.length;
  for (const monitor of core.websites) {
    if (monitor.agent_probe_clients.some(uuid => removed.has(uuid))) {
      monitor.agent_probe_clients = monitor.agent_probe_clients.filter(uuid => !removed.has(uuid));
    }
  }
  return result;
}

async function removeClients(c: AppContext, uuids: string[]) {
  const app = services(c);
  const removedSet = new Set(uuids);
  const outcome = await mutateCore(app, (core) => {
    const before = core.clients.length;
    core.clients = core.clients.filter(client => !removedSet.has(client.uuid));
    const removed = before - core.clients.length;
    const cleanup = removed > 0 ? pruneClientReferences(core, removedSet) : null;
    return { removed, cleanup };
  }, { bumpMeta: true });
  if (outcome.removed > 0) {
    await pruneLiveEntries(app, uuids);
    for (const uuid of uuids) {
      if (!app.kv.canSpend(3)) break;
      await app.kv.delete(nodeKey(uuid));
    }
  }
  return outcome;
}

// ============ 节点管理 ============

adminRoutes.get('/clients', async (c) => {
  const core = await readCore(services(c), c.req.query('refresh') ? 0 : 5_000);
  return c.json(await adminClientViews(c, core));
});

adminRoutes.get('/clients/:uuid', async (c) => {
  const app = services(c);
  const core = await readCore(app);
  const client = findClient(core, c.req.param('uuid'));
  if (!client) return c.json({ error: '客户端不存在' }, 404);
  const entries = await readLiveEntries(app, null, 5_000);
  return c.json(hideToken(toClientView(client, entries.get(client.uuid)?.m)));
});

adminRoutes.post('/clients/add', async (c) => {
  const parsed = await readJsonObject(c);
  if (!parsed.ok) return parsed.response;
  const validated = validateClientCreateInput(parsed.body);
  if (!validated.ok) return c.json({ error: '客户端校验失败', details: validated.errors }, 400);
  const app = services(c);
  const { uuid, token, name } = validated.client;
  const tokenHash = await hashAgentToken(token);
  const now = new Date(app.now()).toISOString();
  const created = await mutateCore(app, (core) => {
    if (core.clients.some(client => client.uuid === uuid || client.token_hash === tokenHash)) return null;
    const sortOrder = core.clients.reduce((max, client) => Math.max(max, client.sort_order ?? 0), 0) + 1;
    const client = defaultStoredClient(uuid, token, tokenHash, name, now, sortOrder);
    core.clients.push(client);
    return client;
  }, { bumpMeta: true });
  if (!created) return c.json({ error: '客户端 UUID 或 Token 已存在' }, 409);
  audit(c, 'client_add', `添加客户端: ${name}`);
  return c.json({ success: true, uuid, token, client: hideToken(toClientView(created, undefined)) });
});

adminRoutes.post('/clients/:uuid/edit', async (c) => {
  const uuid = c.req.param('uuid');
  const parsed = await readJsonObject(c);
  if (!parsed.ok) return parsed.response;
  const validated = validateClientUpdateInput(parsed.body);
  if (!validated.ok) return c.json({ error: '客户端校验失败', details: validated.errors }, 400);
  // 硬件/网络字段由 Agent 上报，后台编辑只接受管理字段。
  const editable = new Set(['name', 'remark', 'public_remark', 'price', 'billing_cycle', 'auto_renewal', 'currency', 'expired_at',
    'group', 'tags', 'hidden', 'traffic_limit', 'traffic_limit_type', 'traffic_reset_day']);
  const patch = Object.fromEntries(Object.entries(validated.client).filter(([key]) => editable.has(key)));
  if (Object.keys(patch).length === 0) return c.json({ success: true, noop: true, changed: 0 });
  const app = services(c);
  const updated = await mutateCore(app, (core) => {
    const client = findClient(core, uuid);
    if (!client) return null;
    Object.assign(client, patch, { updated_at: new Date(app.now()).toISOString() });
    return client;
  }, { bumpMeta: true });
  if (!updated) return c.json({ error: '客户端不存在' }, 404);
  audit(c, 'client_edit', `编辑客户端: ${uuid}`);
  const entries = await readLiveEntries(app, null, 5_000);
  return c.json({ success: true, changed: 1, client: hideToken(toClientView(updated, entries.get(uuid)?.m)) });
});

adminRoutes.post('/clients/:uuid/remove', async (c) => {
  const uuid = c.req.param('uuid');
  const parsed = await readJsonObject(c);
  if (!parsed.ok) return parsed.response;
  const outcome = await removeClients(c, [uuid]);
  if (outcome.removed === 0) return c.json({ error: '客户端不存在', removed: 0 }, 404);
  audit(c, 'client_remove', `删除客户端: ${uuid}; 清理引用: ${JSON.stringify(outcome.cleanup)}`);
  return c.json({ success: true, removed: outcome.removed, deleted_records: {} });
});

async function installToken(c: AppContext): Promise<Response> {
  const core = await readCore(services(c), 0);
  const client = findClient(core, c.req.param('uuid')!);
  if (!client) return c.json({ error: '客户端不存在' }, 404);
  if (!client.token) return c.json({ error: 'Token 明文不存在，请手动重置 Token 后再复制安装命令' }, 409);
  return c.json({ token: client.token, rotated: false });
}

adminRoutes.post('/clients/:uuid/token', installToken);
adminRoutes.post('/clients/:uuid/token/install', installToken);

adminRoutes.post('/clients/:uuid/token/rotate', async (c) => {
  const uuid = c.req.param('uuid');
  const app = services(c);
  const token = generateAgentToken();
  const tokenHash = await hashAgentToken(token);
  const updated = await mutateCore(app, (core) => {
    const client = findClient(core, uuid);
    if (!client) return null;
    client.token = token;
    client.token_hash = tokenHash;
    client.token_rotated_at = new Date(app.now()).toISOString();
    client.updated_at = client.token_rotated_at;
    return client;
  });
  if (!updated) return c.json({ error: '客户端不存在' }, 404);
  audit(c, 'client_token_rotate', `重置客户端 Token: ${updated.name || uuid}`);
  return c.json({ success: true, token });
});

adminRoutes.post('/clients/reorder', async (c) => {
  const parsed = await readJsonObject(c);
  if (!parsed.ok) return parsed.response;
  const uuids = Array.isArray(parsed.body.uuids) ? parsed.body.uuids.map(uuid => String(uuid || '').trim()).filter(Boolean) : [];
  if (uuids.length === 0) return c.json({ error: '客户端排序列表不能为空' }, 400);
  if (new Set(uuids).size !== uuids.length) return c.json({ error: '客户端排序列表不能包含重复 UUID' }, 400);
  const result = await mutateCore(services(c), (core) => {
    const byUuid = new Map(core.clients.map(client => [client.uuid, client]));
    const missing = uuids.filter(uuid => !byUuid.has(uuid));
    let order = 1;
    for (const uuid of uuids) {
      const client = byUuid.get(uuid);
      if (client) client.sort_order = order++;
    }
    for (const client of sortedClients(core)) if (!uuids.includes(client.uuid)) client.sort_order = order++;
    return { updated: uuids.length - missing.length, missing };
  }, { bumpMeta: true });
  audit(c, 'client_reorder', `调整客户端排序: ${uuids.join(',')}`);
  return c.json({ success: true, ...result });
});

adminRoutes.post('/clients/batch-hide', async (c) => {
  const parsed = await readJsonObject(c);
  if (!parsed.ok) return parsed.response;
  const list = parseUniqueStringList(parsed.body.uuids);
  if (!list.ok) return c.json({ error: list.error }, 400);
  const app = services(c);
  const result = await mutateCore(app, (core) => {
    let updated = 0;
    let changed = 0;
    const missing: string[] = [];
    for (const uuid of list.values) {
      const client = findClient(core, uuid);
      if (!client) {
        missing.push(uuid);
        continue;
      }
      updated += 1;
      if (!client.hidden) {
        client.hidden = true;
        client.updated_at = new Date(app.now()).toISOString();
        changed += 1;
      }
    }
    return { updated, changed, missing };
  }, { bumpMeta: true });
  audit(c, 'client_batch_hide', `批量隐藏客户端: ${list.values.join(',')}; updated=${result.updated}`);
  return c.json({ success: true, ...result });
});

adminRoutes.post('/clients/batch-remove', async (c) => {
  const parsed = await readJsonObject(c);
  if (!parsed.ok) return parsed.response;
  const list = parseUniqueStringList(parsed.body.uuids);
  if (!list.ok) return c.json({ error: list.error }, 400);
  const core = await readCore(services(c), 0);
  const existing = list.values.filter(uuid => findClient(core, uuid));
  const missing = list.values.filter(uuid => !existing.includes(uuid));
  const outcome = existing.length > 0 ? await removeClients(c, existing) : { removed: 0, cleanup: null };
  audit(c, 'client_batch_remove', `批量删除客户端: ${existing.join(',')}; removed=${outcome.removed}; 清理引用: ${JSON.stringify(outcome.cleanup)}`);
  return c.json({ success: true, removed: outcome.removed, missing, deleted_records: {}, cleanup: outcome.cleanup });
});

// ============ 历史记录 ============

adminRoutes.post('/record/clear', async (c) => {
  const parsed = await readJsonObject(c);
  if (!parsed.ok) return parsed.response;
  const uuid = typeof parsed.body.uuid === 'string' ? parsed.body.uuid.trim() : '';
  if (uuid) await services(c).kv.delete(nodeKey(uuid));
  audit(c, 'record_clear', `清除记录: ${uuid}`);
  return c.json({ success: true });
});

adminRoutes.post('/record/clear/all', async (c) => {
  const parsed = await readJsonObject(c);
  if (!parsed.ok) return parsed.response;
  const app = services(c);
  const core = await readCore(app, 0);
  let deleted = 0;
  for (const client of core.clients) {
    if (!app.kv.canSpend(3)) break;
    await app.kv.delete(nodeKey(client.uuid));
    deleted += 1;
  }
  const remaining = core.clients.length - deleted;
  audit(c, 'record_clear_all', `清除所有记录: deleted=${deleted}; remaining=${remaining}`, remaining > 0 ? 'warning' : 'info');
  return c.json({ success: true, complete: remaining === 0, has_more: remaining > 0, deleted: { nodes: deleted }, remaining: { nodes: remaining } });
});

// ============ Ping 任务 ============

function sortedPingTasks(core: CoreDoc): PingTask[] {
  return [...core.ping_tasks].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || (a.id ?? 0) - (b.id ?? 0));
}

adminRoutes.get('/ping', async (c) => {
  const core = await readCore(services(c), c.req.query('refresh') ? 0 : 5_000);
  return c.json(sortedPingTasks(core));
});

async function upsertPingTask(c: AppContext, id: number | null): Promise<Response> {
  const parsed = await readJsonObject(c);
  if (!parsed.ok) return parsed.response;
  const candidate: Record<string, unknown> = { ...parsed.body, interval: 60, interval_sec: 60 };
  const app = services(c);
  const core = await readCore(app, 0);
  const allowed = candidate.all_clients ? undefined : new Set(core.clients.map(client => client.uuid));
  const validated = validatePingTaskInput(candidate, allowed);
  if (!validated.ok) return c.json({ error: 'Ping 任务校验失败', details: validated.errors }, 400);
  const task = await mutateCore(app, (doc) => {
    if (id === null) {
      doc.seq.ping_task = Math.max(doc.seq.ping_task, ...doc.ping_tasks.map(item => item.id ?? 0)) + 1;
      const created = {
        ...validated.task,
        id: doc.seq.ping_task,
        sort_order: doc.ping_tasks.reduce((max, item) => Math.max(max, item.sort_order ?? 0), 0) + 1,
      };
      doc.ping_tasks.push(created);
      return created;
    }
    const existing = doc.ping_tasks.find(item => item.id === id);
    if (!existing) return null;
    Object.assign(existing, { ...validated.task, id, sort_order: existing.sort_order });
    return existing;
  }, { bumpMeta: true });
  if (!task) return c.json({ error: 'Ping 任务不存在' }, 404);
  audit(c, id === null ? 'ping_add' : 'ping_edit', `${id === null ? '添加' : '编辑'} Ping 任务: ${task.name} ${task.type} ${task.target}`);
  return c.json(id === null ? { success: true, task } : { success: true, changed: 1, task });
}

adminRoutes.post('/ping/add', (c) => upsertPingTask(c, null));

adminRoutes.post('/ping/edit', async (c) => {
  const body = await c.req.raw.clone().json().catch(() => ({})) as Record<string, unknown>;
  const id = Number(body.id);
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'Ping 任务 ID 无效' }, 400);
  return upsertPingTask(c, id);
});

adminRoutes.post('/ping/reorder', async (c) => {
  const parsed = await readJsonObject(c);
  if (!parsed.ok) return parsed.response;
  const ids = Array.isArray(parsed.body.ids) ? parsed.body.ids.map(Number).filter(id => Number.isInteger(id) && id > 0) : [];
  if (ids.length === 0) return c.json({ error: 'Ping 任务排序列表不能为空' }, 400);
  if (new Set(ids).size !== ids.length) return c.json({ error: 'Ping 任务排序列表不能包含重复 ID' }, 400);
  const updated = await mutateCore(services(c), (core) => {
    let count = 0;
    ids.forEach((id, index) => {
      const task = core.ping_tasks.find(item => item.id === id);
      if (task) {
        task.sort_order = index + 1;
        count += 1;
      }
    });
    return count;
  }, { bumpMeta: true });
  audit(c, 'ping_reorder', `调整 Ping 任务排序: ${ids.join(',')}`);
  return c.json({ success: true, updated });
});

adminRoutes.post('/ping/delete', async (c) => {
  const parsed = await readJsonObject(c);
  if (!parsed.ok) return parsed.response;
  const id = Number(parsed.body.id);
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'Ping 任务 ID 无效' }, 400);
  const deleted = await mutateCore(services(c), (core) => {
    const task = core.ping_tasks.find(item => item.id === id);
    if (!task) return null;
    core.ping_tasks = core.ping_tasks.filter(item => item.id !== id);
    return task;
  }, { bumpMeta: true });
  if (!deleted) return c.json({ error: 'Ping 任务不存在' }, 404);
  audit(c, 'ping_delete', `删除 Ping 任务: ${deleted.name}`);
  return c.json({ success: true, id });
});

// ============ 网站监控 ============

async function websiteViews(c: AppContext, core: CoreDoc): Promise<WebsiteMonitor[]> {
  const doc = await readWebsites(services(c));
  return [...core.websites]
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.id - b.id)
    .map(monitor => toWebsiteMonitor(monitor, runtimeFor(doc, monitor)));
}

function websiteErrorMessage(code: string): string {
  if (code === 'tcp_requires_agent_probe') return 'ESA 边缘函数无法建立 TCP 连接：TCP 监控请开启 Agent 探测（指定节点或按地区自动）';
  return `网站监控校验失败: ${code}`;
}

adminRoutes.get('/websites', async (c) => {
  const core = await readCore(services(c), c.req.query('refresh') ? 0 : 5_000);
  return c.json(await websiteViews(c, core));
});

adminRoutes.get('/websites/:id/checks', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: '网站监控 ID 无效' }, 400);
  const app = services(c);
  const core = await readCore(app);
  const monitor = core.websites.find(item => item.id === id);
  if (!monitor) return c.json([]);
  const doc = await readWebsites(app);
  return c.json(listChecks(monitor, runtimeFor(doc, monitor), readIntParam(c.req.query('limit'), 120, 500)));
});

adminRoutes.post('/websites/add', async (c) => {
  const parsed = await readJsonObject(c);
  if (!parsed.ok) return parsed.response;
  const validated = validateWebsiteMonitorInput(parsed.body);
  if (!validated.ok) return c.json({ error: websiteErrorMessage(validated.error), code: validated.error }, 400);
  const app = services(c);
  const now = new Date(app.now()).toISOString();
  const monitor = await mutateCore(app, (core) => {
    core.seq.website = Math.max(core.seq.website, ...core.websites.map(item => item.id)) + 1;
    const created: StoredWebsiteMonitor = {
      ...validated.value,
      id: core.seq.website,
      config_revision: crypto.randomUUID(),
      sort_order: core.websites.reduce((max, item) => Math.max(max, item.sort_order ?? 0), 0) + 1,
      created_at: now,
      updated_at: now,
    };
    core.websites.push(created);
    return created;
  }, { bumpMeta: true });
  audit(c, 'website_add', `添加网站监控: ${monitor.name} ${monitor.url}`);
  const doc = await readWebsites(app);
  return c.json({ success: true, monitor: toWebsiteMonitor(monitor, runtimeFor(doc, monitor)) });
});

const WEBSITE_REQUIRED_FIELDS = ['name', 'url', 'method', 'expected_status_min', 'expected_status_max', 'interval_sec', 'timeout_sec', 'grace_period_sec', 'enabled', 'hidden', 'agent_probe_mode', 'agent_probe_clients'];

adminRoutes.post('/websites/edit', async (c) => {
  const parsed = await readJsonObject(c);
  if (!parsed.ok) return parsed.response;
  const id = Number(parsed.body.id);
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: '网站监控 ID 无效' }, 400);
  const app = services(c);
  const current = await readCore(app, 0);
  const existing = current.websites.find(item => item.id === id);
  if (!existing) return c.json({ error: '网站监控不存在' }, 404);
  const hasFull = WEBSITE_REQUIRED_FIELDS.every(field => Object.prototype.hasOwnProperty.call(parsed.body, field));
  const validated = validateWebsiteMonitorInput(hasFull ? parsed.body : { ...existing, ...parsed.body });
  if (!validated.ok) return c.json({ error: websiteErrorMessage(validated.error), code: validated.error }, 400);
  const monitor = await mutateCore(app, (core) => {
    const target = core.websites.find(item => item.id === id);
    if (!target) return null;
    const configChanged = ['url', 'method', 'expected_status_min', 'expected_status_max', 'timeout_sec', 'interval_sec', 'agent_probe_mode']
      .some(field => JSON.stringify((target as unknown as Record<string, unknown>)[field]) !== JSON.stringify((validated.value as unknown as Record<string, unknown>)[field]));
    Object.assign(target, validated.value, {
      config_revision: configChanged ? crypto.randomUUID() : target.config_revision,
      updated_at: new Date(app.now()).toISOString(),
    });
    return target;
  }, { bumpMeta: true });
  if (!monitor) return c.json({ error: '网站监控不存在' }, 404);
  audit(c, 'website_edit', `编辑网站监控: ${existing.name} -> ${monitor.name}`);
  const doc = await readWebsites(app);
  return c.json({ success: true, changed: 1, monitor: toWebsiteMonitor(monitor, runtimeFor(doc, monitor)) });
});

async function toggleWebsite(c: AppContext, field: 'hidden' | 'enabled'): Promise<Response> {
  const parsed = await readJsonObject(c);
  if (!parsed.ok) return parsed.response;
  const id = Number(parsed.body.id);
  const value = parsed.body[field];
  if (!Number.isInteger(id) || id <= 0 || typeof value !== 'boolean') {
    return c.json({ error: field === 'hidden' ? '网站监控显隐参数无效' : '网站监控启停参数无效' }, 400);
  }
  const app = services(c);
  const changed = await mutateCore(app, (core) => {
    const target = core.websites.find(item => item.id === id);
    if (!target || target[field] === value) return false;
    target[field] = value;
    if (field === 'enabled' && value) target.config_revision = crypto.randomUUID();
    target.updated_at = new Date(app.now()).toISOString();
    return true;
  }, { bumpMeta: true });
  audit(c, field === 'hidden' ? 'website_visibility' : 'website_enabled', `网站监控 ${id} ${field === 'hidden' ? (value ? '隐藏' : '显示') : (value ? '启用' : '停用')}`);
  return c.json({ success: true, changed: changed ? 1 : 0 });
}

adminRoutes.post('/websites/visibility', (c) => toggleWebsite(c, 'hidden'));
adminRoutes.post('/websites/enabled', (c) => toggleWebsite(c, 'enabled'));

adminRoutes.post('/websites/reorder', async (c) => {
  const parsed = await readJsonObject(c);
  if (!parsed.ok) return parsed.response;
  const ids = Array.isArray(parsed.body.ids) ? parsed.body.ids.map(Number).filter(id => Number.isInteger(id) && id > 0) : [];
  if (ids.length === 0) return c.json({ error: '网站监控排序列表不能为空' }, 400);
  if (new Set(ids).size !== ids.length) return c.json({ error: '网站监控排序列表不能包含重复 ID' }, 400);
  const updated = await mutateCore(services(c), (core) => {
    let count = 0;
    ids.forEach((id, index) => {
      const monitor = core.websites.find(item => item.id === id);
      if (monitor) {
        monitor.sort_order = index + 1;
        count += 1;
      }
    });
    return count;
  }, { bumpMeta: true });
  audit(c, 'website_reorder', `调整网站监控排序: ${ids.join(',')}`);
  return c.json({ success: true, updated });
});

adminRoutes.post('/websites/delete', async (c) => {
  const parsed = await readJsonObject(c);
  if (!parsed.ok) return parsed.response;
  const id = Number(parsed.body.id);
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: '网站监控 ID 无效' }, 400);
  const deleted = await mutateCore(services(c), (core) => {
    const monitor = core.websites.find(item => item.id === id);
    if (!monitor) return null;
    core.websites = core.websites.filter(item => item.id !== id);
    return monitor;
  }, { bumpMeta: true });
  if (!deleted) return c.json({ error: '网站监控不存在' }, 404);
  audit(c, 'website_delete', `删除网站监控: ${deleted.name} ${deleted.url}`);
  return c.json({ success: true });
});

adminRoutes.post('/websites/:id/check', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: '网站监控 ID 无效' }, 400);
  const app = services(c);
  const core = await readCore(app, 0);
  const monitor = core.websites.find(item => item.id === id);
  if (!monitor) return c.json({ error: '网站监控不存在' }, 404);
  if (monitor.method === 'TCP') return c.json({ error: 'TCP 监控只能由 Agent 探测，无法在边缘函数手动检测' }, 400);
  const check = await checkWebsiteMonitorHttp(monitor, app.subrequests.fetch);
  const updated = monitor.enabled
    ? await mutateWebsites(app, doc => applyWebsiteCheck(doc, monitor, { ...check, source_type: 'worker', source_client: null }, app.now()))
    : null;
  audit(c, 'website_check', `手动检测网站监控: ${monitor.name}`);
  return c.json({ success: true, monitor: updated, check });
});

// ============ 站点 Logo 与设置 ============

function detectSiteLogoType(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return 'image/webp';
  return null;
}

adminRoutes.post('/site-logo', async (c) => {
  const body = await readRequestBytesWithLimit(c.req.raw, MAX_SITE_LOGO_BYTES + 4096);
  if (!body.ok) return c.json({ error: `Logo 不能超过 ${MAX_SITE_LOGO_BYTES} 字节` }, 413);
  let form: FormData;
  try {
    form = await new Response(body.bytes, { headers: { 'Content-Type': c.req.header('Content-Type') || '' } }).formData();
  } catch {
    return c.json({ error: 'Logo 表单格式错误' }, 400);
  }
  const file = form.get('file');
  if (!file || typeof file === 'string') return c.json({ error: '请上传 Logo 图片' }, 400);
  const bytes = new Uint8Array(await (file as Blob).arrayBuffer());
  if (bytes.byteLength > MAX_SITE_LOGO_BYTES) return c.json({ error: `Logo 不能超过 ${MAX_SITE_LOGO_BYTES} 字节` }, 413);
  const contentType = detectSiteLogoType(bytes);
  if (!contentType) return c.json({ error: 'Logo 只支持 PNG、JPG、WebP' }, 400);
  const app = services(c);
  await app.kv.put(SITE_LOGO_KEY, JSON.stringify({ type: contentType, data: bytesToBase64(bytes) }));
  const siteLogoUrl = `/api/site-logo?v=${app.now()}`;
  await mutateCore(app, (core) => { core.settings.site_logo_url = siteLogoUrl; }, { bumpMeta: true });
  audit(c, 'settings_save', '上传站点 Logo');
  return c.json({ success: true, site_logo_url: siteLogoUrl });
});

adminRoutes.post('/site-logo/reset', async (c) => {
  const app = services(c);
  await app.kv.delete(SITE_LOGO_KEY);
  await mutateCore(app, (core) => { core.settings.site_logo_url = ''; }, { bumpMeta: true });
  audit(c, 'settings_save', '恢复默认站点 Logo');
  return c.json({ success: true, site_logo_url: '' });
});

function webhookUrlHost(value: string): string {
  try {
    return value ? new URL(value).host : '';
  } catch {
    return '';
  }
}

adminRoutes.get('/settings', async (c) => {
  const scope = c.req.query('scope');
  const core = await readCore(services(c), 0);
  const settings = adminSettingsOf(core);
  if (!scope) return c.json(settings);
  const keys = SETTINGS_SCOPE_KEYS[scope];
  if (!keys) return c.json({ error: '未知设置范围' }, 400);
  const scoped: Record<string, string> = Object.fromEntries(keys.map(key => [key, settings[key] ?? '']));
  if (scope === 'notification') {
    scoped.email_smtp_password_set = settings.email_smtp_password ? 'true' : 'false';
    scoped.webhook_url_set = settings.webhook_url ? 'true' : 'false';
    scoped.webhook_secret_set = settings.webhook_secret ? 'true' : 'false';
    scoped.webhook_headers_set = settings.webhook_headers_json ? 'true' : 'false';
    scoped.webhook_password_set = settings.webhook_password ? 'true' : 'false';
    scoped.telegram_bot_token_set = settings.telegram_bot_token ? 'true' : 'false';
    scoped.telegram_chat_id_set = settings.telegram_chat_id ? 'true' : 'false';
    scoped.webhook_url_host = webhookUrlHost(settings.webhook_url);
    scoped.telegram_bot_token_preview = maskSecretPreview(settings.telegram_bot_token);
    scoped.telegram_chat_id_preview = maskSecretPreview(settings.telegram_chat_id);
    scoped.email_smtp_password_preview = maskSecretPreview(settings.email_smtp_password);
    scoped.webhook_secret_preview = maskSecretPreview(settings.webhook_secret);
    scoped.webhook_password_preview = maskSecretPreview(settings.webhook_password);
    for (const key of ['telegram_bot_token', 'telegram_chat_id', 'email_smtp_password', 'webhook_url', 'webhook_secret', 'webhook_headers_json', 'webhook_password']) {
      delete scoped[key];
    }
  }
  return c.json(scoped);
});

adminRoutes.post('/settings', async (c) => {
  const parsed = await readJsonObject(c);
  if (!parsed.ok) return parsed.response;
  const body: Record<string, unknown> = { ...parsed.body };
  for (const key of ['email_smtp_password_set', 'webhook_url_set', 'webhook_secret_set', 'webhook_headers_set', 'webhook_password_set',
    'webhook_url_host', 'telegram_bot_token_set', 'telegram_chat_id_set', 'telegram_bot_token_preview', 'telegram_chat_id_preview',
    'email_smtp_password_preview', 'webhook_secret_preview', 'webhook_password_preview']) delete body[key];
  const flag = (key: string) => body[key] === true || body[key] === 'true';
  const clearWebhookUrl = flag('webhook_url_clear');
  const clearWebhookSecret = flag('webhook_secret_clear');
  const clearTelegramBotToken = flag('telegram_bot_token_clear');
  const clearTelegramChatId = flag('telegram_chat_id_clear');
  for (const key of ['webhook_url_clear', 'webhook_secret_clear', 'telegram_bot_token_clear', 'telegram_chat_id_clear']) delete body[key];
  for (const key of ['telegram_bot_token', 'telegram_chat_id', 'email_smtp_password', 'webhook_secret', 'webhook_password']) {
    if (isMaskedSecretPreview(body[key])) delete body[key];
  }
  if (body.email_smtp_password === '') delete body.email_smtp_password;
  if (clearTelegramBotToken) body.telegram_bot_token = '';
  else if (body.telegram_bot_token === '') delete body.telegram_bot_token;
  if (clearTelegramChatId) body.telegram_chat_id = '';
  else if (body.telegram_chat_id === '') delete body.telegram_chat_id;
  if (clearWebhookUrl) body.webhook_url = '';
  else if (body.webhook_url === '') delete body.webhook_url;
  if (clearWebhookSecret) body.webhook_secret = '';
  else if (body.webhook_secret === '') delete body.webhook_secret;
  if (body.webhook_headers_json === '') delete body.webhook_headers_json;
  if (body.webhook_password === '') delete body.webhook_password;
  if (body.notification_method === 'email') {
    return c.json({ error: '设置校验失败', details: ['ESA 函数无法建立 SMTP 连接，请使用 Telegram 或 Webhook 通知'] }, 400);
  }
  const normalized = sanitizeSettingsForStorage(body, { selfHost: new URL(c.req.url).hostname });
  if (!normalized.ok) return c.json({ error: '设置校验失败', details: normalized.errors }, 400);
  const app = services(c);
  const changedKeys = await mutateCore(app, (core) => {
    const current = buildAdminSettings(core.settings);
    const changed = Object.entries(normalized.settings).filter(([key, value]) => current[key] !== value);
    for (const [key, value] of changed) core.settings[key] = value;
    return changed.map(([key]) => key);
  }, { bumpMeta: Object.keys(normalized.settings).some(key => SETTING_SCHEMA[key as keyof typeof SETTING_SCHEMA]?.public) });
  if (changedKeys.length === 0) return c.json({ success: true, ignored: normalized.ignoredKeys, changed: 0, noop: true });
  audit(c, 'settings_edit', `修改系统设置: ${changedKeys.join(',')}`);
  return c.json({ success: true, ignored: normalized.ignoredKeys, changed: changedKeys.length, noop: false });
});

// ============ 通知规则 ============

adminRoutes.get('/notification/offline', async (c) => {
  const app = services(c);
  const core = await readCore(app, 0);
  const alerts = await readAlerts(app);
  const rows: OfflineNotification[] = core.offline_notifications.map(item => ({ ...item, last_notified: alerts.offline[item.client]?.last_notified ?? null }));
  return c.json(rows);
});

adminRoutes.get('/notification/expiry', async (c) => {
  const app = services(c);
  const core = await readCore(app, 0);
  const alerts = await readAlerts(app);
  const rows: ExpiryNotification[] = core.expiry_notifications.map(item => ({ ...item, last_notified: alerts.expiry[item.client]?.last_notified ?? null }));
  return c.json(rows);
});

async function editClientNotifications(c: AppContext, kind: 'offline' | 'expiry'): Promise<Response> {
  const parsed = await readJsonObjectOrArray(c);
  if (!parsed.ok) return parsed.response;
  const items = Array.isArray(parsed.body) ? parsed.body : [parsed.body];
  const app = services(c);
  const core = await readCore(app, 0);
  const allowed = new Set(core.clients.map(client => client.uuid));
  const errors: string[] = [];
  const normalizedOffline: Array<{ client: string; enable: boolean; grace_period: number }> = [];
  const normalizedExpiry: Array<{ client: string; enable: boolean; advance_days: number }> = [];
  items.forEach((item, index) => {
    if (kind === 'offline') {
      const validated = validateOfflineNotificationInput(item, allowed);
      if (validated.ok) normalizedOffline.push(validated.item);
      else errors.push(...validated.errors.map(error => `${index}: ${error}`));
    } else {
      const validated = validateExpiryNotificationInput(item, allowed);
      if (validated.ok) normalizedExpiry.push(validated.item);
      else errors.push(...validated.errors.map(error => `${index}: ${error}`));
    }
  });
  if (errors.length > 0) return c.json({ error: kind === 'offline' ? '离线通知校验失败' : '到期通知校验失败', details: errors }, 400);
  const changed = await mutateCore(app, (doc) => {
    let count = 0;
    if (kind === 'offline') {
      for (const item of normalizedOffline) {
        const existing = doc.offline_notifications.find(row => row.client === item.client);
        if (existing && existing.enable === item.enable && existing.grace_period === item.grace_period) continue;
        if (existing) Object.assign(existing, item);
        else doc.offline_notifications.push(item);
        count += 1;
      }
    } else {
      for (const item of normalizedExpiry) {
        const existing = doc.expiry_notifications.find(row => row.client === item.client);
        if (existing && existing.enable === item.enable && existing.advance_days === item.advance_days) continue;
        if (existing) Object.assign(existing, item);
        else doc.expiry_notifications.push(item);
        count += 1;
      }
    }
    return count;
  });
  const updated = kind === 'offline' ? normalizedOffline.length : normalizedExpiry.length;
  return c.json({ success: true, updated, changed, noop: changed === 0 });
}

adminRoutes.post('/notification/offline/edit', (c) => editClientNotifications(c, 'offline'));
adminRoutes.post('/notification/expiry/edit', (c) => editClientNotifications(c, 'expiry'));

adminRoutes.get('/notification/load', async (c) => {
  const core = await readCore(services(c), 0);
  const rows: Array<LoadNotification & { all_clients: boolean }> = core.load_notifications.map(rule => ({
    ...rule,
    last_notified: null,
    all_clients: rule.clients.length === 0,
  }));
  return c.json(rows);
});

async function saveLoadNotification(c: AppContext, id: number | null): Promise<Response> {
  const parsed = await readJsonObject(c);
  if (!parsed.ok) return parsed.response;
  const app = services(c);
  const core = await readCore(app, 0);
  const allowed = new Set(core.clients.map(client => client.uuid));
  const validated = validateLoadNotificationInput(id === null ? parsed.body : { ...parsed.body, id }, allowed, { requireId: id !== null });
  if (!validated.ok) return c.json({ error: '负载通知校验失败', details: validated.errors }, 400);
  const { id: _ignored, ...data } = validated.item as typeof validated.item & { id?: number };
  const result = await mutateCore(app, (doc) => {
    if (id === null) {
      doc.seq.load_notification = Math.max(doc.seq.load_notification, ...doc.load_notifications.map(rule => rule.id)) + 1;
      doc.load_notifications.push({ ...data, metric: data.metric as LoadNotification['metric'], id: doc.seq.load_notification });
      return 'created' as const;
    }
    const existing = doc.load_notifications.find(rule => rule.id === id);
    if (!existing) return null;
    Object.assign(existing, { ...data, metric: data.metric as LoadNotification['metric'] });
    return 'updated' as const;
  });
  if (result === null) return c.json({ error: '负载通知不存在' }, 404);
  audit(c, 'load_notification_save', `${result === 'created' ? '添加' : '编辑'}负载告警规则: ${data.name}`);
  return c.json(result === 'created' ? { success: true } : { success: true, changed: 1, noop: false });
}

async function deleteLoadNotification(c: AppContext, id: number): Promise<Response> {
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: '负载通知 ID 无效' }, 400);
  await mutateCore(services(c), (doc) => {
    doc.load_notifications = doc.load_notifications.filter(rule => rule.id !== id);
  });
  audit(c, 'load_notification_delete', `删除负载告警规则: ${id}`);
  return c.json({ success: true });
}

adminRoutes.post('/notification/load/add', (c) => saveLoadNotification(c, null));
adminRoutes.post('/notification/load/edit', async (c) => {
  const body = await c.req.raw.clone().json().catch(() => ({})) as Record<string, unknown>;
  return saveLoadNotification(c, Number(body.id));
});
adminRoutes.delete('/notification/load/:id', (c) => deleteLoadNotification(c, Number.parseInt(c.req.param('id'), 10)));
adminRoutes.post('/notification/load/delete', async (c) => {
  const parsed = await readJsonObject(c);
  if (!parsed.ok) return parsed.response;
  return deleteLoadNotification(c, Number(parsed.body.id));
});
adminRoutes.post('/notification/load/:id', (c) => saveLoadNotification(c, Number.parseInt(c.req.param('id'), 10)));

// ============ 审计日志 ============

adminRoutes.get('/logs', async (c) => {
  const limit = Math.min(500, Math.max(1, Number.parseInt(c.req.query('limit') || '100', 10) || 100));
  const page = Math.max(1, Number.parseInt(c.req.query('page') || '1', 10) || 1);
  const logs = await listAuditLogs(services(c), page, limit);
  return c.json({ data: logs.logs, total: logs.total, has_more: logs.has_more, page, limit });
});

export type { StoredClient };
