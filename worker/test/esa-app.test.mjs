import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, sampleReport, JWT_SECRET } from './helpers.mjs';

const KV_LIMIT = 8;

test('初始化：部署自检、创建管理员、登录与 CSRF', async () => {
  const h = await createHarness();
  try {
    const status = await h.call('GET', '/api/setup/status');
    assert.equal(status.json.ok, true);
    const recovery = await h.call('GET', '/api/admin/recovery/status');
    assert.deepEqual(recovery.json, { admin_present: false, recoverable: true });

    const wrongKey = await h.call('POST', '/api/admin/recovery', { body: { username: 'admin', password: 'admin123456', recovery_key: 'nope' } });
    assert.equal(wrongKey.status, 403);

    await h.setupAdmin();
    const me = await h.call('GET', '/api/me');
    assert.equal(me.status, 200);
    assert.equal(me.json.username, 'admin');

    const noCsrf = await h.call('POST', '/api/admin/clients/add', { body: { name: 'x' }, headers: { 'x-csrf-token': 'invalid-token-invalid-token-invalid-token' } });
    assert.equal(noCsrf.status, 403);

    const badLogin = await h.call('POST', '/api/login', { body: { username: 'admin', password: 'wrong-password' }, cookieJar: false });
    assert.equal(badLogin.status, 401);

    const logout = await h.call('POST', '/api/logout');
    assert.equal(logout.json.success, true);
    const after = await h.call('GET', '/api/admin/clients');
    assert.equal(after.status, 401);
  } finally {
    h.restore();
  }
});

test('登录失败 5 次后锁定', async () => {
  const h = await createHarness();
  try {
    await h.setupAdmin();
    let last;
    for (let i = 0; i < 6; i += 1) {
      last = await h.call('POST', '/api/login', { body: { username: 'admin', password: 'bad-password' }, cookieJar: false, ip: '192.0.2.77' });
    }
    assert.equal(last.status, 429);
  } finally {
    h.restore();
  }
});

test('Agent：鉴权、上报、实时数据、策略切换与 KV 操作预算', async () => {
  const h = await createHarness();
  try {
    await h.setupAdmin();
    const { uuid, token } = await h.addClient('hk-1');

    const unauthorized = await h.agent('POST', '/api/clients/report', 'x'.repeat(64), sampleReport());
    assert.equal(unauthorized.status, 401);

    const policy = await h.agent('GET', '/api/clients/policy', token);
    assert.equal(policy.status, 200);
    assert.equal(policy.json.type, 'policy');
    assert.equal(policy.json.mode, 'idle');
    assert.ok(policy.kvOps <= KV_LIMIT, `policy used ${policy.kvOps} KV ops`);

    const report = await h.agent('POST', '/api/clients/report', token, sampleReport({
      ipv4: '8.8.8.8',
      basic_info: { cpu_name: 'AMD EPYC', os: 'Debian 12', arch: 'amd64', cpu_cores: 4, mem_total: 4_294_967_296, region: 'HK', version: '2.0.3' },
    }));
    assert.equal(report.status, 200);
    assert.equal(report.json.success, true);
    assert.ok(report.kvOps <= KV_LIMIT, `report used ${report.kvOps} KV ops`);

    const live = await h.call('GET', '/api/live/clients?viewer=active', { cookieJar: false });
    assert.equal(live.status, 200);
    assert.deepEqual(live.json.online, [uuid]);
    assert.equal(live.json.data[uuid].cpu, 20);
    assert.equal(live.json.data[uuid].region, 'HK');
    assert.equal(typeof live.json.metadata_version, 'string');
    assert.equal(live.json.data[uuid].ipv4, undefined, '公开实时数据不应泄露 IP');
    assert.ok(live.kvOps <= KV_LIMIT, `live used ${live.kvOps} KV ops`);

    const active = await h.agent('GET', '/api/clients/policy', token);
    assert.equal(active.json.mode, 'active');
    assert.equal(active.json.report_interval_sec, 5);

    const clients = await h.call('GET', '/api/clients', { cookieJar: false });
    assert.equal(clients.json[0].cpu_name, 'AMD EPYC');
    assert.equal(clients.json[0].has_ipv4, true);
    assert.equal(clients.json[0].ipv4, undefined);

    const bootstrap = await h.call('GET', '/api/public/bootstrap', { cookieJar: false });
    assert.equal(bootstrap.status, 200);
    assert.equal(bootstrap.json.clients.length, 1);
    assert.equal(bootstrap.json.live.online.length, 1);
    assert.ok(bootstrap.kvOps <= KV_LIMIT, `bootstrap used ${bootstrap.kvOps} KV ops`);

    const admin = await h.call('GET', '/api/admin/clients');
    assert.equal(admin.json[0].ipv4, '8.8.8.8');
    assert.equal(admin.json[0].token, undefined);

    const ws = await h.agent('GET', '/api/clients/report', token);
    assert.equal(ws.status, 426);
  } finally {
    h.restore();
  }
});

test('历史：批量上报写入精细层，按时间范围查询', async () => {
  const h = await createHarness();
  try {
    await h.setupAdmin();
    const { uuid, token } = await h.addClient('node');
    const now = Date.now();
    const reports = Array.from({ length: 6 }, (_, index) => sampleReport({ cpu: 10 + index, timestamp: now - (5 - index) * 130_000 }));
    const result = await h.agent('POST', '/api/clients/report', token, { reports });
    assert.equal(result.json.persisted, true);
    const start = new Date(now - 3600_000).toISOString();
    const end = new Date(now + 60_000).toISOString();
    const records = await h.call('GET', `/api/records/load?uuid=${uuid}&start=${start}&end=${end}&cursor=${end}&limit=500`, { cookieJar: false });
    assert.equal(records.status, 200);
    assert.equal(records.json.has_more, false);
    assert.equal(records.json.data.length, 6);
    assert.deepEqual(records.json.data.map(item => item.cpu), [10, 11, 12, 13, 14, 15]);
  } finally {
    h.restore();
  }
});

test('Ping 任务：下发给 Agent、结果入库并可按批次查询', async () => {
  const h = await createHarness();
  try {
    await h.setupAdmin();
    const { uuid, token } = await h.addClient('node');
    const added = await h.call('POST', '/api/admin/ping/add', { body: { name: 'Google', type: 'tcp', target: '8.8.8.8:53', clients: [uuid], all_clients: false } });
    assert.equal(added.status, 200, added.text);
    const taskId = added.json.task.id;
    const policy = await h.agent('GET', '/api/clients/policy', token);
    assert.deepEqual(policy.json.ping_tasks.map(task => task.id), [taskId]);

    const now = Date.now();
    await h.agent('POST', '/api/clients/report', token, sampleReport({ timestamp: now - 1000, ping_results: [{ task_id: taskId, value: 23.4 }] }));
    const batch = await h.call('GET', `/api/records/ping/batch?uuid=${uuid}&task_specs=${taskId}:120:120&base_interval=120&limit=120&cursor=${new Date(now + 60_000).toISOString()}`, { cookieJar: false });
    assert.equal(batch.status, 200);
    assert.equal(batch.json[String(taskId)].length, 1);
    assert.equal(batch.json[String(taskId)][0].value, 23.4);

    const publicTasks = await h.call('GET', '/api/task/ping', { cookieJar: false });
    assert.equal(publicTasks.json.length, 1);
  } finally {
    h.restore();
  }
});

test('网站监控：边缘检测、下线告警与恢复通知', async () => {
  const h = await createHarness();
  try {
    await h.setupAdmin();
    await h.call('POST', '/api/admin/settings', { body: { notification_method: 'webhook', webhook_url: 'https://hooks.example.net/notify' } });
    let siteUp = false;
    h.setFetch(async (url) => {
      if (url.startsWith('https://site.example.org')) return new Response('x', { status: siteUp ? 200 : 503 });
      return new Response('ok', { status: 200 });
    });
    const added = await h.call('POST', '/api/admin/websites/add', { body: { name: 'Site', url: 'https://site.example.org/', method: 'GET', interval_sec: 60, grace_period_sec: 30 } });
    assert.equal(added.status, 200, added.text);

    const tcp = await h.call('POST', '/api/admin/websites/add', { body: { name: 'TCP', url: 'tcp://1.1.1.1:443', method: 'TCP' } });
    assert.equal(tcp.status, 400);
    assert.equal(tcp.json.code, 'tcp_requires_agent_probe');

    const first = await h.call('POST', '/api/admin/cron/run');
    assert.equal(first.json.ran, true);
    let list = await h.call('GET', '/api/websites?hours=24', { cookieJar: false });
    assert.equal(list.json[0].status, 'down');
    assert.equal(list.json[0].checks.length, 1);

    // 超过宽限期后下一轮维护发送告警。
    const doc = JSON.parse(h.memory.data.get('websites'));
    const runtime = Object.values(doc.monitors)[0];
    runtime.down_since = new Date(Date.now() - 120_000).toISOString();
    runtime.last_checked_at = new Date(Date.now() - 120_000).toISOString();
    h.memory.data.set('websites', JSON.stringify(doc));
    h.outbound.length = 0;
    await h.runMaintenance();
    assert.ok(h.outbound.some(item => item.url === 'https://hooks.example.net/notify'), '应发送下线告警');

    siteUp = true;
    const doc2 = JSON.parse(h.memory.data.get('websites'));
    Object.values(doc2.monitors)[0].last_checked_at = new Date(Date.now() - 120_000).toISOString();
    h.memory.data.set('websites', JSON.stringify(doc2));
    h.outbound.length = 0;
    await h.runMaintenance();
    list = await h.call('GET', '/api/websites?hours=24', { cookieJar: false });
    assert.equal(list.json[0].status, 'up');
    assert.ok(h.outbound.some(item => item.url === 'https://hooks.example.net/notify'), '应发送恢复通知');
  } finally {
    h.restore();
  }
});

test('离线告警：连续确认后发送，恢复后发送上线通知', async () => {
  const h = await createHarness();
  try {
    await h.setupAdmin();
    await h.call('POST', '/api/admin/settings', { body: { notification_method: 'webhook', webhook_url: 'https://hooks.example.net/n', offline_confirm_rounds: '1' } });
    const { uuid, token } = await h.addClient('node');
    await h.agent('POST', '/api/clients/report', token, sampleReport());
    const edited = await h.call('POST', '/api/admin/notification/offline/edit', { body: { client: uuid, enable: true, grace_period: 60 } });
    assert.equal(edited.status, 200, edited.text);

    const shard = JSON.parse(h.memory.data.get('live_0'));
    shard.entries[uuid].t = Date.now() - 600_000;
    shard.entries[uuid].exp = Date.now() - 300_000;
    h.memory.data.set('live_0', JSON.stringify(shard));
    h.worker.resetKvModuleCacheForTests();
    h.outbound.length = 0;
    for (let i = 0; i < 3; i += 1) await h.runMaintenance();
    assert.equal(h.outbound.filter(item => item.url === 'https://hooks.example.net/n').length, 1, '只发送一次离线告警');
    const rules = await h.call('GET', '/api/admin/notification/offline');
    assert.ok(rules.json[0].last_notified);

    await h.agent('POST', '/api/clients/report', token, sampleReport());
    h.outbound.length = 0;
    await h.runMaintenance();
    assert.equal(h.outbound.filter(item => item.url === 'https://hooks.example.net/n').length, 1, '恢复上线通知');
    h.outbound.length = 0;
    await h.runMaintenance();
    assert.equal(h.outbound.length, 0, '恢复通知不重复');
  } finally {
    h.restore();
  }
});

test('负载告警：在写历史时评估并按间隔去重', async () => {
  const h = await createHarness();
  try {
    await h.setupAdmin();
    await h.call('POST', '/api/admin/settings', { body: { notification_method: 'webhook', webhook_url: 'https://hooks.example.net/load' } });
    const { token } = await h.addClient('node');
    const rule = await h.call('POST', '/api/admin/notification/load/add', { body: { name: 'CPU', metric: 'cpu', threshold: 80, ratio: 0.5, interval_min: 15, clients: [], all_clients: true } });
    assert.equal(rule.status, 200, rule.text);
    const now = Date.now();
    const reports = [0, 1, 2].map(index => sampleReport({ cpu: 95, timestamp: now - (2 - index) * 130_000 }));
    h.outbound.length = 0;
    await h.agent('POST', '/api/clients/report', token, { reports });
    assert.equal(h.outbound.filter(item => item.url === 'https://hooks.example.net/load').length, 1);
    await h.agent('POST', '/api/clients/report', token, { reports: [sampleReport({ cpu: 99, timestamp: now + 1000 }), sampleReport({ cpu: 99, timestamp: now + 2000 })] });
    assert.equal(h.outbound.filter(item => item.url === 'https://hooks.example.net/load').length, 1, '间隔内不重复告警');
    const rules = await h.call('GET', '/api/admin/notification/load');
    assert.equal(rules.json[0].all_clients, true);
  } finally {
    h.restore();
  }
});

test('节点删除清理引用与实时数据', async () => {
  const h = await createHarness();
  try {
    await h.setupAdmin();
    const { uuid, token } = await h.addClient('gone');
    await h.agent('POST', '/api/clients/report', token, sampleReport());
    await h.call('POST', '/api/admin/ping/add', { body: { name: 'p', type: 'icmp', target: '1.1.1.1', clients: [uuid], all_clients: false } });
    const removed = await h.call('POST', `/api/admin/clients/${uuid}/remove`, { body: {} });
    assert.equal(removed.status, 200, removed.text);
    assert.ok(removed.kvOps <= KV_LIMIT, `remove used ${removed.kvOps}`);
    const tasks = await h.call('GET', '/api/admin/ping');
    assert.equal(tasks.json.length, 0);
    const live = await h.call('GET', '/api/live/clients', { cookieJar: false });
    assert.equal(live.json.count, 0);
    const reauth = await h.agent('POST', '/api/clients/report', token, sampleReport());
    assert.equal(reauth.status, 401);
  } finally {
    h.restore();
  }
});

test('双重身份验证：登录挑战与敏感操作二次确认', async () => {
  const h = await createHarness();
  try {
    await h.setupAdmin();
    const setup = await h.call('POST', '/api/admin/account/mfa/setup', { body: { password: 'admin123456' } });
    assert.equal(setup.status, 200, setup.text);
    const code = await h.worker.generateTotpCode(setup.json.secret, Date.now());
    const enabled = await h.call('POST', '/api/admin/account/mfa/enable', { body: { setup_token: setup.json.setup_token, code } });
    assert.equal(enabled.status, 200, enabled.text);
    assert.equal(enabled.json.recovery_codes.length, 8);

    const needsStepUp = await h.call('POST', '/api/admin/download/backup', { body: { backup_password: 'backup-pass' } });
    assert.equal(needsStepUp.status, 428);

    const stepUp = await h.call('POST', '/api/admin/account/mfa/step-up', { body: { method: 'recovery_code', code: enabled.json.recovery_codes[0] } });
    assert.equal(stepUp.status, 200, stepUp.text);
    const backup = await h.call('POST', '/api/admin/download/backup', { body: { backup_password: 'backup-pass' } });
    assert.equal(backup.status, 200, backup.text);
    assert.equal(backup.json.schema, 'cf-monitor.encrypted-backup');

    await h.call('POST', '/api/logout');
    const login = await h.call('POST', '/api/login', { body: { username: 'admin', password: 'admin123456' } });
    assert.equal(login.json.code, 'MFA_REQUIRED');
    const reused = await h.call('POST', '/api/login/mfa', { body: { challenge: login.json.challenge, method: 'recovery_code', code: enabled.json.recovery_codes[0] } });
    assert.equal(reused.status, 401, '恢复码只能使用一次');
    const ok = await h.call('POST', '/api/login/mfa', { body: { challenge: login.json.challenge, method: 'recovery_code', code: enabled.json.recovery_codes[1] } });
    assert.equal(ok.status, 200, ok.text);
  } finally {
    h.restore();
  }
});

test('备份：加密导出后可在新部署恢复（兼容原 cf-vps-monitor 备份格式）', async () => {
  const h = await createHarness();
  let backup;
  try {
    await h.setupAdmin();
    const { uuid } = await h.addClient('backup-node');
    await h.call('POST', '/api/admin/ping/add', { body: { name: 'p', type: 'icmp', target: '1.1.1.1', clients: [], all_clients: true } });
    await h.call('POST', '/api/admin/websites/add', { body: { name: 'Site', url: 'https://example.org/', method: 'GET' } });
    await h.call('POST', '/api/admin/notification/offline/edit', { body: { client: uuid, enable: true, grace_period: 300 } });
    const download = await h.call('POST', '/api/admin/download/backup', { body: { backup_password: 'backup-pass' } });
    assert.equal(download.status, 200, download.text);
    backup = download.json;
  } finally {
    h.restore();
  }

  const fresh = await createHarness();
  try {
    await fresh.setupAdmin('owner', 'owner123456');
    const restored = await fresh.call('POST', '/api/admin/upload/backup?confirm_restore=true&acknowledge_overwrite=true', {
      body: { backup, backup_password: 'backup-pass', confirm_restore: true, acknowledge_overwrite: true },
    });
    assert.equal(restored.status, 200, restored.text);
    const clients = await fresh.call('GET', '/api/admin/clients');
    assert.equal(clients.json[0].name, 'backup-node');
    const tokenInstall = await fresh.call('POST', `/api/admin/clients/${clients.json[0].uuid}/token/install`, { body: {} });
    assert.equal(tokenInstall.status, 200);
    const report = await fresh.agent('POST', '/api/clients/report', tokenInstall.json.token, sampleReport());
    assert.equal(report.status, 200, '恢复后原 Token 仍可上报');
    const websites = await fresh.call('GET', '/api/admin/websites');
    assert.equal(websites.json.length, 1);
    const offline = await fresh.call('GET', '/api/admin/notification/offline');
    assert.equal(offline.json.length, 1);
  } finally {
    fresh.restore();
  }
});

test('设置：公开设置、脱敏预览与拒绝 SMTP 邮件', async () => {
  const h = await createHarness();
  try {
    await h.setupAdmin();
    const saved = await h.call('POST', '/api/admin/settings', { body: { site_title: '我的探针', telegram_bot_token: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ' } });
    assert.equal(saved.status, 200, saved.text);
    const pub = await h.call('GET', '/api/public', { cookieJar: false });
    assert.equal(pub.json.site_title, '我的探针');
    assert.equal(pub.json.telegram_bot_token, undefined);
    const notification = await h.call('GET', '/api/admin/settings?scope=notification');
    assert.equal(notification.json.telegram_bot_token, undefined);
    assert.equal(notification.json.telegram_bot_token_set, 'true');
    const email = await h.call('POST', '/api/admin/settings', { body: { notification_method: 'email' } });
    assert.equal(email.status, 400);
    const version = await h.call('GET', '/api/version', { cookieJar: false });
    assert.equal(version.json.name, 'ESA VPS Monitor');
  } finally {
    h.restore();
  }
});

test('外部定时入口需要密钥', async () => {
  const h = await createHarness({ CRON_SECRET: 'cron-secret-value' });
  try {
    const denied = await h.call('GET', '/api/cron?key=wrong', { cookieJar: false });
    assert.equal(denied.status, 401);
    const allowed = await h.call('GET', '/api/cron?key=cron-secret-value', { cookieJar: false });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.json.success, true);
  } finally {
    h.restore();
  }
});

test('ESA 入口签名兼容 (request, context, env) 与 (request, env, ctx)', async () => {
  const h = await createHarness();
  try {
    const esa = await h.worker.handleRequest(new Request('https://x.test/api/setup/status'), { waitUntil() {} }, { JWT_SECRET, KV_NAMESPACE: 't' });
    assert.equal((await esa.json()).ok, true);
    const cf = await h.worker.handleRequest(new Request('https://x.test/api/setup/status'), { JWT_SECRET, KV_NAMESPACE: 't' }, { waitUntil() {} });
    assert.equal((await cf.json()).ok, true);
  } finally {
    h.restore();
  }
});
