import { sanitizeSetupDiagnosticDetail } from './setup-diagnostics';

export type HealthStatus = 'ok' | 'warning' | 'error' | 'disabled';

export interface HealthEvent {
  component: string;
  status: HealthStatus;
  updated_at: string;
  last_success_at?: string;
  last_failure_at?: string;
  detail?: string;
  stale?: boolean;
}

export {
  HEALTH_STALE_AFTER_MS,
  healthComponentsOk,
  isHealthEventStale,
  markStaleEvents,
} from './health-staleness.ts';

/** 健康组件名称。ESA 版本只在实例内存中保留最近状态，错误会写入审计日志。 */
export const STORED_HEALTH_COMPONENTS = [
  'record_persistence',
  'ping_persistence',
  'website_probe_persistence',
  'agent_policy',
  'telegram',
  'email',
  'webhook',
  'notification',
  'cron_cleanup',
  'cron_load',
  'cron_offline',
  'cron_expiry',
  'cron_website',
] as const;

export type StoredHealthComponent = typeof STORED_HEALTH_COMPONENTS[number];

const MAX_DETAIL_LENGTH = 700;
const healthEvents = new Map<string, HealthEvent>();

function truncateDetail(detail: unknown): string {
  return String(detail ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_DETAIL_LENGTH);
}

export function errorDetail(error: unknown): string {
  return truncateDetail(sanitizeSetupDiagnosticDetail(error));
}

export function recordLocalHealthEvent(component: string, status: HealthStatus, detail: unknown, nowMs = Date.now()): HealthEvent {
  const previous = healthEvents.get(component);
  const updatedAt = new Date(nowMs).toISOString();
  const event: HealthEvent = {
    component,
    status,
    updated_at: updatedAt,
    detail: truncateDetail(detail),
    last_success_at: status === 'ok' ? updatedAt : previous?.last_success_at,
    last_failure_at: status === 'error' ? updatedAt : previous?.last_failure_at,
  };
  healthEvents.set(component, event);
  return event;
}

export function readLocalHealthEvents(): HealthEvent[] {
  return [...healthEvents.values()].sort((a, b) => a.component.localeCompare(b.component));
}
