import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, sampleReport } from './helpers.mjs';
import { buildBackupFromExport } from '../../scripts/supabase-to-backup.mjs';
import { encryptBackup } from '../src/utils/backup.ts';
import { hashAgentToken } from '../src/utils/client.ts';

// Supabase row_to_json 的原样输出：smallint 布尔、timestamptz 字符串、带引号的 "group" 列。
function supabaseRow(overrides = {}) {
  return {
    uuid: 'b1d4c1f0-0000-4000-8000-000000000001',
    token: null,
    token_hash: null,
    token_last_used_at: '2026-09-20T01:02:03.456+00:00',
    token_last_used_ip: '198.51.100.7',
    token_rotated_at: null,
    name: 'tokyo-1',
    cpu_name: 'AMD EPYC',
    virtualization: 'kvm',
    arch: 'amd64',
    cpu_cores: 2,
    os: 'Debian 12',
    kernel_version: '6.1.0',
    gpu_name: '',
    ipv4: '203.0.113.10',
    ipv6: '',
    region: 'JP',
    remark: 'private note',
    public_remark: '',
    mem_total: 2147483648,
    swap_total: 0,
    disk_total: 42949672960,
    version: '2.0.3',
    price: 5.5,
    billing_cycle: 30,
    auto_renewal: 1,
    currency: '$',
    expired_at: '2026-12-31T00:00:00+00:00',
    group: 'asia',
    tags: 'jp',
    hidden: 0,
    traffic_limit: 1099511627776,
    traffic_limit_type: 'sum',
    traffic_reset_day: 5,
    sort_order: 1,
    created_at: '2026-01-01T00:00:00+00:00',
    updated_at: '2026-09-20T00:00:00+00:00',
    ...overrides,
  };
}

test('Supabase 导出 → 加密备份 → 新系统恢复，旧 Token 继续可用', async () => {
  const plainToken = 'plain-token-0123456789abcdef0123456789abcdef';
  const hashedOnlyToken = 'hashed-token-0123456789abcdef0123456789abcd';
  // SQL Editor 的结果导出是单行单列：[{ export: {...} }]
  const exported = [{
    export: {
      clients: [
        supabaseRow({ token: plainToken, token_hash: await hashAgentToken(plainToken) }),
        supabaseRow({
          uuid: 'b1d4c1f0-0000-4000-8000-000000000002',
          name: 'hk-1',
          token_hash: await hashAgentToken(hashedOnlyToken),
          hidden: 1,
          sort_order: 2,
        }),
      ],
      settings: {
        site_title: 'My Status',
        'health:cron_offline': '{"status":"ok"}',
        maintenance_last_cleanup_at: '2026-09-22T16:18:20.581Z',
        schema_bootstrap_version: 'postgres-2026-07-09',
        site_logo_url: '/api/site-logo?v=1',
        site_logo_data: 'iVBORw0KGgo=',
        site_logo_type: 'image/png',
      },
    },
  }];

  const result = buildBackupFromExport(exported);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.backup.clients.length, 2);
  assert.equal(result.backup.clients[1].hidden, true);
  assert.deepEqual(Object.keys(result.backup.settings), ['site_title'], '只迁移新系统认识的设置，内部状态与 Logo 不迁移');
  const encrypted = await encryptBackup(result.backup, 'import-pass');
  assert.equal(encrypted.ok, true);

  const h = await createHarness();
  try {
    await h.setupAdmin();
    const restored = await h.call('POST', '/api/admin/upload/backup?confirm_restore=true&acknowledge_overwrite=true', {
      body: { backup: encrypted.encryptedBackup, backup_password: 'import-pass', confirm_restore: true, acknowledge_overwrite: true },
    });
    assert.equal(restored.status, 200, restored.text);

    const clients = await h.call('GET', '/api/admin/clients');
    assert.deepEqual(clients.json.map((client) => client.name), ['tokyo-1', 'hk-1']);
    const tokyo = clients.json[0];
    assert.equal(tokyo.traffic_reset_day, 5);
    assert.equal(tokyo.group, 'asia');
    assert.equal(tokyo.billing_cycle, 30);

    for (const token of [plainToken, hashedOnlyToken]) {
      const report = await h.agent('POST', '/api/clients/report', token, sampleReport());
      assert.equal(report.status, 200, `旧 Token 应能直接上报：${report.text}`);
    }

    const settings = await h.call('GET', '/api/admin/settings?scope=site');
    assert.equal(settings.json.site_title, 'My Status');
  } finally {
    h.restore();
  }
});

test('也接受只含节点数组的导出，并报告缺失 uuid', () => {
  assert.equal(buildBackupFromExport([supabaseRow()]).ok, true);
  const bad = buildBackupFromExport({ clients: [supabaseRow({ uuid: null })] });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join('\n'), /uuid/);
});
