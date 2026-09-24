/**
 * 节点历史：`node_<uuid>` 文档，只有该节点自己的上报会写入（单写者，无并发覆盖）。
 *
 * - fine：按「记录持久化间隔」采样，保留最近 4 小时；
 * - coarse：10 分钟均值（计数器类字段取最后值），保留 record_preserve_time 小时；
 * - ping：每个任务的精细层（Ping 持久化间隔，4 小时）+ 10 分钟粗粒度层；
 * - gpu：GPU 快照（每 10 分钟最多一条，或变化较大时）。
 */

import type { AppServices } from '../platform/context';
import type { GPUInfo, GPUHistoryRecord, LoadMetricWindowStats, LoadNotificationMetric, MonitorRecord, PingHistoryRecord } from '../db/types';
import type { CoarseAccumulator, GpuSeries, NodeDoc, PingSeries, Series } from './types';

export const RECORD_FIELDS = [
  'cpu', 'gpu', 'ram', 'ram_total', 'swap', 'swap_total', 'load', 'temp',
  'disk', 'disk_total', 'net_in', 'net_out', 'net_total_up', 'net_total_down',
  'process_count', 'connections', 'connections_udp', 'uptime',
] as const;
type RecordField = typeof RECORD_FIELDS[number];
const LAST_VALUE_FIELDS = new Set<RecordField>(['ram_total', 'swap_total', 'disk_total', 'net_total_up', 'net_total_down', 'uptime']);
const NULLABLE_FIELDS = new Set<RecordField>(['load', 'temp']);
const DECIMAL_FIELDS = new Set<RecordField>(['cpu', 'gpu', 'load', 'temp']);

export const FINE_WINDOW_SEC = 4 * 60 * 60;
export const FINE_MAX_POINTS = 1_200;
export const COARSE_STEP_SEC = 600;
export const MAX_RETENTION_HOURS = 72;
const PING_LOSS_VALUE = -1;
const GPU_SNAPSHOT_INTERVAL_SEC = 600;

export function nodeKey(uuid: string): string {
  return `node_${uuid}`;
}

function emptySeries(): Series {
  return { t: [], v: RECORD_FIELDS.map(() => []) };
}

export function emptyNodeDoc(uuid: string): NodeDoc {
  return {
    uuid,
    last_time: 0,
    fine: emptySeries(),
    coarse: emptySeries(),
    acc: null,
    ping: {},
    ping_coarse: {},
    ping_last: {},
    gpu: { t: [], d: [] },
    load_alerts: {},
  };
}

function normalizeSeries(series: Series | undefined): Series {
  if (!series || !Array.isArray(series.t) || !Array.isArray(series.v)) return emptySeries();
  const v = RECORD_FIELDS.map((_, index) => Array.isArray(series.v[index]) ? series.v[index] : []);
  return { t: series.t, v };
}

export function normalizeNodeDoc(uuid: string, doc: NodeDoc | null): NodeDoc {
  if (!doc || typeof doc !== 'object') return emptyNodeDoc(uuid);
  return {
    ...emptyNodeDoc(uuid),
    ...doc,
    uuid,
    fine: normalizeSeries(doc.fine),
    coarse: normalizeSeries(doc.coarse),
    ping: doc.ping && typeof doc.ping === 'object' ? doc.ping : {},
    ping_coarse: doc.ping_coarse && typeof doc.ping_coarse === 'object' ? doc.ping_coarse : {},
    ping_last: doc.ping_last && typeof doc.ping_last === 'object' ? doc.ping_last : {},
    gpu: doc.gpu && Array.isArray(doc.gpu.t) && Array.isArray(doc.gpu.d) ? doc.gpu : { t: [], d: [] },
    load_alerts: doc.load_alerts && typeof doc.load_alerts === 'object' ? doc.load_alerts : {},
  };
}

export async function readNodeDoc(app: AppServices, uuid: string, maxAgeMs = 5_000): Promise<NodeDoc> {
  return normalizeNodeDoc(uuid, await app.kv.getJson<NodeDoc>(nodeKey(uuid), { maxAgeMs }));
}

export async function readNodeDocFresh(app: AppServices, uuid: string): Promise<NodeDoc> {
  return normalizeNodeDoc(uuid, await app.kv.getFreshJson<NodeDoc>(nodeKey(uuid)));
}

export async function writeNodeDoc(app: AppServices, doc: NodeDoc): Promise<void> {
  await app.kv.putJson(nodeKey(doc.uuid), doc);
}

function roundValue(field: RecordField, value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return NULLABLE_FIELDS.has(field) ? null : 0;
  if (DECIMAL_FIELDS.has(field)) return Math.round(value * 100) / 100;
  return Math.round(value);
}

function recordValues(record: MonitorRecord): Array<number | null> {
  return RECORD_FIELDS.map((field) => roundValue(field, record[field] as number | null));
}

function pushSeries(series: Series, timeSec: number, values: Array<number | null>): void {
  series.t.push(timeSec);
  values.forEach((value, index) => series.v[index].push(value));
}

function trimSeries(series: Series, minTimeSec: number, maxPoints: number): void {
  let drop = 0;
  while (drop < series.t.length && series.t[drop] < minTimeSec) drop += 1;
  drop = Math.max(drop, series.t.length - maxPoints);
  if (drop <= 0) return;
  series.t.splice(0, drop);
  series.v.forEach(column => column.splice(0, drop));
}

function newAccumulator(start: number): CoarseAccumulator {
  return {
    start,
    n: 0,
    sums: RECORD_FIELDS.map(() => 0),
    counts: RECORD_FIELDS.map(() => 0),
    last: RECORD_FIELDS.map(() => null),
  };
}

function finalizeAccumulator(acc: CoarseAccumulator): Array<number | null> {
  return RECORD_FIELDS.map((field, index) => {
    if (LAST_VALUE_FIELDS.has(field)) return acc.last[index];
    if (acc.counts[index] === 0) return NULLABLE_FIELDS.has(field) ? null : 0;
    return roundValue(field, acc.sums[index] / acc.counts[index]);
  });
}

function accumulate(acc: CoarseAccumulator, values: Array<number | null>): void {
  acc.n += 1;
  values.forEach((value, index) => {
    if (value === null) return;
    acc.sums[index] += value;
    acc.counts[index] += 1;
    acc.last[index] = value;
  });
}

export interface HistoryAppendOptions {
  nowMs: number;
  /** 记录持久化间隔（秒）。 */
  intervalSec: number;
  retentionHours: number;
}

/**
 * 追加监控采样。返回是否写入了新数据点。
 * 每个样本使用 Agent 的采样时间；与上一个精细点的间隔不足持久化间隔（留 5% 容差）时丢弃。
 */
export function appendRecords(doc: NodeDoc, samples: Array<{ timeMs: number; record: MonitorRecord }>, options: HistoryAppendOptions): boolean {
  const intervalSec = Math.max(3, options.intervalSec);
  const minGap = intervalSec - Math.min(intervalSec * 0.05, 5);
  let changed = false;
  const sorted = [...samples].sort((a, b) => a.timeMs - b.timeMs);
  for (const sample of sorted) {
    const timeSec = Math.floor(sample.timeMs / 1000);
    const lastFine = doc.fine.t.length ? doc.fine.t[doc.fine.t.length - 1] : 0;
    if (lastFine && timeSec - lastFine < minGap) continue;
    const values = recordValues(sample.record);
    pushSeries(doc.fine, timeSec, values);
    const bucket = Math.floor(timeSec / COARSE_STEP_SEC) * COARSE_STEP_SEC;
    if (doc.acc && doc.acc.start !== bucket) {
      if (doc.acc.n > 0) pushSeries(doc.coarse, doc.acc.start, finalizeAccumulator(doc.acc));
      doc.acc = null;
    }
    if (!doc.acc) doc.acc = newAccumulator(bucket);
    accumulate(doc.acc, values);
    doc.last_time = Math.max(doc.last_time, sample.timeMs);
    changed = true;
  }
  const nowSec = Math.floor(options.nowMs / 1000);
  trimSeries(doc.fine, nowSec - FINE_WINDOW_SEC, FINE_MAX_POINTS);
  const retentionSec = Math.min(MAX_RETENTION_HOURS, Math.max(1, options.retentionHours)) * 3600;
  trimSeries(doc.coarse, nowSec - retentionSec, Math.ceil(retentionSec / COARSE_STEP_SEC) + 2);
  return changed;
}

function toRecord(uuid: string, timeSec: number, values: Array<number | null>): MonitorRecord {
  const record: Record<string, unknown> = { client: uuid, time: new Date(timeSec * 1000).toISOString() };
  RECORD_FIELDS.forEach((field, index) => {
    const value = values[index];
    record[field] = value === undefined ? (NULLABLE_FIELDS.has(field) ? null : 0) : value;
  });
  return record as unknown as MonitorRecord;
}

function evenlyDownsample<T>(items: T[], limit: number): T[] {
  if (items.length <= limit || limit <= 0) return items;
  const result: T[] = [];
  const step = (items.length - 1) / (limit - 1 || 1);
  for (let i = 0; i < limit; i += 1) result.push(items[Math.round(i * step)]);
  return result;
}

/** 按时间范围读取监控历史（升序）。精细层覆盖不到的部分用粗粒度层补齐。 */
export function queryRecords(doc: NodeDoc, startMs: number, endMs: number, limit: number): MonitorRecord[] {
  const startSec = Math.floor(startMs / 1000);
  const endSec = Math.ceil(endMs / 1000);
  const fineStart = doc.fine.t.length ? doc.fine.t[0] : Number.POSITIVE_INFINITY;
  const points: Array<{ t: number; v: Array<number | null> }> = [];
  // 粗粒度桶必须整段早于精细层起点，避免与精细点重叠。
  doc.coarse.t.forEach((t, index) => {
    if (t >= startSec && t <= endSec && t + COARSE_STEP_SEC <= fineStart) points.push({ t, v: doc.coarse.v.map(column => column[index] ?? null) });
  });
  if (doc.acc && doc.acc.n > 0 && doc.acc.start >= startSec && doc.acc.start + COARSE_STEP_SEC <= fineStart && doc.acc.start <= endSec) {
    points.push({ t: doc.acc.start, v: finalizeAccumulator(doc.acc) });
  }
  doc.fine.t.forEach((t, index) => {
    if (t >= startSec && t <= endSec) points.push({ t, v: doc.fine.v.map(column => column[index] ?? null) });
  });
  points.sort((a, b) => a.t - b.t);
  return evenlyDownsample(points, limit).map(point => toRecord(doc.uuid, point.t, point.v));
}

export function recentRecords(doc: NodeDoc, limit: number): MonitorRecord[] {
  const total = doc.fine.t.length;
  const start = Math.max(0, total - limit);
  const result: MonitorRecord[] = [];
  for (let index = start; index < total; index += 1) {
    result.push(toRecord(doc.uuid, doc.fine.t[index], doc.fine.v.map(column => column[index] ?? null)));
  }
  return result;
}

function metricValue(metric: LoadNotificationMetric, values: Array<number | null>): number | null {
  const get = (field: RecordField) => values[RECORD_FIELDS.indexOf(field)];
  switch (metric) {
    case 'ram': {
      const total = Number(get('ram_total') || 0);
      return total > 0 ? (Number(get('ram') || 0) / total) * 100 : 0;
    }
    case 'disk': {
      const total = Number(get('disk_total') || 0);
      return total > 0 ? (Number(get('disk') || 0) / total) * 100 : 0;
    }
    case 'load':
      return get('load');
    case 'temp':
      return get('temp');
    case 'cpu':
    default:
      return Number(get('cpu') || 0);
  }
}

/** 与原 cfm_load_metric_window_stats 语义一致：不可用的负载/温度采样不计入。 */
export function loadMetricWindowStats(
  doc: NodeDoc,
  startMs: number,
  endMs: number,
  metric: LoadNotificationMetric,
  threshold: number,
): LoadMetricWindowStats {
  const startSec = startMs / 1000;
  const endSec = endMs / 1000;
  let samples = 0;
  let exceeded = 0;
  let sum = 0;
  doc.fine.t.forEach((t, index) => {
    if (t < startSec || t > endSec) return;
    const value = metricValue(metric, doc.fine.v.map(column => column[index] ?? null));
    if (value === null || !Number.isFinite(value)) return;
    samples += 1;
    sum += value;
    if (value >= threshold) exceeded += 1;
  });
  return { samples, exceeded, avg_value: samples > 0 ? sum / samples : 0 };
}

// ---------------------------------------------------------------------------
// Ping
// ---------------------------------------------------------------------------

function pushPing(series: Record<string, PingSeries>, taskId: string, timeSec: number, value: number): void {
  const current = series[taskId] || { t: [], v: [] };
  current.t.push(timeSec);
  current.v.push(value);
  series[taskId] = current;
}

function trimPing(series: Record<string, PingSeries>, minTimeSec: number, maxPoints: number, validTaskIds: Set<string> | null): void {
  for (const [taskId, current] of Object.entries(series)) {
    if (validTaskIds && !validTaskIds.has(taskId)) {
      delete series[taskId];
      continue;
    }
    let drop = 0;
    while (drop < current.t.length && current.t[drop] < minTimeSec) drop += 1;
    drop = Math.max(drop, current.t.length - maxPoints);
    if (drop > 0) {
      current.t.splice(0, drop);
      current.v.splice(0, drop);
    }
    if (current.t.length === 0) delete series[taskId];
  }
}

function roundLatency(value: number): number {
  if (!Number.isFinite(value) || value < 0) return PING_LOSS_VALUE;
  return Math.round(value * 10) / 10;
}

export interface PingAppendOptions {
  nowMs: number;
  intervalSec: number;
  retentionHours: number;
  validTaskIds: Set<string> | null;
}

/**
 * 追加 Ping 结果。每个任务按 Ping 持久化间隔节流；粗粒度层记录 10 分钟桶内的平均延迟
 * （全部丢包时记 -1）。
 */
export function appendPingResults(
  doc: NodeDoc,
  results: Array<{ timeMs: number; taskId: number; value: number }>,
  options: PingAppendOptions,
): boolean {
  const intervalSec = Math.max(30, options.intervalSec);
  const minGap = intervalSec - Math.min(intervalSec * 0.05, 5);
  let changed = false;
  const sorted = [...results].sort((a, b) => a.timeMs - b.timeMs);
  for (const result of sorted) {
    const taskId = String(result.taskId);
    if (options.validTaskIds && !options.validTaskIds.has(taskId)) continue;
    const timeSec = Math.floor(result.timeMs / 1000);
    const last = doc.ping_last[taskId] || 0;
    if (last && timeSec - last < minGap) continue;
    const value = roundLatency(result.value);
    pushPing(doc.ping, taskId, timeSec, value);
    doc.ping_last[taskId] = timeSec;
    // 粗粒度层：同一个 10 分钟桶内用增量平均更新最后一个点。
    const bucket = Math.floor(timeSec / COARSE_STEP_SEC) * COARSE_STEP_SEC;
    const coarse = doc.ping_coarse[taskId] || { t: [], v: [] };
    const lastIndex = coarse.t.length - 1;
    if (lastIndex >= 0 && coarse.t[lastIndex] === bucket) {
      const previous = coarse.v[lastIndex];
      if (previous < 0) coarse.v[lastIndex] = value;
      else if (value >= 0) coarse.v[lastIndex] = Math.round(((previous + value) / 2) * 10) / 10;
    } else {
      coarse.t.push(bucket);
      coarse.v.push(value);
    }
    doc.ping_coarse[taskId] = coarse;
    changed = true;
  }
  const nowSec = Math.floor(options.nowMs / 1000);
  trimPing(doc.ping, nowSec - FINE_WINDOW_SEC, Math.ceil(FINE_WINDOW_SEC / intervalSec) + 10, options.validTaskIds);
  const retentionSec = Math.min(MAX_RETENTION_HOURS, Math.max(1, options.retentionHours)) * 3600;
  trimPing(doc.ping_coarse, nowSec - retentionSec, Math.ceil(retentionSec / COARSE_STEP_SEC) + 2, options.validTaskIds);
  for (const taskId of Object.keys(doc.ping_last)) {
    if (options.validTaskIds && !options.validTaskIds.has(taskId)) delete doc.ping_last[taskId];
  }
  return changed;
}

/** 读取某任务的 Ping 历史（升序）。cursor 之前（不含）的最近 limit 个点。 */
export function queryPing(doc: NodeDoc, taskId: number, options: { limit: number; startMs?: number; cursorMs?: number }): PingHistoryRecord[] {
  const key = String(taskId);
  const fine = doc.ping[key] || { t: [], v: [] };
  const coarse = doc.ping_coarse[key] || { t: [], v: [] };
  const endSec = options.cursorMs ? Math.floor(options.cursorMs / 1000) : Number.POSITIVE_INFINITY;
  const startSec = options.startMs ? Math.floor(options.startMs / 1000) : 0;
  const fineStart = fine.t.length ? fine.t[0] : Number.POSITIVE_INFINITY;
  const points: Array<{ t: number; v: number }> = [];
  coarse.t.forEach((t, index) => {
    if (t + COARSE_STEP_SEC <= fineStart && t >= startSec && t <= endSec) points.push({ t, v: coarse.v[index] });
  });
  fine.t.forEach((t, index) => {
    if (t >= startSec && t <= endSec) points.push({ t, v: fine.v[index] });
  });
  points.sort((a, b) => a.t - b.t);
  const limited = points.length > options.limit ? evenlyDownsample(points, options.limit) : points;
  return limited.map(point => ({
    client: doc.uuid,
    task_id: taskId,
    time: new Date(point.t * 1000).toISOString(),
    value: point.v,
  }));
}

// ---------------------------------------------------------------------------
// GPU
// ---------------------------------------------------------------------------

function gpuSignature(gpus: GPUInfo[]): string {
  return gpus.map(gpu => [
    gpu.device_index,
    Math.round(gpu.utilization / 5),
    Math.round(gpu.temperature / 2),
    gpu.mem_total > 0 ? Math.round((gpu.mem_used / gpu.mem_total) * 100) : 0,
  ].join(':')).join('|');
}

export function appendGpuSnapshot(doc: NodeDoc, timeMs: number, gpus: GPUInfo[], retentionHours: number): boolean {
  if (!Array.isArray(gpus) || gpus.length === 0) return false;
  const timeSec = Math.floor(timeMs / 1000);
  const series: GpuSeries = doc.gpu;
  const lastIndex = series.t.length - 1;
  if (lastIndex >= 0) {
    const lastTime = series.t[lastIndex];
    const lastGpus = series.d[lastIndex].map(([device_index, device_name, mem_total, mem_used, utilization, temperature]) => ({
      device_index, device_name, mem_total, mem_used, utilization, temperature,
    }));
    if (timeSec - lastTime < GPU_SNAPSHOT_INTERVAL_SEC && gpuSignature(lastGpus) === gpuSignature(gpus)) return false;
    if (timeSec - lastTime < 60) return false;
  }
  series.t.push(timeSec);
  series.d.push(gpus.slice(0, 16).map(gpu => [
    gpu.device_index,
    String(gpu.device_name || '').slice(0, 128),
    Math.round(gpu.mem_total),
    Math.round(gpu.mem_used),
    Math.round(gpu.utilization * 10) / 10,
    Math.round(gpu.temperature),
  ]));
  const retentionSec = Math.min(MAX_RETENTION_HOURS, Math.max(1, retentionHours)) * 3600;
  let drop = 0;
  while (drop < series.t.length && series.t[drop] < timeSec - retentionSec) drop += 1;
  drop = Math.max(drop, series.t.length - 2000);
  if (drop > 0) {
    series.t.splice(0, drop);
    series.d.splice(0, drop);
  }
  return true;
}

export function queryGpu(doc: NodeDoc, startMs: number | null, endMs: number | null, limit: number): GPUHistoryRecord[] {
  const startSec = startMs ? startMs / 1000 : 0;
  const endSec = endMs ? endMs / 1000 : Number.POSITIVE_INFINITY;
  const rows: GPUHistoryRecord[] = [];
  doc.gpu.t.forEach((t, index) => {
    if (t < startSec || t > endSec) return;
    for (const [device_index, device_name, mem_total, mem_used, utilization, temperature] of doc.gpu.d[index]) {
      rows.push({
        client: doc.uuid,
        time: new Date(t * 1000).toISOString(),
        device_index,
        device_name,
        mem_total,
        mem_used,
        utilization,
        temperature,
      });
    }
  });
  return rows.length > limit ? rows.slice(rows.length - limit) : rows;
}
