import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, sampleReport } from './helpers.mjs';

const DAY = 86_400_000;

test('SSL 证书：分配给支持的节点、记录到期时间、到期前每天提醒、换证后停止', async () => {
  const h = await createHarness();
  try {
    await h.setupAdmin();
    await h.call('POST', '/api/admin/settings', { body: { notification_method: 'webhook', webhook_url: 'https://hooks.example.net/ssl', ssl_expiry_notify_days: '14' } });
    const old = await h.addClient('old-agent');
    const probe = await h.addClient('ssl-agent');
    const site = await h.call('POST', '/api/admin/websites/add', { body: { name: 'Shop', url: 'https://shop.example.org/', method: 'GET', interval_sec: 60 } });
    assert.equal(site.status, 200, site.text);
    const websites = await h.call('GET', '/api/admin/websites');
    const monitor = websites.json[0];

    // 旧版 Agent 不声明 ssl_cert：不分配证书任务。
    await h.agent('POST', '/api/clients/report', old.token, sampleReport());
    await h.agent('POST', '/api/clients/report', probe.token, sampleReport({ agent_features: ['ssl_cert'] }));
    h.worker.resetKvModuleCacheForTests();
    const oldPolicy = await h.agent('GET', '/api/clients/policy', old.token);
    assert.equal((oldPolicy.json.website_probe_tasks || []).length, 0);
    const policy = await h.agent('GET', '/api/clients/policy', probe.token);
    const task = policy.json.website_probe_tasks.find(item => item.id === monitor.id);
    assert.ok(task, '支持 ssl_cert 的节点收到证书检查任务');
    assert.equal(task.method, 'HEAD');
    assert.equal(task.interval_sec, 3600);

    const expiresSoon = new Date(Date.now() + 5 * DAY).toISOString();
    const report = await h.agent('POST', '/api/clients/report', probe.token, sampleReport({
      agent_features: ['ssl_cert'],
      website_probe_results: [{
        monitor_id: monitor.id, config_revision: monitor.config_revision, ok: true, effective_status: 'up',
        effective_reason: 'status_in_expected_range', status_code: 200, raw_status_code: 200, latency_ms: 80,
        error: null, cert_expires_at: expiresSoon, cert_issuer: "Let's Encrypt R11",
      }],
    }));
    assert.equal(report.status, 200, report.text);

    const after = await h.call('GET', '/api/admin/websites');
    assert.equal(after.json[0].ssl_expires_at, expiresSoon);
    assert.equal(after.json[0].ssl_issuer, "Let's Encrypt R11");
    const checks = await h.call('GET', `/api/websites/${monitor.id}/checks`, { cookieJar: false });
    const list = Array.isArray(checks.json) ? checks.json : checks.json.checks;
    assert.equal(list.filter(check => check.source_type === 'agent').length, 0, '证书检查节点的结果不计入可用性');
    const pub = await h.call('GET', '/api/websites', { cookieJar: false });
    assert.equal(pub.json[0].ssl_expires_at, expiresSoon);

    h.outbound.length = 0;
    for (let i = 0; i < 8; i += 1) await h.runMaintenance();
    const sslHooks = () => h.outbound.filter(item => item.url === 'https://hooks.example.net/ssl');
    assert.equal(sslHooks().length, 1, '到期前提醒一次（24 小时内不重复）');
    assert.match(String(sslHooks()[0].init.body), /SSL/);

    // 更换证书后不再提醒。
    await h.agent('POST', '/api/clients/report', probe.token, sampleReport({
      agent_features: ['ssl_cert'],
      website_probe_results: [{
        monitor_id: monitor.id, config_revision: monitor.config_revision, ok: true, effective_status: 'up',
        effective_reason: 'status_in_expected_range', status_code: 200, raw_status_code: 200, latency_ms: 80,
        error: null, cert_expires_at: new Date(Date.now() + 80 * DAY).toISOString(),
      }],
    }));
    h.outbound.length = 0;
    for (let i = 0; i < 8; i += 1) await h.runMaintenance();
    assert.equal(sslHooks().length, 0);

    // 证书已过期（Agent 校验失败）时也会提醒。
    await h.agent('POST', '/api/clients/report', probe.token, sampleReport({
      agent_features: ['ssl_cert'],
      website_probe_results: [{
        monitor_id: monitor.id, config_revision: monitor.config_revision, ok: false, effective_status: 'down',
        effective_reason: 'cert_expired', status_code: null, raw_status_code: null, latency_ms: 30,
        error: 'cert_expired', cert_expires_at: new Date(Date.now() - DAY).toISOString(),
      }],
    }));
    const expired = await h.call('GET', '/api/admin/websites');
    assert.equal(expired.json[0].ssl_error, 'cert_expired');
    h.outbound.length = 0;
    for (let i = 0; i < 8; i += 1) await h.runMaintenance();
    assert.equal(sslHooks().length, 1);
    assert.match(String(sslHooks()[0].init.body), /已过期/);

    // 固定节点 / 关闭。
    await h.call('POST', '/api/admin/settings', { body: { ssl_probe_client: old.uuid } });
    h.worker.resetKvModuleCacheForTests();
    const fixed = await h.agent('GET', '/api/clients/policy', old.token);
    assert.equal(fixed.json.website_probe_tasks.length, 1, '手动指定的节点收到任务');
    await h.call('POST', '/api/admin/settings', { body: { ssl_probe_client: 'off' } });
    h.worker.resetKvModuleCacheForTests();
    const off = await h.agent('GET', '/api/clients/policy', probe.token);
    assert.equal((off.json.website_probe_tasks || []).length, 0);
  } finally {
    h.restore();
  }
});
