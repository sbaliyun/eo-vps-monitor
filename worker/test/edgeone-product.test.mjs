import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, sampleReport } from './helpers.mjs';

test('EO 管理接口报告平台、用量依据与本地 KV 健康状态', async () => {
  const h = await createHarness();
  try {
    await h.setupAdmin();
    await h.addClient();
    const health = await h.call('GET', '/api/admin/health');
    assert.equal(health.status, 200);
    assert.equal(health.json.components.find(item => item.component === 'edge_kv').detail, '本地内存 KV');

    const capacity = await h.call('GET', '/api/admin/capacity');
    assert.equal(capacity.status, 200);
    assert.equal(capacity.json.platform, 'edgeone');
    assert.equal(capacity.json.clients, 1);
    assert.ok(capacity.json.estimated_function_requests_per_day > 0);
    assert.ok(capacity.json.estimated_storage_bytes > 0);
    assert.deepEqual(Object.keys(capacity.json.quota_reference.sources).sort(), [
      'edgeone_cli', 'edgeone_functions', 'edgeone_kv', 'edgeone_limits',
    ]);
    for (const reference of Object.values(capacity.json.quota_reference.sources)) {
      assert.ok(['pages.edgeone.ai', 'edgeone.cloud.tencent.com'].includes(new URL(reference).hostname));
    }
  } finally {
    h.restore();
  }
});

test('旧备份的 SMTP 通道在发送前拒绝，并保留 HTTP 通知指导', async () => {
  const h = await createHarness();
  try {
    await h.setupAdmin();
    h.outbound.length = 0;
    const smtp = await h.call('POST', '/api/admin/test/sendMessage', { body: { channel: 'email' } });
    assert.equal(smtp.status, 400);
    assert.equal(smtp.json.success, false);
    assert.match(smtp.json.error, /SMTP/);
    assert.match(smtp.json.error, /Webhook/);
    assert.equal(h.outbound.length, 0, '未启用的 SMTP 不应发起出站请求');
  } finally {
    h.restore();
  }
});

test('没有 SSL feature 的公共 CF Agent 仍能上报基础指标与读取 HTTP 策略', async () => {
  const h = await createHarness();
  try {
    await h.setupAdmin();
    const { uuid, token } = await h.addClient();
    const report = sampleReport();
    assert.equal(report.agent_features, undefined);
    const accepted = await h.agent('POST', '/api/clients/report', token, report);
    assert.equal(accepted.status, 200);
    assert.equal(accepted.json.success, true);
    const live = await h.call('GET', '/api/live/clients', { cookieJar: false });
    assert.equal(live.json.data[uuid].cpu, report.cpu);
    const policy = await h.agent('GET', '/api/clients/policy', token);
    assert.equal(policy.status, 200);
    assert.equal(policy.json.type, 'policy');
    assert.ok(policy.json.report_interval_sec >= 3);
  } finally {
    h.restore();
  }
});
