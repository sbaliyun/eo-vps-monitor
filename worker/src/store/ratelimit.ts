/**
 * 登录/二次验证失败限流（原 login_rate_limits 表）：15 分钟窗口内累计失败 ≥5 次后锁定，
 * 锁定时长 30 秒起按 2 的幂递增，最长 15 分钟。
 */

import type { AppServices } from '../platform/context';
import type { LoginRateLimit } from '../db/types';
import type { RateLimitDoc } from './types';

export const RATE_LIMIT_KEY = 'ratelimit';
const WINDOW_MS = 15 * 60 * 1000;
const STALE_MS = 24 * 60 * 60 * 1000;
const MAX_BUCKETS = 2_000;

function normalize(doc: RateLimitDoc | null): RateLimitDoc {
  return doc && doc.buckets && typeof doc.buckets === 'object' ? doc : { buckets: {} };
}

export async function loadRateLimits(app: AppServices, buckets: string[]): Promise<Map<string, LoginRateLimit | null>> {
  const doc = normalize(await app.kv.getJson<RateLimitDoc>(RATE_LIMIT_KEY, { maxAgeMs: 1_000 }));
  const result = new Map<string, LoginRateLimit | null>();
  for (const bucket of buckets) {
    const state = doc.buckets[bucket];
    result.set(bucket, state ? { bucket, ...state } : null);
  }
  return result;
}

export function retryAfterSeconds(states: Map<string, LoginRateLimit | null>, nowMs: number): number {
  let lockedUntil = 0;
  for (const state of states.values()) {
    const value = state?.locked_until ? Date.parse(state.locked_until) : 0;
    if (Number.isFinite(value)) lockedUntil = Math.max(lockedUntil, value);
  }
  return lockedUntil > nowMs ? Math.ceil((lockedUntil - nowMs) / 1000) : 0;
}

export async function recordFailures(app: AppServices, buckets: string[], nowMs: number): Promise<void> {
  if (!app.kv.canSpend(2)) return;
  const doc = normalize(await app.kv.getFreshJson<RateLimitDoc>(RATE_LIMIT_KEY));
  const failedAt = new Date(nowMs).toISOString();
  for (const bucket of [...new Set(buckets)].filter(Boolean).sort()) {
    const saved = doc.buckets[bucket];
    const firstMs = saved ? Date.parse(saved.first_failed_at) : 0;
    const withinWindow = saved && Number.isFinite(firstMs) && nowMs - firstMs <= WINDOW_MS;
    const failures = withinWindow ? Math.min(saved.failures, 2_147_483_646) + 1 : 1;
    const next = {
      failures,
      first_failed_at: withinWindow ? saved.first_failed_at : failedAt,
      last_failed_at: failedAt,
      locked_until: saved?.locked_until && Date.parse(saved.locked_until) > nowMs ? saved.locked_until : null,
      failure_revision: crypto.randomUUID(),
    };
    if (failures >= 5) {
      const lockSeconds = Math.min(900, 30 * 2 ** Math.min(failures - 5, 5));
      const lockUntil = new Date(nowMs + lockSeconds * 1000).toISOString();
      if (!next.locked_until || Date.parse(next.locked_until) < Date.parse(lockUntil)) next.locked_until = lockUntil;
    }
    doc.buckets[bucket] = next;
  }
  prune(doc, nowMs);
  await app.kv.putJson(RATE_LIMIT_KEY, doc);
}

export async function clearObserved(app: AppServices, observed: Map<string, LoginRateLimit | null>): Promise<void> {
  const states = [...observed.values()].filter((state): state is LoginRateLimit => Boolean(state));
  if (states.length === 0 || !app.kv.canSpend(2)) return;
  const doc = normalize(await app.kv.getFreshJson<RateLimitDoc>(RATE_LIMIT_KEY));
  let changed = false;
  for (const state of states) {
    const current = doc.buckets[state.bucket];
    if (current && current.failure_revision === state.failure_revision) {
      delete doc.buckets[state.bucket];
      changed = true;
    }
  }
  if (changed) await app.kv.putJson(RATE_LIMIT_KEY, doc);
}

function prune(doc: RateLimitDoc, nowMs: number): void {
  for (const [bucket, state] of Object.entries(doc.buckets)) {
    const last = Date.parse(state.last_failed_at);
    const locked = state.locked_until ? Date.parse(state.locked_until) : 0;
    if ((!Number.isFinite(last) || nowMs - last > STALE_MS) && !(locked > nowMs)) delete doc.buckets[bucket];
  }
  const entries = Object.entries(doc.buckets);
  if (entries.length > MAX_BUCKETS) {
    entries.sort((a, b) => Date.parse(a[1].last_failed_at) - Date.parse(b[1].last_failed_at));
    for (const [bucket] of entries.slice(0, entries.length - MAX_BUCKETS)) delete doc.buckets[bucket];
  }
}

/** 进程内的简单固定窗口限流，用于公开接口（ESA 另有 WAF/频次控制可在控制台配置）。 */
const localBuckets = new Map<string, { count: number; resetAt: number }>();
let sweepCounter = 0;

export function localRateLimit(key: string, max: number, windowMs: number, nowMs = Date.now()): { allowed: boolean; retryAfter: number; remaining: number } {
  sweepCounter += 1;
  if (sweepCounter % 256 === 0) {
    for (const [bucketKey, bucket] of localBuckets) if (bucket.resetAt <= nowMs) localBuckets.delete(bucketKey);
  }
  let bucket = localBuckets.get(key);
  if (!bucket || bucket.resetAt <= nowMs) {
    bucket = { count: 0, resetAt: nowMs + windowMs };
    localBuckets.set(key, bucket);
  }
  bucket.count += 1;
  return {
    allowed: bucket.count <= max,
    retryAfter: Math.max(1, Math.ceil((bucket.resetAt - nowMs) / 1000)),
    remaining: Math.max(0, max - bucket.count),
  };
}

export function resetLocalRateLimitsForTests(): void {
  localBuckets.clear();
}
