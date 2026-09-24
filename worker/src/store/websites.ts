/**
 * 网站监控运行状态：`websites` 文档，保存每个监控的最新状态与心跳历史。
 *
 * 历史只保留前端心跳条真正需要的部分：最近 90 次原始检测 + 72 小时内每 20 分钟一个代表点。
 */

import type { AppServices } from '../platform/context';
import type {
  PublicWebsiteMonitor,
  WebsiteCheck,
  WebsiteCheckInput,
  WebsiteMonitor,
  WebsiteMonitorStatus,
} from '../db/types';
import type { CompactCheck, StoredWebsiteMonitor, WebsiteRuntime, WebsitesDoc } from './types';

export const WEBSITES_KEY = 'websites';
export const WEBSITES_READ_CACHE_MS = 5_000;
const RECENT_LIMIT = 90;
const BUCKET_SEC = 20 * 60;
const BUCKET_WINDOW_SEC = 72 * 60 * 60;

export function emptyRuntime(configRevision: string, enabled: boolean): WebsiteRuntime {
  return {
    config_revision: configRevision,
    status: enabled ? 'pending' : 'paused',
    last_checked_at: null,
    last_success_at: null,
    last_failure_at: null,
    last_status_code: null,
    last_raw_status_code: null,
    last_latency_ms: null,
    last_effective_reason: null,
    last_error: null,
    down_since: null,
    last_notified_at: null,
    recent: [],
    buckets: [],
  };
}

function normalizeDoc(doc: WebsitesDoc | null): WebsitesDoc {
  return doc && doc.monitors && typeof doc.monitors === 'object' ? doc : { monitors: {} };
}

export async function readWebsites(app: AppServices, maxAgeMs = WEBSITES_READ_CACHE_MS): Promise<WebsitesDoc> {
  return normalizeDoc(await app.kv.getJson<WebsitesDoc>(WEBSITES_KEY, { maxAgeMs }));
}

export async function mutateWebsites<T>(app: AppServices, mutate: (doc: WebsitesDoc) => T | Promise<T>): Promise<T> {
  const doc = normalizeDoc(await app.kv.getFreshJson<WebsitesDoc>(WEBSITES_KEY));
  const result = await mutate(doc);
  await app.kv.putJson(WEBSITES_KEY, doc);
  return result;
}

/** 取运行状态；配置修订号变化（编辑过配置）时视为全新监控。 */
export function runtimeFor(doc: WebsitesDoc, monitor: StoredWebsiteMonitor): WebsiteRuntime {
  const runtime = doc.monitors[String(monitor.id)];
  if (!runtime || runtime.config_revision !== monitor.config_revision) {
    return emptyRuntime(monitor.config_revision, monitor.enabled);
  }
  if (!monitor.enabled) return { ...runtime, status: 'paused' };
  return runtime;
}

export function toWebsiteMonitor(monitor: StoredWebsiteMonitor, runtime: WebsiteRuntime): WebsiteMonitor {
  return {
    ...monitor,
    status: monitor.enabled ? runtime.status : 'paused',
    last_checked_at: runtime.last_checked_at,
    last_success_at: runtime.last_success_at,
    last_failure_at: runtime.last_failure_at,
    last_status_code: runtime.last_status_code,
    last_raw_status_code: runtime.last_raw_status_code,
    last_latency_ms: runtime.last_latency_ms,
    last_effective_reason: runtime.last_effective_reason,
    last_error: runtime.last_error,
    down_since: runtime.down_since,
    last_notified_at: runtime.last_notified_at,
  };
}

function expandCheck(monitorId: number, configRevision: string, check: CompactCheck, index: number): WebsiteCheck {
  const [t, ok, statusCode, rawStatusCode, latency, reason, source, sourceClient] = check;
  return {
    id: t * 100 + (index % 100),
    monitor_id: monitorId,
    config_revision: configRevision,
    checked_at: new Date(t * 1000).toISOString(),
    ok: ok === 1,
    effective_status: ok === 1 ? 'up' : 'down',
    effective_reason: reason,
    status_code: statusCode,
    raw_status_code: rawStatusCode,
    latency_ms: latency,
    error: ok === 1 ? null : reason,
    source_type: source === 'a' ? 'agent' : 'worker',
    source_client: sourceClient,
  };
}

/** 合并原始检测与分桶代表点，新在前，只返回 sinceSec 之后的记录。 */
export function listChecks(monitor: StoredWebsiteMonitor, runtime: WebsiteRuntime, limit: number, sinceSec = 0): WebsiteCheck[] {
  const seen = new Set<number>();
  const merged: CompactCheck[] = [];
  for (const check of runtime.recent) {
    if (check[0] < sinceSec || seen.has(check[0])) continue;
    seen.add(check[0]);
    merged.push(check);
  }
  const oldestRecent = runtime.recent.length ? runtime.recent[runtime.recent.length - 1][0] : Number.POSITIVE_INFINITY;
  for (const check of runtime.buckets) {
    if (check[0] >= oldestRecent || check[0] < sinceSec || seen.has(check[0])) continue;
    seen.add(check[0]);
    merged.push(check);
  }
  merged.sort((a, b) => b[0] - a[0]);
  return merged.slice(0, limit).map((check, index) => expandCheck(monitor.id, runtime.config_revision, check, index));
}

function toCompact(check: WebsiteCheckInput): CompactCheck {
  const seconds = Math.floor(Date.parse(check.checked_at) / 1000);
  return [
    Number.isFinite(seconds) ? seconds : Math.floor(Date.now() / 1000),
    check.ok ? 1 : 0,
    check.status_code ?? null,
    check.raw_status_code ?? null,
    check.latency_ms === null || check.latency_ms === undefined ? null : Math.round(check.latency_ms),
    (check.ok ? check.effective_reason : (check.error || check.effective_reason)) ?? null,
    check.source_type === 'agent' ? 'a' : 'w',
    check.source_client ?? null,
  ];
}

function addToBuckets(runtime: WebsiteRuntime, compact: CompactCheck, nowSec: number): void {
  const bucket = Math.floor(compact[0] / BUCKET_SEC);
  const index = runtime.buckets.findIndex(item => Math.floor(item[0] / BUCKET_SEC) === bucket);
  if (index >= 0) {
    // 同一桶保留最新的一次；最新一次若成功而桶内出现过失败，仍保留失败以免掩盖故障。
    const existing = runtime.buckets[index];
    if (compact[0] >= existing[0] && !(existing[1] === 0 && compact[1] === 1)) runtime.buckets[index] = compact;
  } else {
    runtime.buckets.push(compact);
  }
  runtime.buckets.sort((a, b) => b[0] - a[0]);
  runtime.buckets = runtime.buckets.filter(item => item[0] >= nowSec - BUCKET_WINDOW_SEC);
}

/**
 * 记录一次检测结果（原 cfm_record_website_check 的语义）。
 * 返回更新后的监控视图；结果过期/不匹配时返回 null。
 */
export function applyWebsiteCheck(
  doc: WebsitesDoc,
  monitor: StoredWebsiteMonitor,
  check: WebsiteCheckInput,
  nowMs: number,
): WebsiteMonitor | null {
  if (!monitor.enabled || check.config_revision !== monitor.config_revision) return null;
  const runtime = runtimeFor(doc, monitor);
  const checkedMs = Date.parse(check.checked_at);
  if (!Number.isFinite(checkedMs)) return null;
  const compact = toCompact(check);
  const sourceType = check.source_type === 'agent' ? 'a' : 'w';
  const sourceClient = check.source_client ?? null;
  if (runtime.recent.some(item => item[6] === sourceType && item[7] === sourceClient && item[0] > compact[0])) return null;

  runtime.recent.unshift(compact);
  runtime.recent.sort((a, b) => b[0] - a[0]);
  runtime.recent = runtime.recent.slice(0, RECENT_LIMIT);
  addToBuckets(runtime, compact, Math.floor(nowMs / 1000));

  const checkedIso = new Date(checkedMs).toISOString();
  const lastCheckedMs = runtime.last_checked_at ? Date.parse(runtime.last_checked_at) : 0;
  const stateIsStale = lastCheckedMs && checkedMs <= lastCheckedMs;

  // Agent 报失败但近期有其他 Agent 报成功：只记历史，不改变状态（交给边缘兜底复核）。
  if (check.source_type === 'agent' && monitor.agent_probe_status_enabled && !check.ok) {
    const windowSec = Math.max(monitor.interval_sec + 30, monitor.grace_period_sec, 180);
    const recentAgentUp = runtime.recent.some(item => item[6] === 'a' && item[1] === 1 && item[0] >= compact[0] - windowSec);
    doc.monitors[String(monitor.id)] = runtime;
    if (recentAgentUp) return null;
    return toWebsiteMonitor(monitor, runtime);
  }

  if (!stateIsStale) {
    if (check.ok) {
      runtime.status = 'up';
      runtime.last_checked_at = checkedIso;
      runtime.last_success_at = checkedIso;
      runtime.last_status_code = check.status_code ?? null;
      runtime.last_raw_status_code = check.raw_status_code ?? null;
      runtime.last_latency_ms = check.latency_ms ?? null;
      runtime.last_effective_reason = check.effective_reason ?? null;
      runtime.last_error = null;
      runtime.down_since = null;
    } else {
      const wasDown = runtime.status === 'down';
      runtime.status = 'down';
      runtime.last_checked_at = checkedIso;
      runtime.last_failure_at = checkedIso;
      runtime.last_status_code = check.status_code ?? null;
      runtime.last_raw_status_code = check.raw_status_code ?? null;
      runtime.last_latency_ms = check.latency_ms ?? null;
      runtime.last_effective_reason = check.effective_reason ?? null;
      runtime.last_error = check.error ?? null;
      runtime.down_since = runtime.down_since || checkedIso;
      if (!wasDown) runtime.last_notified_at = null;
    }
  }
  doc.monitors[String(monitor.id)] = runtime;
  return toWebsiteMonitor(monitor, runtime);
}

export function markWebsiteNotified(doc: WebsitesDoc, monitor: StoredWebsiteMonitor, time: string | null): void {
  const runtime = runtimeFor(doc, monitor);
  runtime.last_notified_at = time;
  doc.monitors[String(monitor.id)] = runtime;
}

export function isWebsiteDue(monitor: StoredWebsiteMonitor, runtime: WebsiteRuntime, nowMs: number): boolean {
  if (!monitor.enabled) return false;
  if (!runtime.last_checked_at) return true;
  return nowMs - Date.parse(runtime.last_checked_at) >= Math.max(1, monitor.interval_sec - 30) * 1000;
}

/**
 * 是否需要边缘函数自己检测：未启用 Agent 探测的 HTTP 监控；
 * 或启用了「边缘兜底」且近期没有 Agent 报告成功的监控。TCP 监控只能由 Agent 探测。
 */
export function needsEdgeCheck(monitor: StoredWebsiteMonitor, runtime: WebsiteRuntime, nowMs: number): boolean {
  if (monitor.method === 'TCP') return false;
  if (monitor.agent_probe_mode === 'off') return true;
  if (!monitor.agent_probe_status_enabled) return false;
  const windowSec = Math.max(monitor.interval_sec + 30, monitor.grace_period_sec, 180);
  const cutoff = Math.floor(nowMs / 1000) - windowSec;
  return !runtime.recent.some(item => item[6] === 'a' && item[1] === 1 && item[0] >= cutoff);
}

export function toPublicWebsiteMonitor(
  monitor: StoredWebsiteMonitor,
  runtime: WebsiteRuntime,
  checkLimit: number,
  sinceSec: number,
): PublicWebsiteMonitor & { hidden: boolean } {
  const status: WebsiteMonitorStatus = monitor.enabled ? runtime.status : 'paused';
  return {
    id: monitor.id,
    name: monitor.name,
    url: monitor.hide_url ? null : monitor.url,
    method: monitor.method,
    hide_url: monitor.hide_url,
    hidden: monitor.hidden,
    interval_sec: monitor.interval_sec,
    status,
    last_checked_at: runtime.last_checked_at,
    last_status_code: runtime.last_status_code,
    last_raw_status_code: runtime.last_raw_status_code,
    last_latency_ms: runtime.last_latency_ms,
    last_effective_reason: runtime.last_effective_reason,
    checks: listChecks(monitor, runtime, checkLimit, sinceSec).map(check => ({
      checked_at: check.checked_at,
      ok: check.ok,
      effective_status: check.effective_status,
      effective_reason: check.effective_reason,
      status_code: check.status_code,
      raw_status_code: check.raw_status_code,
      latency_ms: check.latency_ms,
      source_type: check.source_type,
      source_client: check.source_client,
    })),
  };
}
