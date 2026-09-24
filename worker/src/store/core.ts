/**
 * `core` 文档：后台配置的唯一来源。只有管理操作（以及首次初始化）会写入。
 */

import type { AppServices } from '../platform/context';
import { buildAdminSettings, buildPublicSettings, type PublicSettings } from '../settings/schema';
import type { Client, User } from '../db/types';
import type { AgentMeta, CoreDoc, StoredClient } from './types';

export const CORE_KEY = 'core';
/** 读路径允许使用的模块缓存年龄；后台修改后本实例立即可见，其他实例最多延迟这么久再加 KV 同步时间。 */
export const CORE_CACHE_MS = 5_000;

export function emptyCore(): CoreDoc {
  return {
    schema: 1,
    meta_version: 1,
    settings: {},
    users: [],
    clients: [],
    ping_tasks: [],
    websites: [],
    offline_notifications: [],
    expiry_notifications: [],
    load_notifications: [],
    themes: [],
    seq: { ping_task: 0, website: 0, load_notification: 0 },
  };
}

function normalizeCore(doc: Partial<CoreDoc> | null): CoreDoc {
  const base = emptyCore();
  if (!doc || typeof doc !== 'object') return base;
  return {
    ...base,
    ...doc,
    schema: 1,
    meta_version: Number.isFinite(doc.meta_version) ? Number(doc.meta_version) : base.meta_version,
    settings: doc.settings && typeof doc.settings === 'object' ? doc.settings : {},
    users: Array.isArray(doc.users) ? doc.users : [],
    clients: Array.isArray(doc.clients) ? doc.clients : [],
    ping_tasks: Array.isArray(doc.ping_tasks) ? doc.ping_tasks : [],
    websites: Array.isArray(doc.websites) ? doc.websites : [],
    offline_notifications: Array.isArray(doc.offline_notifications) ? doc.offline_notifications : [],
    expiry_notifications: Array.isArray(doc.expiry_notifications) ? doc.expiry_notifications : [],
    load_notifications: Array.isArray(doc.load_notifications) ? doc.load_notifications : [],
    themes: Array.isArray(doc.themes) ? doc.themes : [],
    seq: { ...base.seq, ...(doc.seq || {}) },
  };
}

export async function readCore(app: AppServices, maxAgeMs = CORE_CACHE_MS): Promise<CoreDoc> {
  return normalizeCore(await app.kv.getJson<CoreDoc>(CORE_KEY, { maxAgeMs }));
}

export interface MutateCoreOptions {
  /** 是否递增公开元数据版本（节点、网站、公开设置、Ping 任务变化时需要）。 */
  bumpMeta?: boolean;
}

/** 读-改-写 core。回调抛错时不写入。 */
export async function mutateCore<T>(
  app: AppServices,
  mutate: (doc: CoreDoc) => T | Promise<T>,
  options: MutateCoreOptions = {},
): Promise<T> {
  const doc = normalizeCore(await app.kv.getFreshJson<CoreDoc>(CORE_KEY));
  const result = await mutate(doc);
  if (options.bumpMeta) doc.meta_version = Math.max(doc.meta_version + 1, Math.floor(app.now() / 1000));
  await app.kv.putJson(CORE_KEY, doc);
  return result;
}

export function adminSettingsOf(core: CoreDoc): Record<string, string> {
  return buildAdminSettings(core.settings);
}

export function publicSettingsOf(core: CoreDoc): PublicSettings {
  return buildPublicSettings(core.settings);
}

export function findUserByUsername(core: CoreDoc, username: string): User | null {
  return core.users.find(user => user.username === username) ?? null;
}

export function findUserByUuid(core: CoreDoc, uuid: string): User | null {
  return core.users.find(user => user.uuid === uuid) ?? null;
}

export function sortedClients(core: CoreDoc): StoredClient[] {
  return [...core.clients].sort((a, b) =>
    (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.name.localeCompare(b.name) || a.uuid.localeCompare(b.uuid));
}

export function findClient(core: CoreDoc, uuid: string): StoredClient | null {
  return core.clients.find(client => client.uuid === uuid) ?? null;
}

export function defaultStoredClient(uuid: string, token: string, tokenHash: string, name: string, nowIso: string, sortOrder: number): StoredClient {
  return {
    uuid,
    token,
    token_hash: tokenHash,
    token_rotated_at: null,
    name,
    remark: '',
    public_remark: '',
    price: 0,
    billing_cycle: 30,
    auto_renewal: false,
    currency: '$',
    expired_at: '',
    group: '',
    tags: '',
    hidden: false,
    traffic_limit: 0,
    traffic_limit_type: 'sum',
    traffic_reset_day: 1,
    sort_order: sortOrder,
    created_at: nowIso,
    updated_at: nowIso,
  };
}

/** 合并后台字段与 Agent 上报字段，得到完整的 Client 视图。 */
export function toClientView(stored: StoredClient, meta: AgentMeta | undefined): Client {
  const m = meta || {};
  return {
    uuid: stored.uuid,
    token: stored.token,
    token_hash: stored.token_hash,
    token_last_used_at: m.token_last_used_at ?? null,
    token_last_used_ip: m.token_last_used_ip ?? '',
    token_rotated_at: stored.token_rotated_at ?? null,
    name: stored.name,
    cpu_name: m.cpu_name ?? '',
    virtualization: m.virtualization ?? '',
    arch: m.arch ?? '',
    cpu_cores: m.cpu_cores ?? 0,
    os: m.os ?? '',
    kernel_version: m.kernel_version ?? '',
    gpu_name: m.gpu_name ?? '',
    ipv4: m.ipv4 ?? '',
    ipv6: m.ipv6 ?? '',
    region: m.region ?? '',
    remark: stored.remark ?? '',
    public_remark: stored.public_remark ?? '',
    mem_total: m.mem_total ?? 0,
    swap_total: m.swap_total ?? 0,
    disk_total: m.disk_total ?? 0,
    version: m.version ?? '',
    price: stored.price ?? 0,
    billing_cycle: stored.billing_cycle ?? 30,
    auto_renewal: Boolean(stored.auto_renewal),
    currency: stored.currency ?? '$',
    expired_at: stored.expired_at ?? '',
    group: stored.group ?? '',
    tags: stored.tags ?? '',
    hidden: Boolean(stored.hidden),
    traffic_limit: stored.traffic_limit ?? 0,
    traffic_limit_type: stored.traffic_limit_type || 'sum',
    traffic_reset_day: stored.traffic_reset_day || 1,
    sort_order: stored.sort_order ?? 0,
    created_at: stored.created_at,
    updated_at: stored.updated_at,
  };
}

export function metaVersionOf(core: CoreDoc): string {
  return String(core.meta_version);
}
