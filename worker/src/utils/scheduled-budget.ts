/**
 * 出站请求辅助。ESA 函数没有 Cloudflare 的 AsyncLocalStorage 预算上下文，
 * 预算由调用方显式传入受限的 fetcher（见 platform/context.ts 的 SubrequestBudget）。
 */

export { SubrequestBudgetExceeded as ScheduledBudgetExceeded } from '../platform/context.ts';

/** 保留旧接口：不再有隐式预算。 */
export function currentScheduledBudget(): { remainingMs(): number } | undefined {
  return undefined;
}

export function consumeScheduledSubrequests(_count = 1): void {
  // 预算由受限 fetcher 统一计数。
}

export async function scheduledFetch(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1] = {},
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  // 手动处理重定向：自动跟随会产生看不见的额外子请求。
  return fetcher(input, { ...init, redirect: 'manual' });
}

export function rotateScheduledItems<T>(items: readonly T[], seed: number): T[] {
  if (items.length === 0) return [];
  const start = Math.abs(Math.floor(seed)) % items.length;
  return [...items.slice(start), ...items.slice(0, start)];
}
