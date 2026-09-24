/**
 * Agent 接入：鉴权、策略下发、上报入库。
 *
 * Agent 以 HTTP 模式工作（ESA 函数不支持 WebSocket 服务端）：
 *  - GET  /api/clients/policy：拉取上报间隔、Ping 任务、网站探测任务；
 *    有人在看实时面板时返回 mode=active，Agent 切换为高频上报；
 *  - POST /api/clients/report：上报指标（空闲时批量）。
 */

import type { AppServices } from '../platform/context';
import { SubrequestBudgetExceeded } from '../platform/context';
import type { MonitorRecord, PingTask, WebsiteCheckInput } from '../db/types';
import type { AgentMeta, CoreDoc, LiveEntry, StoredClient, StoredWebsiteMonitor } from '../store/types';
import { adminSettingsOf, readCore } from '../store/core';
import { readLiveEntries, readViewersUntil, viewerTtlMs, writeLiveEntry } from '../store/live';
import { appendGpuSnapshot, appendPingResults, appendRecords, loadMetricWindowStats, readNodeDocFresh, writeNodeDoc } from '../store/history';
import { applyWebsiteCheck, mutateWebsites } from '../store/websites';
import { normalizeMonitorReport, toMonitorRecord, type MonitorReportPayload } from '../utils/monitor-report';
import { compactLiveReport } from '../utils/live-report-state';
import { isPublicIpAddress } from '../utils/request-ip';
import { hashAgentToken, isAgentTokenShape } from '../utils/client';
import { buildIpChangeNotification, buildLoadNotification } from '../utils/notification-templates';
import { MAX_PING_VALUE_MS, PING_LOSS_VALUE } from '../utils/ping-result';
import { notificationCost, queueAudit, sendNotification } from './notify';

const HTTP_LIVE_TTL_FALLBACK_MS = 180_000;
const HTTP_LIVE_TTL_MAX_MS = 24 * 60 * 60 * 1000;
const TOKEN_USAGE_REFRESH_MS = 15 * 60_000;
const MAX_REPORTS_PER_BATCH = 300;
const METRIC_LABELS: Record<string, string> = { cpu: 'CPU', ram: '内存', load: '负载', disk: '磁盘', temp: '温度' };
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// 鉴权
// ---------------------------------------------------------------------------

export async function authenticateAgent(app: AppServices, token: string): Promise<{ core: CoreDoc; client: StoredClient } | null> {
  if (!token || !isAgentTokenShape(token)) return null;
  const hash = await hashAgentToken(token);
  let core = await readCore(app);
  let client = core.clients.find(item => item.token_hash === hash) ?? null;
  if (!client && app.kv.peek('core') === undefined) {
    // 模块缓存可能早于刚刚创建的节点：强制读一次 KV 再判定。
    core = await readCore(app, 0);
    client = core.clients.find(item => item.token_hash === hash) ?? null;
  }
  return client ? { core, client } : null;
}

// ---------------------------------------------------------------------------
// 策略
// ---------------------------------------------------------------------------

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

export function pingTasksForClient(core: CoreDoc, uuid: string, intervalSec: number): PingTask[] {
  return core.ping_tasks
    .filter(task => task.all_clients || task.clients.includes(uuid))
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || (a.id ?? 0) - (b.id ?? 0))
    .map(task => ({ ...task, interval_sec: intervalSec }));
}

/** 与原 cfm_agent_website_probe_tasks 相同的分配规则。 */
export function websiteProbeTasksForClient(core: CoreDoc, uuid: string, regions: Map<string, string>, limit = 20): StoredWebsiteMonitor[] {
  const visibleClients = core.clients
    .filter(client => !client.hidden)
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.name.localeCompare(b.name) || a.uuid.localeCompare(b.uuid));
  const selected: StoredWebsiteMonitor[] = [];
  for (const monitor of core.websites) {
    if (!monitor.enabled) continue;
    if (monitor.agent_probe_mode === 'selected') {
      if (monitor.agent_probe_clients.includes(uuid)) selected.push(monitor);
      continue;
    }
    if (monitor.agent_probe_mode !== 'country_auto') continue;
    const seenRegions = new Set<string>();
    visibleClients.forEach((client, index) => {
      const regionKey = regions.get(client.uuid) || client.uuid;
      const firstInRegion = !seenRegions.has(regionKey);
      seenRegions.add(regionKey);
      if (client.uuid === uuid && firstInRegion && index + 1 <= monitor.agent_probe_limit) selected.push(monitor);
    });
  }
  return selected
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.id - b.id)
    .slice(0, limit);
}

async function pingPolicyVersion(tasks: PingTask[], intervalSec: number): Promise<string> {
  const digestInput = JSON.stringify({
    interval_sec: intervalSec,
    tasks: tasks.map(task => ({
      id: task.id,
      name: task.name,
      type: task.type,
      target: task.target,
      interval_sec: task.interval_sec,
      all_clients: task.all_clients,
      clients: [...task.clients].sort(),
    })),
  });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(digestInput));
  return Array.from(new Uint8Array(digest)).slice(0, 8).map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function buildAgentPolicy(app: AppServices, core: CoreDoc, client: StoredClient) {
  const settings = adminSettingsOf(core);
  const now = app.now();
  const activeIntervalSec = boundedInt(settings.live_poll_active_interval_sec, 5, 3, 300);
  const idleIntervalSec = boundedInt(settings.live_poll_idle_interval_sec, 120, 60, 3600);
  const viewerTtlSec = Math.floor(viewerTtlMs(settings) / 1000);
  const pingIntervalSec = boundedInt(settings.ping_record_persist_interval_sec, 120, 60, 3600);
  const viewersUntil = await readViewersUntil(app, 10_000);
  const active = viewersUntil > now;
  const pingTasks = pingTasksForClient(core, client.uuid, pingIntervalSec);
  const hasProbeMonitors = core.websites.some(monitor => monitor.enabled && monitor.agent_probe_mode !== 'off');
  let websiteTasks: StoredWebsiteMonitor[] = [];
  if (hasProbeMonitors) {
    const needsRegions = core.websites.some(monitor => monitor.enabled && monitor.agent_probe_mode === 'country_auto');
    const regions = new Map<string, string>();
    if (needsRegions) {
      const entries = await readLiveEntries(app, 60_000);
      for (const [uuid, entry] of entries) if (entry.m?.region) regions.set(uuid, entry.m.region);
    }
    websiteTasks = websiteProbeTasksForClient(core, client.uuid, regions);
  }
  const sampleIntervalSec = active ? activeIntervalSec : Math.min(idleIntervalSec, 60);
  const reportIntervalSec = active ? activeIntervalSec : idleIntervalSec;
  const trafficResetDay = Number(client.traffic_reset_day);
  return {
    type: 'policy',
    mode: active ? 'active' : 'idle',
    sample_interval_sec: sampleIntervalSec,
    report_interval_sec: reportIntervalSec,
    ping_interval_sec: pingIntervalSec,
    ping_policy_version: await pingPolicyVersion(pingTasks, pingIntervalSec),
    ping_tasks: pingTasks.map(task => ({
      id: task.id,
      name: task.name,
      type: task.type,
      target: task.target,
      interval_sec: task.interval_sec,
      clients: task.clients,
      all_clients: task.all_clients,
    })),
    website_probe_tasks: websiteTasks.map(monitor => ({
      id: monitor.id,
      config_revision: monitor.config_revision,
      name: monitor.name,
      url: monitor.url,
      method: monitor.method,
      expected_status_min: monitor.expected_status_min,
      expected_status_max: monitor.expected_status_max,
      timeout_sec: monitor.timeout_sec,
      interval_sec: monitor.interval_sec,
    })),
    report_now: active,
    viewer_count: active ? 1 : 0,
    viewer_ttl_sec: viewerTtlSec,
    policy_ttl_sec: 30,
    idle_policy_ttl_sec: 60,
    ...(Number.isInteger(trafficResetDay) && trafficResetDay >= 1 && trafficResetDay <= 31 ? { traffic_reset_day: trafficResetDay } : {}),
    timestamp: now,
  };
}

// ---------------------------------------------------------------------------
// 上报
// ---------------------------------------------------------------------------

function nonEmptyString(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

function isUnknownRegion(value: string): boolean {
  return /^(unknown|未知)$/i.test(value.trim());
}

function preferredRegion(...values: unknown[]): string {
  const candidates = values.map(value => nonEmptyString(value)).filter(value => value && !isUnknownRegion(value));
  return candidates.find(value => !/^[A-Z]{2}$/i.test(value)) || candidates[0] || '';
}

function publicIp(...values: unknown[]): string {
  for (const value of values) {
    const ip = nonEmptyString(value);
    if (ip && isPublicIpAddress(ip)) return ip;
  }
  return '';
}

function positiveNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegativeNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function reportTimestamp(report: Record<string, unknown>, fallback: number, now: number): number {
  const parsed = Number(report.timestamp);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > now + 60_000) return fallback;
  return parsed;
}

function liveTtlMs(report: Record<string, unknown>): number {
  const intervalSec = Number(report.report_interval ?? report.interval_sec ?? report.interval);
  if (!Number.isFinite(intervalSec) || intervalSec <= 0) return HTTP_LIVE_TTL_FALLBACK_MS;
  return Math.min(Math.max(intervalSec * 3 * 1000, 30_000), HTTP_LIVE_TTL_MAX_MS);
}

function sanitizeReport(report: MonitorReportPayload, sourceIp: string): MonitorReportPayload {
  const safe = { ...report } as MonitorReportPayload & Record<string, unknown>;
  delete safe.token;
  delete safe.authorization;
  delete safe.password;
  for (const field of ['ipv4', 'ipv6'] as const) {
    const value = safe[field];
    if (typeof value === 'string' && value.trim() && !isPublicIpAddress(value.trim())) delete safe[field];
  }
  if (isPublicIpAddress(sourceIp)) {
    const field = sourceIp.includes(':') ? 'ipv6' : 'ipv4';
    if (typeof safe[field] !== 'string' || !isPublicIpAddress(String(safe[field]))) safe[field] = sourceIp;
  }
  if (typeof safe.region === 'string' && (!safe.region.trim() || isUnknownRegion(safe.region))) delete safe.region;
  return safe;
}

/** 由上报合成新的 Agent 信息；返回合并后的 meta 以及 IP 变化说明。 */
function mergeAgentMeta(previous: AgentMeta, reports: MonitorReportPayload[], sourceIp: string, now: number): { meta: AgentMeta; ipChanges: string[] } {
  const latest = reports[reports.length - 1];
  let basic: Record<string, unknown> | null = null;
  for (let index = reports.length - 1; index >= 0; index -= 1) {
    const candidate = reports[index].basic_info;
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      basic = candidate as Record<string, unknown>;
      break;
    }
  }
  const sourceV4 = sourceIp && !sourceIp.includes(':') ? sourceIp : '';
  const sourceV6 = sourceIp && sourceIp.includes(':') ? sourceIp : '';
  const ipv4 = publicIp(latest.ipv4, basic?.ipv4, sourceV4, previous.ipv4) || previous.ipv4 || '';
  const ipv6 = publicIp(latest.ipv6, basic?.ipv6, sourceV6, previous.ipv6) || previous.ipv6 || '';
  const meta: AgentMeta = {
    ...previous,
    ipv4,
    ipv6,
    region: preferredRegion(latest.region, basic?.region, previous.region) || previous.region || '',
    version: nonEmptyString(latest.version, previous.version || ''),
  };
  if (basic) {
    meta.cpu_name = nonEmptyString(basic.cpu_name, previous.cpu_name || '');
    meta.virtualization = nonEmptyString(basic.virtualization, previous.virtualization || '');
    meta.arch = nonEmptyString(basic.arch, previous.arch || '');
    meta.cpu_cores = positiveNumber(basic.cpu_cores, previous.cpu_cores || 0);
    meta.os = nonEmptyString(basic.os, previous.os || '');
    meta.kernel_version = nonEmptyString(basic.kernel_version, previous.kernel_version || '');
    meta.gpu_name = nonEmptyString(basic.gpu_name, previous.gpu_name || '');
    meta.mem_total = positiveNumber(basic.mem_total, previous.mem_total || 0);
    meta.swap_total = nonNegativeNumber(basic.swap_total, previous.swap_total || 0);
    meta.disk_total = basic.disk_total === undefined ? (previous.disk_total || 0) : positiveNumber(basic.disk_total);
    meta.version = nonEmptyString(basic.version, meta.version || '');
  } else {
    if (!meta.mem_total && latest.ram_total) meta.mem_total = latest.ram_total;
    if (!meta.swap_total && latest.swap_total) meta.swap_total = latest.swap_total;
    if (!meta.disk_total && latest.disk_total) meta.disk_total = latest.disk_total;
  }
  const lastUsedMs = previous.token_last_used_at ? Date.parse(previous.token_last_used_at) : 0;
  if (!lastUsedMs || now - lastUsedMs >= TOKEN_USAGE_REFRESH_MS || (sourceIp && previous.token_last_used_ip !== sourceIp)) {
    meta.token_last_used_at = new Date(now).toISOString();
    meta.token_last_used_ip = sourceIp.slice(0, 128);
  }
  const ipChanges: string[] = [];
  if (previous.ipv4 && ipv4 && previous.ipv4 !== ipv4) ipChanges.push(`IPv4: ${previous.ipv4} → ${ipv4}`);
  if (previous.ipv6 && ipv6 && previous.ipv6 !== ipv6) ipChanges.push(`IPv6: ${previous.ipv6.slice(0, 10)}… → ${ipv6.slice(0, 10)}…`);
  return { meta, ipChanges };
}

export interface IngestResult {
  accepted: number;
  persisted: boolean;
  website_results: number;
  deferred_history: boolean;
}

interface ParsedPing {
  timeMs: number;
  taskId: number;
  value: number;
}

function collectPingResults(reports: Array<{ report: MonitorReportPayload; timeMs: number }>, allowed: Set<number>): ParsedPing[] {
  const results: ParsedPing[] = [];
  for (const { report, timeMs } of reports) {
    const raw = Array.isArray(report.ping_results)
      ? report.ping_results
      : (report.ping && typeof report.ping === 'object' && Array.isArray((report.ping as { results?: unknown }).results))
        ? (report.ping as { results: unknown[] }).results
        : [];
    for (const item of (raw as unknown[]).slice(0, 50)) {
      if (!item || typeof item !== 'object') continue;
      const taskId = Number((item as Record<string, unknown>).task_id);
      const value = Number((item as Record<string, unknown>).value);
      if (!Number.isInteger(taskId) || !allowed.has(taskId)) continue;
      if (!Number.isFinite(value) || (value !== PING_LOSS_VALUE && (value < 0 || value > MAX_PING_VALUE_MS))) continue;
      results.push({ timeMs, taskId, value });
    }
  }
  return results;
}

function collectWebsiteResults(
  reports: Array<{ report: MonitorReportPayload; timeMs: number }>,
  core: CoreDoc,
  uuid: string,
): Array<{ monitor: StoredWebsiteMonitor; check: WebsiteCheckInput }> {
  const monitors = new Map(core.websites.map(monitor => [monitor.id, monitor]));
  const results: Array<{ monitor: StoredWebsiteMonitor; check: WebsiteCheckInput }> = [];
  for (const { report, timeMs } of reports) {
    const raw = Array.isArray(report.website_probe_results) ? report.website_probe_results.slice(0, 50) : [];
    for (const item of raw as Array<Record<string, unknown>>) {
      if (!item || typeof item !== 'object') continue;
      const monitor = monitors.get(Number(item.monitor_id));
      const configRevision = item.config_revision;
      const latencyMs = Math.round(Number(item.latency_ms));
      const statusCode = item.status_code === null || item.status_code === undefined ? null : Number(item.status_code);
      const rawStatusCode = item.raw_status_code === null || item.raw_status_code === undefined ? statusCode : Number(item.raw_status_code);
      const effectiveStatus = item.effective_status === 'up' ? 'up' : item.effective_status === 'down' ? 'down' : null;
      if (
        !monitor || !monitor.enabled || monitor.agent_probe_mode === 'off' ||
        (monitor.agent_probe_mode === 'selected' && !monitor.agent_probe_clients.includes(uuid)) ||
        typeof configRevision !== 'string' || !UUID_PATTERN.test(configRevision) ||
        !Number.isFinite(latencyMs) || latencyMs < 0 || latencyMs > 60_000 || !effectiveStatus ||
        (statusCode !== null && (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599)) ||
        (rawStatusCode !== null && (!Number.isInteger(rawStatusCode) || rawStatusCode < 100 || rawStatusCode > 599))
      ) continue;
      results.push({
        monitor,
        check: {
          monitor_id: monitor.id,
          config_revision: configRevision,
          checked_at: new Date(timeMs).toISOString(),
          ok: Boolean(item.ok) && effectiveStatus === 'up',
          effective_status: effectiveStatus,
          effective_reason: typeof item.effective_reason === 'string' ? item.effective_reason.slice(0, 80) : effectiveStatus,
          status_code: statusCode,
          raw_status_code: rawStatusCode,
          latency_ms: latencyMs,
          error: typeof item.error === 'string' && item.error ? item.error.slice(0, 120) : null,
          source_type: 'agent',
          source_client: uuid,
        },
      });
    }
  }
  return results;
}

export function extractReportItems(body: Record<string, unknown>): Record<string, unknown>[] {
  const raw = Array.isArray(body.reports) ? body.reports.slice(0, MAX_REPORTS_PER_BATCH) : [body];
  return raw.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item));
}

export async function ingestReports(
  app: AppServices,
  core: CoreDoc,
  client: StoredClient,
  rawReports: Record<string, unknown>[],
  sourceIp: string,
): Promise<IngestResult> {
  const now = app.now();
  const settings = adminSettingsOf(core);
  const uuid = client.uuid;
  const items = rawReports
    .map((raw) => {
      const normalized = normalizeMonitorReport(raw);
      return { report: sanitizeReport(normalized, sourceIp), timeMs: reportTimestamp(normalized, now, now) };
    })
    .sort((a, b) => a.timeMs - b.timeMs);
  const latest = items[items.length - 1].report;

  // 1. 实时状态（必做）。
  let ipChanges: string[] = [];
  let previousHistoryAt = 0;
  const recordIntervalSec = boundedInt(settings.record_persist_interval_sec, 120, 30, 3600);
  const pingIntervalSec = boundedInt(settings.ping_record_persist_interval_sec, 120, 60, 3600);
  const allowedPingTasks = new Set(pingTasksForClient(core, uuid, pingIntervalSec).map(task => Number(task.id)));
  const pings = collectPingResults(items, allowedPingTasks);
  const recordEnabled = settings.record_enabled !== 'false';
  const historyDueAt = (entry: LiveEntry | undefined) => (entry?.h || 0) + recordIntervalSec * 950;
  let writeHistory = false;
  await writeLiveEntry(app, uuid, (previous) => {
    const merged = mergeAgentMeta(previous?.m || {}, items.map(item => item.report), sourceIp, now);
    ipChanges = merged.ipChanges;
    previousHistoryAt = previous?.h || 0;
    writeHistory = recordEnabled && (now >= historyDueAt(previous) || pings.length > 0 || items.length > 1);
    return {
      t: now,
      exp: now + liveTtlMs(latest),
      r: compactLiveReport(latest),
      m: merged.meta,
      h: writeHistory ? now : previousHistoryAt,
    };
  });

  // 2. Agent 网站探测结果（有才写）。
  const websiteResults = recordEnabled ? collectWebsiteResults(items, core, uuid) : [];
  let websiteApplied = 0;
  if (websiteResults.length > 0 && app.kv.canSpend(2)) {
    await mutateWebsites(app, (doc) => {
      for (const { monitor, check } of websiteResults) {
        if (applyWebsiteCheck(doc, monitor, check, now)) websiteApplied += 1;
      }
    });
  }

  // 3. 历史、Ping、GPU、负载告警（到期才写）。
  let persisted = false;
  let deferredHistory = false;
  if (writeHistory) {
    if (app.kv.canSpend(2)) {
      const doc = await readNodeDocFresh(app, uuid);
      const retentionHours = boundedInt(settings.record_preserve_time, 72, 1, 72);
      const records: Array<{ timeMs: number; record: MonitorRecord }> = items.map(item => ({
        timeMs: item.timeMs,
        record: toMonitorRecord(uuid, new Date(item.timeMs).toISOString(), item.report),
      }));
      persisted = appendRecords(doc, records, { nowMs: now, intervalSec: recordIntervalSec, retentionHours });
      if (pings.length > 0) {
        appendPingResults(doc, pings, {
          nowMs: now,
          intervalSec: pingIntervalSec,
          retentionHours: boundedInt(settings.ping_record_preserve_time, retentionHours, 1, 72),
          validTaskIds: new Set(core.ping_tasks.map(task => String(task.id))),
        });
      }
      const lastWithGpu = [...items].reverse().find(item => Array.isArray(item.report.gpus) && item.report.gpus.length > 0);
      if (lastWithGpu) appendGpuSnapshot(doc, lastWithGpu.timeMs, lastWithGpu.report.gpus, retentionHours);
      await evaluateLoadAlerts(app, core, client, settings, doc.load_alerts, (startMs, endMs, metric, threshold) =>
        loadMetricWindowStats(doc, startMs, endMs, metric, threshold));
      await writeNodeDoc(app, doc);
    } else {
      deferredHistory = true;
    }
  }

  // 4. IP 变化通知（可选）。
  if (ipChanges.length > 0) {
    queueAudit(app, 'system', 'ip_change', `IP 变更: ${client.name} ${ipChanges.join(', ')}`);
    if (settings.enable_ip_change_notification === 'true' && app.subrequests.canSpend(notificationCost(settings))) {
      try {
        await sendNotification(app, settings, buildIpChangeNotification({ nodeName: client.name, parts: ipChanges }));
      } catch (error) {
        if (!(error instanceof SubrequestBudgetExceeded)) throw error;
      }
    }
  }

  return { accepted: items.length, persisted, website_results: websiteApplied, deferred_history: deferredHistory };
}

async function evaluateLoadAlerts(
  app: AppServices,
  core: CoreDoc,
  client: StoredClient,
  settings: Record<string, string>,
  state: Record<string, number>,
  stats: (startMs: number, endMs: number, metric: 'cpu' | 'ram' | 'load' | 'disk' | 'temp', threshold: number) => { samples: number; exceeded: number; avg_value: number },
): Promise<void> {
  const now = app.now();
  const rules = core.load_notifications.filter(rule => rule.clients.length === 0 || rule.clients.includes(client.uuid));
  const validIds = new Set(core.load_notifications.map(rule => String(rule.id)));
  for (const key of Object.keys(state)) if (!validIds.has(key)) delete state[key];
  for (const rule of rules) {
    const intervalMs = Math.max(1, Number(rule.interval_min || 15)) * 60_000;
    const last = state[String(rule.id)] || 0;
    if (last && now - last < intervalMs) continue;
    const threshold = Number(rule.threshold ?? 80);
    const ratio = Math.max(0, Math.min(1, Number(rule.ratio ?? 0.8)));
    const result = stats(now - intervalMs, now, rule.metric, threshold);
    if (result.samples < 2) continue;
    const exceedRatio = result.exceeded / result.samples;
    if (exceedRatio < ratio) continue;
    if (settings.notification_method !== 'none' && !app.subrequests.canSpend(notificationCost(settings))) return;
    const label = METRIC_LABELS[rule.metric] || rule.metric;
    let sent = false;
    try {
      sent = await sendNotification(app, settings, buildLoadNotification({
        ruleName: rule.name,
        nodeName: client.name || client.uuid,
        metricLabel: label,
        avgValue: result.avg_value,
        threshold,
        exceedRatio,
        requiredRatio: ratio,
        eventTime: new Date(now),
      }));
    } catch (error) {
      if (error instanceof SubrequestBudgetExceeded) return;
      throw error;
    }
    if (sent || settings.notification_method === 'none') {
      state[String(rule.id)] = now;
      queueAudit(app, 'system', 'load_notify', `${sent ? '已发送' : '已记录'}负载告警: ${client.name || client.uuid} - ${label}`);
    }
  }
}
