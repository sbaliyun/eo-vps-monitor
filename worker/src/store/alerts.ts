/**
 * 离线/到期告警的运行状态（连续离线轮数、最近通知时间）。只有定时维护写入。
 */

import type { AppServices } from '../platform/context';
import type { AlertsDoc } from './types';

export const ALERTS_KEY = 'alerts';

function normalize(doc: AlertsDoc | null): AlertsDoc {
  return {
    ...(doc || {}),
    offline: doc?.offline && typeof doc.offline === 'object' ? doc.offline : {},
    expiry: doc?.expiry && typeof doc.expiry === 'object' ? doc.expiry : {},
  };
}

export async function readAlerts(app: AppServices, maxAgeMs = 5_000): Promise<AlertsDoc> {
  return normalize(await app.kv.getJson<AlertsDoc>(ALERTS_KEY, { maxAgeMs }));
}

export async function mutateAlerts<T>(app: AppServices, mutate: (doc: AlertsDoc) => T | Promise<T>): Promise<T> {
  const doc = normalize(await app.kv.getFreshJson<AlertsDoc>(ALERTS_KEY));
  const result = await mutate(doc);
  await app.kv.putJson(ALERTS_KEY, doc);
  return result;
}
