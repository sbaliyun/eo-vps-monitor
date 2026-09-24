// 本地开发/测试入口：在 ESA 入口之外额外导出内存 KV 驱动注入能力。
export { handleRequest } from './esa-entry';
export { setDefaultKvDriver } from './platform/context';
export { MemoryKvDriver, resetKvModuleCacheForTests } from './platform/kv';
export { resetMaintenanceThrottleForTests } from './services/maintenance';
export { resetLocalRateLimitsForTests } from './store/ratelimit';
export { generateTotpCode } from './auth/totp';
