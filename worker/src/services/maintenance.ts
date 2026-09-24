/**
 * 定时维护：替代 Cloudflare Cron Triggers。
 *
 * ESA 函数没有定时触发器，维护任务由以下请求顺带触发（全局约每分钟一次）：
 *  - Agent 拉取策略（/api/clients/policy，空闲时约每分钟一次）；
 *  - 访客轮询实时数据；
 *  - 外部定时器调用 /api/cron（可选，见 README）。
 *
 * 每次运行受单个请求的 KV 操作数与子请求数限制，步骤轮转执行，做不完的留到下次。
 */

import type { AppServices } from '../platform/context';
import { SubrequestBudgetExceeded } from '../platform/context';
import type { MaintenanceDoc, StoredWebsiteMonitor } from '../store/types';
import { adminSettingsOf, readCore, sortedClients } from '../store/core';
import { readLiveEntries, pruneLiveEntries } from '../store/live';
import { mutateAlerts } from '../store/alerts';
import { mutateWebsites, applyWebsiteCheck, isWebsiteDue, markWebsiteNotified, needsEdgeCheck, readWebsites, runtimeFor } from '../store/websites';
import { pruneAuditLogs } from '../store/audit';
import { checkWebsiteMonitorHttp, shouldNotifyWebsiteDown, shouldNotifyWebsiteRecovery } from '../utils/website-monitor';
import {
  buildExpiryNotification,
  buildNodeRecoveryNotification,
  buildOfflineNotification,
  buildWebsiteAlertNotification,
  buildWebsiteRecoveryNotification,
} from '../utils/notification-templates';
import { DEFAULT_OFFLINE_CONFIRM_ROUNDS, DEFAULT_OFFLINE_GRACE_PERIOD_SEC, evaluateOfflineNotificationEvent } from '../utils/offline-notification';
import { errorDetail, recordLocalHealthEvent } from '../utils/observability';
import { notificationCost, queueAudit, sendNotification } from './notify';

export const MAINTENANCE_KEY = 'maint';
export const MAINTENANCE_INTERVAL_MS = 60_000;
const LEASE_MS = 50_000;
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

type StepName = 'websites' | 'offline' | 'expiry' | 'cleanup';
const STEPS: StepName[] = ['websites', 'offline', 'expiry', 'websites', 'offline', 'cleanup'];

let localNextCheckAt = 0;

export function resetMaintenanceThrottleForTests(): void {
  localNextCheckAt = 0;
}

export interface MaintenanceResult {
  ran: boolean;
  reason?: string;
  steps: Array<{ step: StepName; status: 'ok' | 'skipped' | 'deferred' | 'error'; detail?: string }>;
}

function normalizeLease(doc: MaintenanceDoc | null): MaintenanceDoc {
  return {
    until: Number(doc?.until) || 0,
    owner: String(doc?.owner || ''),
    step: Number.isInteger(doc?.step) ? Number(doc?.step) % STEPS.length : 0,
    last_run_at: Number(doc?.last_run_at) || 0,
    last_cleanup_at: Number(doc?.last_cleanup_at) || 0,
  };
}

/**
 * 尝试执行一轮维护。force=true 用于管理员手动触发与外部定时器，
 * 仍然遵守租约，避免两处同时运行。
 */
export async function maybeRunMaintenance(app: AppServices, trigger: string, options: { force?: boolean } = {}): Promise<MaintenanceResult> {
  const now = app.now();
  if (!options.force && now < localNextCheckAt) return { ran: false, reason: 'throttled', steps: [] };
  if (!app.kv.canSpend(3)) return { ran: false, reason: 'kv_budget', steps: [] };

  const lease = normalizeLease(await app.kv.getFreshJson<MaintenanceDoc>(MAINTENANCE_KEY));
  if (lease.until > now && lease.owner) {
    localNextCheckAt = Math.min(lease.until, now + MAINTENANCE_INTERVAL_MS);
    return { ran: false, reason: 'lease_held', steps: [] };
  }
  if (!options.force && lease.last_run_at && now - lease.last_run_at < MAINTENANCE_INTERVAL_MS) {
    localNextCheckAt = lease.last_run_at + MAINTENANCE_INTERVAL_MS;
    return { ran: false, reason: 'not_due', steps: [] };
  }

  const startStep = lease.step;
  const next: MaintenanceDoc = {
    ...lease,
    until: now + LEASE_MS,
    owner: `${trigger}:${crypto.randomUUID()}`,
    step: (lease.step + 1) % STEPS.length,
    last_run_at: now,
  };
  const cleanupDue = now - lease.last_cleanup_at >= CLEANUP_INTERVAL_MS;
  if (cleanupDue) next.last_cleanup_at = now;
  await app.kv.putJson(MAINTENANCE_KEY, next);
  localNextCheckAt = now + MAINTENANCE_INTERVAL_MS;

  const result: MaintenanceResult = { ran: true, steps: [] };
  const order = [...STEPS.slice(startStep), ...STEPS.slice(0, startStep)];
  const done = new Set<StepName>();
  for (const step of order) {
    if (done.has(step)) continue;
    if (step === 'cleanup' && !cleanupDue) continue;
    if (!app.kv.canSpend(2)) {
      result.steps.push({ step, status: 'deferred', detail: 'kv_budget' });
      continue;
    }
    done.add(step);
    try {
      const detail = await runStep(app, step, now);
      result.steps.push({ step, status: detail === 'skipped' ? 'skipped' : 'ok', detail });
      if (detail !== 'skipped') recordLocalHealthEvent(`cron_${step}`, 'ok', detail, now);
    } catch (error) {
      if (error instanceof SubrequestBudgetExceeded) {
        result.steps.push({ step, status: 'deferred', detail: 'subrequest_budget' });
        continue;
      }
      const message = errorDetail(error);
      console.error(`[maintenance] ${step} failed:`, message);
      recordLocalHealthEvent(`cron_${step}`, 'error', message, now);
      queueAudit(app, 'system', `cron_${step}_error`, message, 'error');
      result.steps.push({ step, status: 'error', detail: message });
    }
  }
  return result;
}

async function runStep(app: AppServices, step: StepName, now: number): Promise<string> {
  switch (step) {
    case 'websites':
      return runWebsiteStep(app, now);
    case 'offline':
      return runOfflineStep(app, now);
    case 'expiry':
      return runExpiryStep(app, now);
    case 'cleanup':
      return runCleanupStep(app, now);
  }
}

async function runWebsiteStep(app: AppServices, now: number): Promise<string> {
  const core = await readCore(app);
  const monitors = core.websites.filter(monitor => monitor.enabled);
  if (monitors.length === 0) return 'skipped';
  const settings = adminSettingsOf(core);
  const snapshot = await readWebsites(app, 5_000);
  const reserve = notificationCost(settings) > 0 ? 1 : 0;
  const due = monitors
    .filter(monitor => isWebsiteDue(monitor, runtimeFor(snapshot, monitor), now) && needsEdgeCheck(monitor, runtimeFor(snapshot, monitor), now))
    .sort((a, b) => {
      const at = runtimeFor(snapshot, a).last_checked_at;
      const bt = runtimeFor(snapshot, b).last_checked_at;
      return (at ? Date.parse(at) : 0) - (bt ? Date.parse(bt) : 0);
    });
  const checkable = due.slice(0, Math.max(0, app.subrequests.remaining() - reserve));
  const hasPendingAlerts = monitors.some((monitor) => {
    const runtime = runtimeFor(snapshot, monitor);
    const view = { enabled: monitor.enabled, status: runtime.status, grace_period_sec: monitor.grace_period_sec, down_since: runtime.down_since, last_notified_at: runtime.last_notified_at };
    return shouldNotifyWebsiteDown(view, new Date(now)) || shouldNotifyWebsiteRecovery(view);
  });
  if (checkable.length === 0 && !hasPendingAlerts) return 'skipped';

  const checks = await Promise.all(checkable.map(monitor => checkWebsiteMonitorHttp(monitor, app.subrequests.fetch)));
  let alerts = 0;
  await mutateWebsites(app, async (doc) => {
    checks.forEach((check, index) => {
      applyWebsiteCheck(doc, checkable[index], { ...check, source_type: 'worker', source_client: null }, now);
    });
    for (const monitor of monitors) {
      if (notificationCost(settings) === 0 || !app.subrequests.canSpend(notificationCost(settings))) break;
      const runtime = runtimeFor(doc, monitor);
      const view = { enabled: monitor.enabled, status: runtime.status, grace_period_sec: monitor.grace_period_sec, down_since: runtime.down_since, last_notified_at: runtime.last_notified_at };
      if (shouldNotifyWebsiteDown(view, new Date(now))) {
        const downSince = runtime.down_since ? Date.parse(runtime.down_since) : now;
        const sent = await sendWebsiteAlert(app, settings, monitor, {
          down: true,
          downMinutes: Math.max(0, Math.floor((now - downSince) / 60000)),
          lastStatus: runtime.last_error || (runtime.last_status_code ? `HTTP ${runtime.last_status_code}` : 'network_error'),
          checkedAt: runtime.last_checked_at || new Date(now).toISOString(),
          statusCode: runtime.last_status_code,
          latencyMs: runtime.last_latency_ms,
        });
        if (sent) {
          markWebsiteNotified(doc, monitor, new Date(now).toISOString());
          queueAudit(app, 'system', 'website_down', `已发送网站告警: ${monitor.name}`);
          alerts += 1;
        }
      } else if (shouldNotifyWebsiteRecovery(view)) {
        const downSince = runtime.last_notified_at ? Date.parse(runtime.last_notified_at) : now;
        const sent = await sendWebsiteAlert(app, settings, monitor, {
          down: false,
          downMinutes: Math.max(0, Math.floor((now - downSince) / 60000)),
          lastStatus: '',
          checkedAt: runtime.last_checked_at || new Date(now).toISOString(),
          statusCode: runtime.last_status_code,
          latencyMs: runtime.last_latency_ms,
        });
        if (sent) {
          markWebsiteNotified(doc, monitor, null);
          queueAudit(app, 'system', 'website_recovery', `已发送网站恢复: ${monitor.name}`);
          alerts += 1;
        }
      }
    }
    // 清理已删除监控的运行状态。
    const valid = new Set(core.websites.map(monitor => String(monitor.id)));
    for (const id of Object.keys(doc.monitors)) if (!valid.has(id)) delete doc.monitors[id];
  });
  return `checked=${checkable.length}; due=${due.length}; alerts=${alerts}`;
}

async function sendWebsiteAlert(
  app: AppServices,
  settings: Record<string, string>,
  monitor: StoredWebsiteMonitor,
  input: { down: boolean; downMinutes: number; lastStatus: string; checkedAt: string; statusCode: number | null; latencyMs: number | null },
): Promise<boolean> {
  const message = input.down
    ? buildWebsiteAlertNotification({ name: monitor.name, url: monitor.url, downMinutes: input.downMinutes, lastStatus: input.lastStatus, checkedAt: input.checkedAt })
    : buildWebsiteRecoveryNotification({ name: monitor.name, url: monitor.url, downMinutes: input.downMinutes, statusCode: input.statusCode, latencyMs: input.latencyMs, eventTime: new Date(app.now()) });
  try {
    return await sendNotification(app, settings, message);
  } catch (error) {
    if (error instanceof SubrequestBudgetExceeded) return false;
    throw error;
  }
}

async function runOfflineStep(app: AppServices, now: number): Promise<string> {
  const core = await readCore(app);
  const rules = core.offline_notifications.filter(rule => rule.enable);
  if (rules.length === 0) return 'skipped';
  if (!app.kv.canSpend(3)) throw new SubrequestBudgetExceeded();
  const settings = adminSettingsOf(core);
  const clients = new Map(core.clients.map(client => [client.uuid, client]));
  const entries = await readLiveEntries(app, 15_000);
  const notifyNeverReported = settings.offline_notify_never_reported !== 'false';
  const confirmRounds = Math.max(1, Number(settings.offline_confirm_rounds || DEFAULT_OFFLINE_CONFIRM_ROUNDS));
  let sentCount = 0;
  let deferred = 0;
  await mutateAlerts(app, async (alerts) => {
    for (const rule of rules) {
      const client = clients.get(rule.client);
      if (!client) continue;
      const state = alerts.offline[rule.client] || { streak: 0, last_notified: null };
      const entry = entries.get(rule.client);
      const lastTime = entry ? new Date(entry.t).toISOString() : null;
      const graceSec = Math.max(30, Number(rule.grace_period || DEFAULT_OFFLINE_GRACE_PERIOD_SEC));
      const offlineNow = entry ? now - entry.t >= graceSec * 1000 : true;
      state.streak = offlineNow ? state.streak + 1 : 0;
      alerts.offline[rule.client] = state;

      const event = evaluateOfflineNotificationEvent({
        now: new Date(now),
        clientCreatedAt: client.created_at,
        lastTime,
        lastNotified: state.last_notified,
        gracePeriodSec: graceSec,
        notifyNeverReported,
      });
      if (!event) continue;
      if (event.type === 'offline' && state.streak < confirmRounds) continue;
      if (!app.subrequests.canSpend(Math.max(1, notificationCost(settings)))) {
        deferred += 1;
        continue;
      }
      const message = event.type === 'offline'
        ? buildOfflineNotification({
          nodeName: client.name || client.uuid,
          offlineMinutes: Math.floor(event.offlineMs / 60000),
          lastSeen: event.lastSeenLabel,
          createdAt: event.createdAt,
          eventTime: new Date(now),
        })
        : buildNodeRecoveryNotification({ nodeName: client.name || client.uuid, recoveredAt: event.recoveredAt, eventTime: new Date(now) });
      let sent = false;
      try {
        sent = await sendNotification(app, settings, message);
      } catch (error) {
        if (!(error instanceof SubrequestBudgetExceeded)) throw error;
      }
      // 通知方式为 none 时也要推进状态，避免反复评估。
      if (sent || settings.notification_method === 'none') {
        state.last_notified = event.type === 'offline' ? new Date(now).toISOString() : null;
        alerts.offline[rule.client] = state;
        queueAudit(app, 'system', event.type === 'offline' ? 'offline_notify' : 'online_notify',
          `${sent ? '已发送' : '已记录'}${event.type === 'offline' ? '离线告警' : '恢复上线'}: ${client.name || client.uuid}`);
        sentCount += sent ? 1 : 0;
      }
    }
    const valid = new Set(rules.map(rule => rule.client));
    for (const uuid of Object.keys(alerts.offline)) if (!valid.has(uuid)) delete alerts.offline[uuid];
  });
  return `rules=${rules.length}; sent=${sentCount}; deferred=${deferred}`;
}

export function shouldSendExpiryNotification(args: {
  now: Date;
  expiredAt: string | null | undefined;
  advanceDays: number;
  lastNotified: string | null | undefined;
}): { daysLeft: number; expiredAt: string } | null {
  if (!args.expiredAt) return null;
  const expiryMs = new Date(args.expiredAt).getTime();
  const nowMs = args.now.getTime();
  if (Number.isNaN(expiryMs) || expiryMs < nowMs) return null;
  const advanceMs = Math.max(1, Number(args.advanceDays || 7)) * 24 * 60 * 60 * 1000;
  const windowStartMs = expiryMs - advanceMs;
  if (nowMs < windowStartMs) return null;
  const lastNotifiedMs = args.lastNotified ? new Date(args.lastNotified).getTime() : 0;
  if (!Number.isNaN(lastNotifiedMs) && lastNotifiedMs >= windowStartMs) return null;
  return {
    daysLeft: Math.max(0, Math.ceil((expiryMs - nowMs) / (24 * 60 * 60 * 1000))),
    expiredAt: new Date(expiryMs).toISOString(),
  };
}

async function runExpiryStep(app: AppServices, now: number): Promise<string> {
  const core = await readCore(app);
  const rules = core.expiry_notifications.filter(rule => rule.enable);
  if (rules.length === 0) return 'skipped';
  const settings = adminSettingsOf(core);
  const clients = new Map(core.clients.map(client => [client.uuid, client]));
  const alertsSnapshot = await app.kv.getJson<{ expiry?: Record<string, { last_notified: string | null }> }>('alerts', { maxAgeMs: 30_000 });
  const pending = rules.filter((rule) => {
    const client = clients.get(rule.client);
    return client && shouldSendExpiryNotification({
      now: new Date(now),
      expiredAt: client.expired_at,
      advanceDays: rule.advance_days,
      lastNotified: alertsSnapshot?.expiry?.[rule.client]?.last_notified ?? null,
    });
  });
  if (pending.length === 0) return 'skipped';
  let sentCount = 0;
  await mutateAlerts(app, async (alerts) => {
    for (const rule of pending) {
      const client = clients.get(rule.client)!;
      const state = alerts.expiry[rule.client] || { last_notified: null };
      const candidate = shouldSendExpiryNotification({ now: new Date(now), expiredAt: client.expired_at, advanceDays: rule.advance_days, lastNotified: state.last_notified });
      if (!candidate) continue;
      if (!app.subrequests.canSpend(Math.max(1, notificationCost(settings)))) break;
      let sent = false;
      try {
        sent = await sendNotification(app, settings, buildExpiryNotification({
          nodeName: client.name || client.uuid,
          expiredAt: candidate.expiredAt,
          daysLeft: candidate.daysLeft,
          eventTime: new Date(now),
        }));
      } catch (error) {
        if (!(error instanceof SubrequestBudgetExceeded)) throw error;
      }
      if (sent || settings.notification_method === 'none') {
        alerts.expiry[rule.client] = { last_notified: new Date(now).toISOString(), event: candidate.expiredAt };
        queueAudit(app, 'system', 'expiry_notify', `${sent ? '已发送' : '已记录'}到期提醒: ${client.name || client.uuid} - ${candidate.daysLeft} 天`);
        sentCount += sent ? 1 : 0;
      }
    }
  });
  return `pending=${pending.length}; sent=${sentCount}`;
}

async function runCleanupStep(app: AppServices, _now: number): Promise<string> {
  const core = await readCore(app);
  const settings = adminSettingsOf(core);
  const valid = new Set(sortedClients(core).map(client => client.uuid));
  const removedLive = await pruneLiveEntries(app, [], valid);
  let removedAudit = 0;
  if (app.kv.canSpend(2)) removedAudit = await pruneAuditLogs(app, Number(settings.audit_log_preserve_time || 2160));
  return `live=${removedLive}; audit=${removedAudit}`;
}
