// Local adapters expose both the EdgeOne entry and legacy regression helpers.
export { onRequest, trustedEdgeOneRequest } from './edgeone-entry';
export { handleRequest } from './esa-entry';
export { setDefaultKvDriver } from './platform/context';
export { MemoryKvDriver, resetKvModuleCacheForTests } from './platform/kv';
export { resetMaintenanceThrottleForTests } from './services/maintenance';
export { resetLocalRateLimitsForTests } from './store/ratelimit';
export { generateTotpCode } from './auth/totp';
