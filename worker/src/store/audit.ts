/**
 * 审计日志：`audit` 文档保存最近的日志（新在前），按保留时长与条数上限裁剪。
 * 写入是尽力而为：KV 额度不足或并发覆盖时丢失个别日志不影响业务。
 */

import type { AppServices } from '../platform/context';
import type { AuditLogEntry, AuditLogsPage } from '../db/types';
import type { AuditDoc } from './types';

export const AUDIT_KEY = 'audit';
const MAX_ENTRIES = 400;
const MAX_DETAIL_CHARS = 2_000;

function normalize(doc: AuditDoc | null): AuditDoc {
  return doc && Array.isArray(doc.entries) ? { seq: Number(doc.seq) || 0, entries: doc.entries, _rev: doc._rev } : { seq: 0, entries: [] };
}

export interface AuditInput {
  user: string;
  action: string;
  detail: string;
  level?: string;
}

export async function appendAuditLogs(app: AppServices, inputs: AuditInput[], retentionHours = 2160): Promise<boolean> {
  if (inputs.length === 0 || !app.kv.canSpend(2)) return false;
  try {
    const doc = normalize(await app.kv.getFreshJson<AuditDoc>(AUDIT_KEY));
    const now = app.now();
    for (const input of inputs) {
      doc.seq += 1;
      doc.entries.unshift({
        id: doc.seq,
        time: new Date(now).toISOString(),
        user: String(input.user || 'system').slice(0, 128),
        action: String(input.action || '').slice(0, 64),
        detail: String(input.detail || '').slice(0, MAX_DETAIL_CHARS),
        level: input.level || 'info',
      });
    }
    const cutoff = now - Math.max(24, retentionHours) * 3600_000;
    doc.entries = doc.entries.filter(entry => Date.parse(entry.time) >= cutoff).slice(0, MAX_ENTRIES);
    await app.kv.putJson(AUDIT_KEY, doc);
    return true;
  } catch (error) {
    console.warn('[audit] write failed:', error instanceof Error ? error.message : String(error));
    return false;
  }
}

export function appendAuditLog(app: AppServices, user: string, action: string, detail: string, level = 'info'): Promise<boolean> {
  return appendAuditLogs(app, [{ user, action, detail, level }]);
}

export async function listAuditLogs(app: AppServices, page: number, limit: number): Promise<AuditLogsPage> {
  const doc = normalize(await app.kv.getJson<AuditDoc>(AUDIT_KEY, { maxAgeMs: 2_000 }));
  const offset = (page - 1) * limit;
  const logs: AuditLogEntry[] = doc.entries.slice(offset, offset + limit);
  return { logs, total: doc.entries.length, has_more: offset + limit < doc.entries.length };
}

export async function pruneAuditLogs(app: AppServices, retentionHours: number): Promise<number> {
  const doc = normalize(await app.kv.getFreshJson<AuditDoc>(AUDIT_KEY));
  const cutoff = app.now() - Math.max(24, retentionHours) * 3600_000;
  const before = doc.entries.length;
  doc.entries = doc.entries.filter(entry => Date.parse(entry.time) >= cutoff).slice(0, MAX_ENTRIES);
  const removed = before - doc.entries.length;
  if (removed > 0) await app.kv.putJson(AUDIT_KEY, doc);
  return removed;
}
