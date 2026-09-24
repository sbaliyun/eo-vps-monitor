import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeSsl } from './sslExpiry.ts';

const now = Date.parse('2026-09-24T00:00:00Z');
const inDays = (days) => new Date(now + days * 86_400_000 + 3_600_000).toISOString();

test('summarizeSsl colors by remaining days', () => {
  assert.equal(summarizeSsl({}, 14, now), null);
  assert.deepEqual(
    [60, 10, 2].map(days => summarizeSsl({ ssl_expires_at: inDays(days) }, 14, now).tone),
    ['green', 'amber', 'red'],
  );
  assert.equal(summarizeSsl({ ssl_expires_at: inDays(60) }, 14, now).label, '证书 60 天');
});

test('summarizeSsl reports expired and failing certificates', () => {
  const expired = summarizeSsl({ ssl_expires_at: inDays(-3), ssl_error: 'cert_expired' }, 14, now);
  assert.equal(expired.label, '证书已过期');
  assert.equal(expired.tone, 'red');
  const mismatch = summarizeSsl({ ssl_error: 'cert_hostname_mismatch' }, 14, now);
  assert.equal(mismatch.label, '证书域名不匹配');
  assert.equal(mismatch.daysLeft, null);
});
