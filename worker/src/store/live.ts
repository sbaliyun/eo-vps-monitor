/**
 * 实时状态：替代原 Durable Object 的在线状态与观看者跟踪。
 *
 * 每个节点的最新状态存两份：
 * - `lv_<uuid>`：仅该节点的上报写入，减少不同节点之间的覆盖；
 * - `live_<n>` 分片：所有节点读-改-写的汇总，一次读取就能拿到全部节点，作为兜底。
 *
 * EdgeKV 在各边缘节点之间最终一致，不同地区的节点同时读-改-写同一分片时，后写者会用
 * 旧副本覆盖别人的条目（表现为在线机器显示离线）。所以读取时先取分片，再读取
 * 各节点自己的键，按上报时间取较新的一份。EO 完整快照会检查全部节点，不能把
 * 尚未检查的节点当作离线；旧 ESA 路径保留按预算校正的行为。
 * 单节点请求跨边缘副本仍可能用旧值覆盖自身状态，读取也可能暂时看不到新值。
 */

import type { AppServices } from '../platform/context';
import { readEnvInt, readEnvString } from '../platform/env';
import { toPublicReport } from '../utils/public-report';
import type { CoreDoc, LiveEntry, LiveShardDoc, ViewersDoc } from './types';
import { metaVersionOf, sortedClients } from './core';

export const VIEWERS_KEY = 'viewers';
export const LIVE_READ_CACHE_MS = 2_000;
export const MAX_LIVE_SHARDS = 4;
/** 读取实时状态时给后续逻辑预留的 KV 操作数。 */
const LIVE_READ_RESERVED_OPS = 2;
const LIVE_READ_CONCURRENCY = 8;

export function liveShardCount(app: AppServices): number {
  return readEnvInt(app.env, 'LIVE_SHARDS', 1, 1, MAX_LIVE_SHARDS);
}

export function liveShardKey(index: number): string {
  return `live_${index}`;
}

export function nodeLiveKey(uuid: string): string {
  return `lv_${uuid}`;
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

function isLiveEntry(value: unknown): value is LiveEntry {
  return Boolean(value) && typeof value === 'object' && Number.isFinite((value as LiveEntry).t);
}

function parseEntry(raw: string | null | undefined): LiveEntry | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isLiveEntry(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function keepNewer(entries: Map<string, LiveEntry>, uuid: string, entry: LiveEntry | undefined): void {
  if (!entry) return;
  const existing = entries.get(uuid);
  if (!existing || existing.t < entry.t) entries.set(uuid, entry);
}

export interface LiveReadResult {
  entries: Map<string, LiveEntry>;
  /** 本次（或 maxAgeMs 内）读过节点自己键的节点；该边缘副本仍可能过期。 */
  verified: Set<string>;
}

/**
 * 读取实时状态。传入 core 时用各节点自己的键校正分片里可能被覆盖的条目；
 * 不传 core 只读分片（用于只需要大致信息的场景，例如地区）。
 */
export async function readLiveState(
  app: AppServices,
  core: CoreDoc | null,
  maxAgeMs = LIVE_READ_CACHE_MS,
  completeSnapshot = false,
): Promise<LiveReadResult> {
  const edgeOne = app.env.EDGEONE === true || readEnvString(app.env, 'EDGEONE') === 'true';
  const complete = edgeOne && completeSnapshot && core !== null;
  const count = liveShardCount(app);
  const shards = await Promise.all(
    Array.from({ length: count }, (_, index) => {
      if (complete) app.kv.reserveCriticalReadCapacity(1, 0);
      return app.kv.getJson<LiveShardDoc>(liveShardKey(index), { maxAgeMs });
    }),
  );
  const entries = new Map<string, LiveEntry>();
  for (const shard of shards) {
    for (const [uuid, entry] of Object.entries(normalizeShard(shard).entries)) {
      if (isLiveEntry(entry)) keepNewer(entries, uuid, entry);
    }
  }
  const verified = new Set<string>();
  if (!core) return { entries, verified };

  const now = app.now();
  const candidates: Array<{ uuid: string; priority: number; at: number }> = [];
  for (const client of core.clients) {
    const cached = app.kv.cached(nodeLiveKey(client.uuid));
    if (cached) keepNewer(entries, client.uuid, parseEntry(cached.value));
    if (cached && now - cached.at <= maxAgeMs) {
      verified.add(client.uuid);
      continue;
    }
    const entry = entries.get(client.uuid);
    // 优先刷新看起来离线或从没见过的节点，尽力缩短状态延迟。
    const priority = !entry || entry.exp <= now ? 0 : 1;
    candidates.push({ uuid: client.uuid, priority, at: cached?.at ?? 0 });
  }
  candidates.sort((a, b) => a.priority - b.priority || a.at - b.at);
  if (complete) {
    // The legacy budget is an application preference, not a reason to return
    // an incomplete EO snapshot. Keep two operations for the viewer heartbeat;
    // optional maintenance receives no additional spare capacity.
    app.kv.reserveCriticalReadCapacity(candidates.length, LIVE_READ_RESERVED_OPS);
  }
  const budget = Math.max(0, app.kv.remaining() - LIVE_READ_RESERVED_OPS);
  const picked = candidates.slice(0, budget);
  for (let offset = 0; offset < picked.length; offset += LIVE_READ_CONCURRENCY) {
    const batch = picked.slice(offset, offset + LIVE_READ_CONCURRENCY);
    const fresh = await Promise.all(batch.map(({ uuid }) => app.kv.get(nodeLiveKey(uuid))));
    batch.forEach(({ uuid }, index) => {
      keepNewer(entries, uuid, parseEntry(fresh[index]));
      verified.add(uuid);
    });
  }
  return { entries, verified };
}

export async function readLiveEntries(
  app: AppServices,
  core: CoreDoc | null,
  maxAgeMs = LIVE_READ_CACHE_MS,
): Promise<Map<string, LiveEntry>> {
  return (await readLiveState(app, core, maxAgeMs, true)).entries;
}

/**
 * 更新单个节点的实时条目：先写节点自己的键，再在预算允许时更新汇总分片。
 * 两次写入没有事务或 CAS 保证，跨边缘请求可能读到旧副本。
 */
export async function writeLiveEntry(
  app: AppServices,
  uuid: string,
  build: (previous: LiveEntry | undefined) => LiveEntry,
): Promise<LiveEntry> {
  const ownKey = nodeLiveKey(uuid);
  const cachedOwn = parseEntry(app.kv.cached(ownKey)?.value);
  const edgeOne = app.env.EDGEONE === true || readEnvString(app.env, 'EDGEONE') === 'true';
  const own = edgeOne ? parseEntry(await app.kv.get(ownKey)) : undefined;
  const key = liveShardKey(liveShardOf(uuid, liveShardCount(app)));
  const shard = normalizeShard(await app.kv.getFreshJson<LiveShardDoc>(key));
  let previous = shard.entries[uuid];
  for (const candidate of [own, cachedOwn]) {
    if (candidate && (!previous || previous.t < candidate.t)) previous = candidate;
  }
  const next = build(previous);
  await app.kv.put(ownKey, JSON.stringify(next));
  if (app.kv.canSpend(1)) {
    shard.entries[uuid] = next;
    await app.kv.putJson(key, shard);
  }
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
  const orphans = new Set<string>(removeUuids);
  for (let index = 0; index < count; index += 1) {
    if (!app.kv.canSpend(2)) break;
    const key = liveShardKey(index);
    const shard = normalizeShard(await app.kv.getFreshJson<LiveShardDoc>(key));
    let changed = false;
    for (const uuid of Object.keys(shard.entries)) {
      if (remove.has(uuid) || (validUuids && !validUuids.has(uuid))) {
        delete shard.entries[uuid];
        orphans.add(uuid);
        changed = true;
        removed += 1;
      }
    }
    if (changed) await app.kv.putJson(key, shard);
  }
  for (const uuid of orphans) {
    if (!app.kv.canSpend(1)) break;
    await app.kv.delete(nodeLiveKey(uuid));
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
    const region = entry.m?.region || client.seed?.region;
    if (region) projected.region = region;
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
