/**
 * 系统类管理接口：版本更新检查、健康、用量估算、维护、备份恢复、通知测试。
 */

import { Hono } from 'hono';
import type { OfflineNotification, ExpiryNotification, LoadNotification } from '../db/types';
import { buildAdminSettings } from '../settings/schema';
import {
  BACKUP_ENCRYPTION_ALGORITHM,
  BACKUP_EXCLUDED_MODULES,
  BACKUP_SCHEMA_ID,
  BACKUP_SCOPE,
  BACKUP_VERSION,
  ENCRYPTED_BACKUP_SCHEMA_ID,
  MAX_BACKUP_BYTES,
  decryptBackup,
  encryptBackup,
  summarizeBackup,
  validateBackup,
  websiteMonitorConfiguration,
  type BackupData,
} from '../utils/backup';
import { hashAgentToken } from '../utils/client';
import { NOTIFICATION_DISPATCH_SETTING_KEYS, pickNotificationSettingOverrides } from '../utils/notification-dispatch';
import { TELEGRAM_MESSAGE_MAX_CHARS } from '../utils/telegram';
import { WEBHOOK_MESSAGE_MAX_CHARS } from '../utils/webhook';
import { APP_VERSION, BUILD_COMMIT } from '../utils/app-version';
import { formatAppVersion, normalizeGitSha, repositoryUrlFromRepositoryUrl, shortGitSha, type UpdateCheckResult } from '../utils/update-check';
import { buildResourceEstimates, estimateKvStorageBytes } from '../utils/capacity-estimate';
import { buildQuotaReference } from '../utils/quota';
import { errorDetail, readLocalHealthEvents } from '../utils/observability';
import { isEdgeKvAvailable } from '../platform/kv';
import { readEnvString } from '../platform/env';
import { SubrequestBudgetExceeded } from '../platform/context';
import { adminSettingsOf, defaultStoredClient, mutateCore, readCore, toClientView } from '../store/core';
import type { CoreDoc, StoredClient, StoredWebsiteMonitor } from '../store/types';
import { readLiveEntries } from '../store/live';
import { readWebsites, runtimeFor, toWebsiteMonitor } from '../store/websites';
import { readAlerts } from '../store/alerts';
import { pruneAuditLogs } from '../store/audit';
import { maybeRunMaintenance } from '../services/maintenance';
import { queueAudit, sendNotification } from '../services/notify';
import { readJsonObject, services, type AppContext, type HonoEnv } from './common';

export const systemAdminRoutes = new Hono<HonoEnv>();

export const OFFICIAL_UPDATE_REPOSITORY = 'sbaliyun/esa-vps-monitor';
const OFFICIAL_UPDATE_BRANCH = 'main';
const UPDATE_CHECK_CACHE_MS = 10 * 60 * 1000;
const updateCheckCache = new Map<string, { expiresAt: number; value: UpdateCheckResult }>();

function audit(c: AppContext, action: string, detail: string, level = 'info'): void {
  queueAudit(services(c), c.get('username') || 'admin', action, detail, level);
}

function currentCommit(c: AppContext): string {
  return normalizeGitSha(readEnvString(c.env, 'CURRENT_GIT_COMMIT') || BUILD_COMMIT);
}

// ============ 版本更新 ============

async function fetchGitHubJson<T>(c: AppContext, path: string): Promise<T> {
  const response = await services(c).subrequests.fetch(`https://api.github.com/${path}`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'esa-vps-monitor-update-check' },
  });
  if (!response.ok) throw new Error(`GitHub API returned ${response.status}`);
  return await response.json() as T;
}

systemAdminRoutes.get('/update-check', async (c) => {
  const now = Date.now();
  try {
    const core = await readCore(services(c));
    const repositoryUrl = adminSettingsOf(core).update_repository_url;
    const commitSha = currentCommit(c);
    const cacheKey = `${OFFICIAL_UPDATE_REPOSITORY}:${repositoryUrl}:${commitSha}`;
    const cached = updateCheckCache.get(cacheKey);
    if (c.req.query('refresh') !== '1' && cached && cached.expiresAt > now) return c.json(cached.value);
    type Commit = { sha?: string; html_url?: string; commit?: { message?: string; committer?: { date?: string }; author?: { date?: string } } };
    const commit = await fetchGitHubJson<Commit>(c, `repos/${OFFICIAL_UPDATE_REPOSITORY}/commits/${OFFICIAL_UPDATE_BRANCH}`);
    const latestCommit = normalizeGitSha(commit.sha || '');
    let latestVersion = 'dev';
    try {
      const pkg = await services(c).subrequests.fetch(`https://raw.githubusercontent.com/${OFFICIAL_UPDATE_REPOSITORY}/${latestCommit}/worker/package.json`);
      if (pkg.ok) {
        const body = await pkg.json() as { version?: unknown };
        if (typeof body.version === 'string') latestVersion = body.version;
      }
    } catch {
      latestVersion = 'dev';
    }
    const message = commit.commit?.message || '';
    const deploymentUrl = repositoryUrlFromRepositoryUrl(repositoryUrl);
    const result: UpdateCheckResult = {
      current_version: formatAppVersion(APP_VERSION),
      latest_version: formatAppVersion(latestVersion),
      current_commit: shortGitSha(commitSha),
      latest_commit: shortGitSha(latestCommit),
      has_update: Boolean(latestCommit) && Boolean(commitSha) && commitSha !== latestCommit,
      source_url: commit.html_url || `https://github.com/${OFFICIAL_UPDATE_REPOSITORY}/commits/${OFFICIAL_UPDATE_BRANCH}`,
      upgrade_url: deploymentUrl,
      repository_url: deploymentUrl,
      title: message.split('\n')[0] || latestCommit,
      body: message,
      published_at: commit.commit?.committer?.date || commit.commit?.author?.date || '',
    };
    updateCheckCache.set(cacheKey, { expiresAt: now + UPDATE_CHECK_CACHE_MS, value: result });
    return c.json(result);
  } catch (error) {
    return c.json({ error: 'Update check failed', detail: errorDetail(error) }, 502);
  }
});

// ============ 健康与用量 ============

systemAdminRoutes.get('/health', async (c) => {
  const app = services(c);
  const jwtOk = new TextEncoder().encode(readEnvString(c.env, 'JWT_SECRET')).byteLength >= 32;
  let kvOk = false;
  let kvDetail = '';
  try {
    await app.kv.get('core', { maxAgeMs: 0 });
    kvOk = true;
    kvDetail = isEdgeKvAvailable() ? 'EdgeKV 可读' : '本地内存 KV';
  } catch (error) {
    kvDetail = errorDetail(error);
  }
  const checkedAt = new Date(app.now()).toISOString();
  const events = [
    { component: 'edge_kv', status: kvOk ? 'ok' : 'error', updated_at: checkedAt, detail: kvDetail },
    { component: 'jwt_secret', status: jwtOk ? 'ok' : 'error', updated_at: checkedAt, detail: jwtOk ? 'JWT_SECRET 已配置' : 'JWT_SECRET 缺失或不足 32 字节' },
    ...readLocalHealthEvents(),
  ];
  const ok = kvOk && jwtOk;
  return c.json({ ok, status: ok ? 'ok' : 'error', checked_at: checkedAt, components: events, cache: 'miss' }, ok ? 200 : 503);
});

export function buildCapacity(core: CoreDoc) {
  const settings = adminSettingsOf(core);
  const clientCount = core.clients.length;
  const pingAssignments = core.ping_tasks.reduce((sum, task) => sum + (task.all_clients ? clientCount : task.clients.length), 0);
  const edgeChecks = core.websites
    .filter(monitor => monitor.enabled && monitor.method !== 'TCP' && (monitor.agent_probe_mode === 'off' || monitor.agent_probe_status_enabled))
    .reduce((sum, monitor) => sum + 86_400 / Math.max(60, monitor.interval_sec), 0);
  const input = {
    clientCount,
    pingTasksPerClient: clientCount > 0 ? pingAssignments / clientCount : 0,
    websiteMonitorCount: core.websites.length,
    websiteEdgeChecksPerDay: Math.ceil(edgeChecks),
    activeSecondsPerDay: Number(settings.capacity_daily_view_minutes || 60) * 60,
    activeIntervalSec: Number(settings.live_poll_active_interval_sec || 5),
    idleIntervalSec: Number(settings.live_poll_idle_interval_sec || 120),
    recordIntervalSec: Number(settings.record_persist_interval_sec || 120),
    pingIntervalSec: Number(settings.ping_record_persist_interval_sec || 120),
    retentionHours: Number(settings.record_preserve_time || 72),
  };
  return {
    platform: 'esa',
    clients: clientCount,
    gpu_clients: 0,
    ping_tasks: core.ping_tasks.map(task => ({ id: task.id, name: task.name, target_client_count: task.all_clients ? clientCount : task.clients.length })),
    website_monitors: core.websites.length,
    capacity_daily_view_minutes: Number(settings.capacity_daily_view_minutes || 60),
    record_persist_interval_sec: input.recordIntervalSec,
    ping_record_persist_interval_sec: input.pingIntervalSec,
    live_poll_active_interval_sec: input.activeIntervalSec,
    live_poll_idle_interval_sec: input.idleIntervalSec,
    history_total_bytes: estimateKvStorageBytes(input),
    ...buildResourceEstimates(input),
    quota_reference: buildQuotaReference(),
  };
}

systemAdminRoutes.get('/capacity', async (c) => {
  const core = await readCore(services(c));
  return c.json(buildCapacity(core));
});

// ============ 维护 ============

systemAdminRoutes.post('/maintenance/cleanup', async (c) => {
  const app = services(c);
  const core = await readCore(app);
  const removed = await pruneAuditLogs(app, Number(adminSettingsOf(core).audit_log_preserve_time || 2160));
  audit(c, 'maintenance_cleanup', `手动维护清理: audit=${removed}`);
  return c.json({ success: true, deleted: { audit_logs: removed }, has_more: false });
});

systemAdminRoutes.post('/cron/run', async (c) => {
  const result = await maybeRunMaintenance(services(c), 'admin', { force: true });
  return c.json({ success: true, ...result });
});

// ============ 备份与恢复 ============

async function buildBackupSnapshot(c: AppContext): Promise<BackupData> {
  const app = services(c);
  const core = await readCore(app, 0);
  const entries = await readLiveEntries(app, null, 5_000);
  const alerts = await readAlerts(app);
  const websites = await readWebsites(app);
  const backup: BackupData = {
    schema: BACKUP_SCHEMA_ID,
    version: BACKUP_VERSION,
    scope: BACKUP_SCOPE,
    timestamp: new Date(app.now()).toISOString(),
    excluded: [...BACKUP_EXCLUDED_MODULES],
    sensitive: true,
    settings: buildAdminSettings(core.settings),
    clients: core.clients.map(client => toClientView(client, entries.get(client.uuid)?.m)),
    ping_tasks: core.ping_tasks,
    offline_notifications: core.offline_notifications.map((item): OfflineNotification => ({ ...item, last_notified: alerts.offline[item.client]?.last_notified ?? null })),
    expiry_notifications: core.expiry_notifications.map((item): ExpiryNotification => ({ ...item, last_notified: alerts.expiry[item.client]?.last_notified ?? null })),
    load_notifications: core.load_notifications.map((rule): LoadNotification => ({ ...rule, last_notified: null })),
    website_monitors: core.websites.map(monitor => websiteMonitorConfiguration(toWebsiteMonitor(monitor, runtimeFor(websites, monitor)))),
  };
  const validated = validateBackup(backup);
  if (!validated.ok) throw new Error(`备份配置校验失败: ${validated.errors.join('；')}`);
  return validated.backup;
}

systemAdminRoutes.post('/download/backup', async (c) => {
  const parsed = await readJsonObject(c);
  if (!parsed.ok) return parsed.response;
  const password = typeof parsed.body.backup_password === 'string' ? parsed.body.backup_password : '';
  try {
    const backup = await buildBackupSnapshot(c);
    const encrypted = await encryptBackup(backup, password);
    if (!encrypted.ok) return c.json({ error: encrypted.error }, 400);
    audit(c, 'backup_download', `下载加密完整备份: ${JSON.stringify({ ...summarizeBackup(backup), encryption: BACKUP_ENCRYPTION_ALGORITHM })}`);
    const date = new Date().toISOString().slice(0, 10);
    return new Response(JSON.stringify(encrypted.encryptedBackup, null, 2), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="esa-vps-monitor-encrypted-backup-${date}.json"`,
        'X-CF-VPS-Monitor-Backup-Schema': ENCRYPTED_BACKUP_SCHEMA_ID,
        'X-CF-VPS-Monitor-Backup-Scope': BACKUP_SCOPE,
        'X-CF-VPS-Monitor-Backup-Encrypted': 'true',
      },
    });
  } catch (error) {
    console.error('[backup] download failed:', errorDetail(error));
    return c.json({ error: '备份失败' }, 500);
  }
});

function isEncryptedEnvelope(value: unknown): boolean {
  return Boolean(value) && typeof value === 'object' && (value as { schema?: unknown }).schema === ENCRYPTED_BACKUP_SCHEMA_ID;
}

/** 把备份写入 core：设置合并；节点、Ping、通知规则、网站监控整体替换（与原版一致）。 */
async function applyBackup(c: AppContext, backup: BackupData): Promise<void> {
  const app = services(c);
  const now = new Date(app.now()).toISOString();
  const clientHashes = new Map<string, string>();
  for (const client of backup.clients || []) {
    const token = typeof client.token === 'string' ? client.token : '';
    if (!client.token_hash && token) clientHashes.set(String(client.uuid), await hashAgentToken(token));
  }
  await mutateCore(app, (core) => {
    if (backup.settings) for (const [key, value] of Object.entries(backup.settings)) core.settings[key] = value;
    if (backup.clients) {
      core.clients = backup.clients.flatMap((item, index): StoredClient[] => {
        const uuid = String(item.uuid || '').trim();
        if (!uuid) return [];
        const token = typeof item.token === 'string' ? item.token : '';
        const tokenHash = typeof item.token_hash === 'string' && item.token_hash ? item.token_hash : clientHashes.get(uuid) || '';
        const base = defaultStoredClient(uuid, token, tokenHash, String(item.name || ''), String(item.created_at || now), index + 1);
        return [{
          ...base,
          token_rotated_at: item.token_rotated_at ?? null,
          remark: String(item.remark || ''),
          public_remark: String(item.public_remark || ''),
          price: Number(item.price || 0),
          billing_cycle: Number(item.billing_cycle || 0),
          auto_renewal: Boolean(item.auto_renewal),
          currency: String(item.currency || '$'),
          expired_at: String(item.expired_at || ''),
          group: String(item.group || ''),
          tags: String(item.tags || ''),
          hidden: Boolean(item.hidden),
          traffic_limit: Number(item.traffic_limit || 0),
          traffic_limit_type: String(item.traffic_limit_type || 'sum'),
          traffic_reset_day: Math.min(31, Math.max(1, Number(item.traffic_reset_day || 1))),
          sort_order: Number(item.sort_order ?? index + 1),
          updated_at: now,
        }];
      });
      const valid = new Set(core.clients.map(client => client.uuid));
      core.offline_notifications = core.offline_notifications.filter(item => valid.has(item.client));
      core.expiry_notifications = core.expiry_notifications.filter(item => valid.has(item.client));
    }
    if (backup.ping_tasks) {
      core.ping_tasks = backup.ping_tasks.map((task, index) => ({ ...task, id: Number(task.id) || index + 1, sort_order: task.sort_order ?? index + 1 }));
      core.seq.ping_task = Math.max(0, ...core.ping_tasks.map(task => task.id));
    }
    if (backup.offline_notifications) core.offline_notifications = backup.offline_notifications.map(({ client, enable, grace_period }) => ({ client, enable, grace_period }));
    if (backup.expiry_notifications) core.expiry_notifications = backup.expiry_notifications.map(({ client, enable, advance_days }) => ({ client, enable, advance_days }));
    if (backup.load_notifications) {
      core.load_notifications = backup.load_notifications.map((rule, index) => ({
        id: Number(rule.id) || index + 1,
        name: rule.name,
        clients: rule.clients,
        metric: rule.metric,
        threshold: rule.threshold,
        ratio: rule.ratio,
        interval_min: rule.interval_min,
      }));
      core.seq.load_notification = Math.max(0, ...core.load_notifications.map(rule => rule.id));
    }
    if (backup.website_monitors) {
      let nextId = 0;
      core.websites = backup.website_monitors.map((monitor, index): StoredWebsiteMonitor => {
        const id = Number(monitor.id) || 0;
        nextId = Math.max(nextId, id);
        return {
          ...monitor,
          id: id || -(index + 1),
          config_revision: crypto.randomUUID(),
          sort_order: monitor.sort_order ?? index + 1,
          created_at: now,
          updated_at: now,
        };
      });
      for (const monitor of core.websites) if (monitor.id <= 0) monitor.id = ++nextId;
      core.seq.website = Math.max(nextId, ...core.websites.map(monitor => monitor.id), 0);
    }
  }, { bumpMeta: true });
}

systemAdminRoutes.post('/upload/backup', async (c) => {
  const contentLength = Number(c.req.header('Content-Length') || '0');
  if (Number.isFinite(contentLength) && contentLength > MAX_BACKUP_BYTES) return c.json({ error: `备份文件不能超过 ${MAX_BACKUP_BYTES} 字节` }, 413);
  const parsed = await readJsonObject(c, MAX_BACKUP_BYTES + 64 * 1024);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  const dryRun = c.req.query('dry_run') === '1' || c.req.query('dry_run') === 'true';
  const flag = (key: string) => c.req.query(key) === 'true' || body[key] === true || body[key] === 'true';
  if (!dryRun && !(flag('confirm_restore') && flag('acknowledge_overwrite'))) {
    return c.json({ error: '恢复备份需要同时确认 confirm_restore=true 和 acknowledge_overwrite=true' }, 400);
  }
  const envelope = isEncryptedEnvelope(body.backup) ? body.backup : body;
  if (!isEncryptedEnvelope(envelope)) return c.json({ error: '只支持导入加密完整备份，不支持明文备份文件' }, 400);
  const password = typeof body.backup_password === 'string' ? body.backup_password : c.req.header('X-Backup-Password') || '';
  const decrypted = await decryptBackup(envelope, password);
  if (!decrypted.ok) return c.json({ error: decrypted.error }, 400);
  const validated = validateBackup(decrypted.backup);
  if (!validated.ok) return c.json({ error: '备份校验失败', details: validated.errors }, 400);
  const restored = summarizeBackup(validated.backup);
  if (dryRun) return c.json({ success: true, dry_run: true, restored, warnings: validated.warnings });
  try {
    await applyBackup(c, validated.backup);
  } catch (error) {
    console.error('[backup] restore failed:', errorDetail(error));
    return c.json({ error: '恢复失败' }, 500);
  }
  audit(c, 'backup_restore', `恢复备份: ${JSON.stringify({ restored, warnings: validated.warnings.length })}`, 'warning');
  return c.json({ success: true, restored, warnings: validated.warnings });
});

// ============ 通知测试 ============

systemAdminRoutes.post('/test/sendMessage', async (c) => {
  const parsed = await readJsonObject(c);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  const message = typeof body.message === 'string' && body.message.trim() ? body.message.trim() : 'ESA VPS Monitor 测试消息';
  const app = services(c);
  const core = await readCore(app, 0);
  const stored = Object.fromEntries(NOTIFICATION_DISPATCH_SETTING_KEYS.map(key => [key, core.settings[key]]).filter(([, value]) => value !== undefined));
  const settings = buildAdminSettings({ ...stored, ...pickNotificationSettingOverrides(body.settings) });
  const channel = typeof body.channel === 'string' && body.channel.trim() ? body.channel.trim() : settings.notification_method;
  if (!['telegram', 'email', 'webhook', 'none'].includes(channel)) return c.json({ error: '未知通知方式' }, 400);
  if (channel === 'email') return c.json({ success: false, error: 'ESA 函数无法建立 SMTP 连接，请使用 Telegram 或 Webhook（可转发到邮件服务）' }, 400);
  const max = channel === 'webhook' ? WEBHOOK_MESSAGE_MAX_CHARS : TELEGRAM_MESSAGE_MAX_CHARS;
  if (channel !== 'none' && message.length > max) return c.json({ error: `测试消息不能超过 ${max} 个字符` }, 400);
  try {
    const sent = await sendNotification(app, settings, { subject: 'ESA VPS Monitor 测试消息', body: message }, { channel, auditUser: c.get('username') });
    if (!sent) {
      return c.json({ success: false, error: channel === 'none' ? '通知方式为 None，未发送测试消息' : '测试消息发送失败，请检查通知配置' }, channel === 'none' ? 400 : 502);
    }
    return c.json({ success: true });
  } catch (error) {
    if (error instanceof SubrequestBudgetExceeded) return c.json({ error: '出站请求额度不足，请稍后重试' }, 503);
    return c.json({ error: '发送测试消息失败' }, 500);
  }
});
