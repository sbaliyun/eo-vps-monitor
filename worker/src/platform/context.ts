/**
 * 单次请求的运行时服务：环境变量、KV 会话、出站子请求预算、后台任务。
 */

import { readEnvInt, readEnvString, type AppEnv, type ExecutionContextLike } from './env.ts';
import { EdgeKvDriver, KvSession, type KvDriver } from './kv.ts';

export class SubrequestBudgetExceeded extends Error {
  constructor() {
    super('本次请求的出站子请求额度已用完，剩余工作将在下次触发时继续');
    this.name = 'SubrequestBudgetExceeded';
  }
}

/**
 * ESA 函数默认每个请求最多 4 个 fetch 子请求（可在控制台申请提高）。
 * 通知、网站检测、更新检查都通过这里计数，超出时抛出 SubrequestBudgetExceeded。
 */
export class SubrequestBudget {
  private used = 0;
  readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  get usedCount(): number {
    return this.used;
  }

  remaining(): number {
    return Math.max(0, this.limit - this.used);
  }

  canSpend(count = 1): boolean {
    return this.used + count <= this.limit;
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!this.canSpend(1)) throw new SubrequestBudgetExceeded();
    this.used += 1;
    return fetch(input, init);
  };
}

export interface AppServices {
  env: AppEnv;
  kv: KvSession;
  subrequests: SubrequestBudget;
  now(): number;
  waitUntil(promise: Promise<unknown>): void;
  /** 未提供 waitUntil 时收集的后台任务，由入口在返回前等待。 */
  pending: Promise<unknown>[];
}

let defaultDriverOverride: KvDriver | null = null;
const edgeDrivers = new Map<string, EdgeKvDriver>();

/** 本地开发服务器与测试注入内存 KV。 */
export function setDefaultKvDriver(driver: KvDriver | null): void {
  defaultDriverOverride = driver;
}

export function resolveKvNamespace(env: AppEnv): string {
  return readEnvString(env, 'KV_NAMESPACE') || 'esa-vps-monitor';
}

function resolveDriver(env: AppEnv): KvDriver {
  if (defaultDriverOverride) return defaultDriverOverride;
  const namespace = resolveKvNamespace(env);
  let driver = edgeDrivers.get(namespace);
  if (!driver) {
    driver = new EdgeKvDriver(namespace);
    edgeDrivers.set(namespace, driver);
  }
  return driver;
}

export function createAppServices(env: AppEnv, ctx: ExecutionContextLike | undefined, options: { now?: () => number } = {}): AppServices {
  const now = options.now ?? Date.now;
  const pending: Promise<unknown>[] = [];
  const kv = new KvSession(resolveDriver(env), readEnvInt(env, 'KV_OPS_PER_REQUEST', 8, 2, 1000), now);
  const subrequests = new SubrequestBudget(readEnvInt(env, 'SUBREQUESTS_PER_REQUEST', 4, 1, 1000));
  return {
    env,
    kv,
    subrequests,
    now,
    pending,
    waitUntil(promise: Promise<unknown>) {
      const guarded = promise.catch((error) => {
        console.warn('[background] task failed:', error instanceof Error ? error.message : String(error));
      });
      if (ctx && typeof ctx.waitUntil === 'function') {
        try {
          ctx.waitUntil(guarded);
          return;
        } catch {
          // 某些运行时的 context 对象不可调用 waitUntil，退回到请求内等待。
        }
      }
      pending.push(guarded);
    },
  };
}
