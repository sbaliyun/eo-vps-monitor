/**
 * 实时状态：替代原 Durable Object 的在线状态与观看者跟踪。
 *
 * 每个节点上报时读-改-写所在分片 `live_<n>`。多个节点同时写同一分片时，后写者可能用
 * 稍旧的副本覆盖他人条目，但每个节点下一次上报就会自我修复，条目最多落后约一个上报周期；
 * 在线截止时间留有 3 倍上报间隔的余量，不会因此误判离线。
 */

import type { AppServices } from '../platform/context';
import { readEnvInt } from '../platform/env';
import { toPublicReport } from '../utils/public-report';
import type { CoreDoc, LiveEntry, LiveShardDoc, ViewersDoc } from './types';
import { metaVersionOf, sortedClients } from './core';

export const VIEWERS_KEY = 'viewers';
export const LIVE_READ_CACHE_MS = 2_000;
export const MAX_LIVE_SHARDS = 4;

export function liveShardCount(app: AppServices): number {
  return readEnvInt(app.env, 'LIVE_SHARDS', 1, 1, MAX_LIVE_SHARDS);
}

export function liveShardKey(index: number): string {
  return `live_${index}`;
}

export function liveShardOf(uuid: string, count: number): number {
  if (count <= 1) return 0;
  let hash = 0x811c9dc5;
  for (let i = 0; i < uuid.length; i += 1) {
    hash ^= uuid.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % count;
}

function normalizeShard(doc: LiveShardDoc | null): LiveShardDoc {
  return doc && doc.entries && typeof doc.entries === 'object' ? doc : { entries: {} };
}

/** 读取全部分片并按上报时间取每个节点最新的条目。 */
export async function readLiveEntries(app: AppServices, maxAgeMs = LIVE_READ_CACHE_MS): Promise<Map<string, LiveEntry>> {
  const count = liveShardCount(app);
  const shards = await Promise.all(
    Array.from({ length: count }, (_, index) => app.kv.getJson<LiveShardDoc>(liveShardKey(index), { maxAgeMs })),
  );
  const entries = new Map<string, LiveEntry>();
  for (const shard of shards) {
    for (const [uuid, entry] of Object.entries(normalizeShard(shard).entries)) {
      if (!entry || typeof entry !== 'object' || !Number.isFinite(entry.t)) continue;
      const existing = entries.get(uuid);
      if (!existing || existing.t < entry.t) entries.set(uuid, entry);
    }
  }
  return entries;
}

/** 更新单个节点的实时条目（读-改-写所在分片）。 */
export async function writeLiveEntry(
  app: AppServices,
  uuid: string,
  build: (previous: LiveEntry | undefined) => LiveEntry,
): Promise<LiveEntry> {
  const key = liveShardKey(liveShardOf(uuid, liveShardCount(app)));
  const shard = normalizeShard(await app.kv.getFreshJson<LiveShardDoc>(key));
  const next = build(shard.entries[uuid]);
  shard.entries[uuid] = next;
  await app.kv.putJson(key, shard);
  return next;
}

/** 删除节点（或清理孤儿条目）。validUuids 为 null 时只删除 removeUuids。 */
export async function pruneLiveEntries(
  app: AppServices,
  removeUuids: string[],
  validUuids: Set<string> | null = null,
): Promise<number> {
  let removed = 0;
  const count = liveShardCount(app);
  const remove = new Set(removeUuids);
  for (let index = 0; index < count; index += 1) {
    if (!app.kv.canSpend(2)) break;
    const key = liveShardKey(index);
    const shard = normalizeShard(await app.kv.getFreshJson<LiveShardDoc>(key));
    let changed = false;
    for (const uuid of Object.keys(shard.entries)) {
      if (remove.has(uuid) || (validUuids && !validUuids.has(uuid))) {
        delete shard.entries[uuid];
        changed = true;
        removed += 1;
      }
    }
    if (changed) await app.kv.putJson(key, shard);
  }
  return removed;
}

export interface LiveSnapshot {
  online: string[];
  clients: Array<Record<string, unknown>>;
  data: Record<string, Record<string, unknown>>;
  last_known: Record<string, Record<string, unknown>>;
  count: number;
  timestamp: number;
  metadata_version: string;
}

export function buildLiveSnapshot(
  core: CoreDoc,
  entries: Map<string, LiveEntry>,
  includeHidden: boolean,
  now: number,
): LiveSnapshot {
  const online: string[] = [];
  const clients: Array<Record<string, unknown>> = [];
  const data: Record<string, Record<string, unknown>> = {};
  const lastKnown: Record<string, Record<string, unknown>> = {};

  for (const client of sortedClients(core)) {
    if (client.hidden && !includeHidden) continue;
    const entry = entries.get(client.uuid);
    if (!entry) continue;
    const report = includeHidden ? { ...entry.r } : toPublicReport(entry.r as never);
    delete (report as Record<string, unknown>).sort_order;
    const projected: Record<string, unknown> = {
      ...report,
      uuid: client.uuid,
      name: client.name,
      lastReportTime: entry.t,
      sort_order: client.sort_order ?? 0,
    };
    if (entry.m?.region) projected.region = entry.m.region;
    if (entry.exp > now) {
      online.push(client.uuid);
      clients.push(projected);
      data[client.uuid] = projected;
    } else {
      lastKnown[client.uuid] = projected;
    }
  }

  return {
    online,
    clients,
    data,
    last_known: lastKnown,
    count: online.length,
    timestamp: now,
    metadata_version: metaVersionOf(core),
  };
}

export function viewerTtlMs(settings: Record<string, string>): number {
  const seconds = Number(settings.live_poll_active_max_duration_sec || 120);
  return Math.min(3600, Math.max(60, Number.isFinite(seconds) ? seconds : 120)) * 1000;
}

export async function readViewersUntil(app: AppServices, maxAgeMs = 10_000): Promise<number> {
  const doc = await app.kv.getJson<ViewersDoc>(VIEWERS_KEY, { maxAgeMs });
  return doc && Number.isFinite(doc.until) ? doc.until : 0;
}

/**
 * 标记「有人在看实时面板」。只有剩余时间不足一半时才写 KV，
 * 同一实例每个观看窗口最多写一次。
 */
export async function markViewerActive(app: AppServices, ttlMs: number): Promise<boolean> {
  const now = app.now();
  const current = await readViewersUntil(app, ttlMs / 2);
  if (current - now > ttlMs / 2) return false;
  if (!app.kv.canSpend(1)) return false;
  await app.kv.putJson<ViewersDoc>(VIEWERS_KEY, { until: now + ttlMs });
  return true;
}
