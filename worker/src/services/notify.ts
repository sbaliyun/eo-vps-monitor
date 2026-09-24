/**
 * 通知发送与审计缓冲。
 *
 * - 所有出站通知走请求内的子请求预算（ESA 默认每个请求最多 4 个 fetch）；
 * - 审计日志先进缓冲，请求结束时合并成一次 KV 读-改-写。
 */

import type { AppServices } from '../platform/context';
import { dispatchNotification } from '../utils/notification-dispatch';
import type { NotificationMessage } from '../utils/notification-templates';
import { errorDetail, recordLocalHealthEvent, type HealthStatus, type StoredHealthComponent } from '../utils/observability';
import { appendAuditLogs, type AuditInput } from '../store/audit';

const auditBuffers = new WeakMap<AppServices, AuditInput[]>();
const AUDIT_THROTTLE_MS = 5 * 60 * 1000;
const auditThrottle = new Map<string, number>();

export function queueAudit(app: AppServices, user: string, action: string, detail: string, level = 'info'): void {
  let buffer = auditBuffers.get(app);
  if (!buffer) {
    buffer = [];
    auditBuffers.set(app, buffer);
  }
  if (buffer.length < 50) buffer.push({ user, action, detail, level });
}

/** 同一实例内按 key 节流的审计（例如重复的错误）。 */
export function queueThrottledAudit(app: AppServices, key: string, user: string, action: string, detail: string, level = 'warning'): void {
  const now = app.now();
  const last = auditThrottle.get(key) || 0;
  if (now - last < AUDIT_THROTTLE_MS) return;
  if (auditThrottle.size > 512) auditThrottle.clear();
  auditThrottle.set(key, now);
  queueAudit(app, user, action, detail, level);
}

export async function flushAudit(app: AppServices, retentionHours?: number): Promise<void> {
  const buffer = auditBuffers.get(app);
  if (!buffer || buffer.length === 0) return;
  auditBuffers.delete(app);
  const written = await appendAuditLogs(app, buffer, retentionHours);
  if (!written) {
    for (const entry of buffer) console.log(`[audit] ${entry.user} ${entry.action}: ${entry.detail}`);
  }
}

export function healthRecorder(app: AppServices) {
  return async (
    _database: unknown,
    component: StoredHealthComponent,
    status: HealthStatus,
    detail?: unknown,
    options?: { auditAction?: string; auditUser?: string; auditLevel?: string },
  ): Promise<void> => {
    recordLocalHealthEvent(component, status, detail, app.now());
    if (status === 'error' && options?.auditAction) {
      queueThrottledAudit(app, `${component}:${options.auditAction}`, options.auditUser || 'system', options.auditAction, errorDetail(detail), options.auditLevel || 'error');
    }
  };
}

/** 按当前通知配置发送。预算不足时抛出 SubrequestBudgetExceeded，由调用方延后处理。 */
export async function sendNotification(
  app: AppServices,
  settings: Record<string, string>,
  message: NotificationMessage,
  options: { channel?: string; auditUser?: string } = {},
): Promise<boolean> {
  const channel = options.channel || settings.notification_method || 'telegram';
  if (channel === 'none') return false;
  return dispatchNotification(undefined, settings, message, {
    channel,
    auditUser: options.auditUser,
    fetcher: app.subrequests.fetch,
    deps: { recordHealth: healthRecorder(app) },
  });
}

/** 通知至少需要的子请求数（Webhook 重试会多用）。 */
export function notificationCost(settings: Record<string, string>): number {
  if (settings.notification_method === 'none') return 0;
  if (settings.notification_method === 'webhook') return Math.min(3, Math.max(1, Number(settings.webhook_retry_count || 1)));
  return 1;
}
