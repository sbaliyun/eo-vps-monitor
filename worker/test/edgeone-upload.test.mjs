import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { createHarness } from './helpers.mjs';

const RECOVERY_KEY = 'edgeone-upload-recovery-0123456789abcdefghijklmnopqrstuvwxyz';
const KiB = 1024;

async function authenticatedHarness() {
  const h = await createHarness({ EDGEONE: true, ADMIN_RECOVERY_KEY: RECOVERY_KEY });
  const created = await h.call('POST', '/api/admin/recovery', {
    body: { username: 'admin', password: 'admin123456', recovery_key: RECOVERY_KEY },
  });
  assert.equal(created.status, 200, created.text);
  const login = await h.call('POST', '/api/login', { body: { username: 'admin', password: 'admin123456' } });
  assert.equal(login.status, 200, login.text);
  return h;
}

function multipart(bytes, type, filename) {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type }), filename);
  return form;
}

function png(size) {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytes;
}

function themeZip() {
  return zipSync({
    'cf-monitor-theme.json': strToU8(JSON.stringify({ name: 'Upload test', short: 'upload-test', style: 'style.css' })),
    'style.css': strToU8('.layout { color: #123456; }'),
  });
}

test('EdgeOne Logo 原图 600 KiB 可存储，超限拒绝且保留原 Logo；ESA 旧限制不变', async () => {
  const h = await authenticatedHarness();
  try {
    const saved = await h.call('POST', '/api/admin/site-logo', { body: multipart(png(600 * KiB), 'image/png', 'logo.png') });
    assert.equal(saved.status, 200, saved.text);
    const oldLogo = h.memory.data.get('site_logo');
    const oldCore = h.memory.data.get('core');
    assert.ok(new TextEncoder().encode(oldLogo).byteLength < 900 * KiB, 'Base64 后仍符合 KV 预算');

    const oversized = await h.call('POST', '/api/admin/site-logo', { body: multipart(png(600 * KiB + 1), 'image/png', 'logo.png') });
    assert.equal(oversized.status, 413, oversized.text);
    assert.match(oversized.json.error, /600 KiB/);
    assert.equal(h.memory.data.get('site_logo'), oldLogo);
    assert.equal(h.memory.data.get('core'), oldCore);

    h.env.EDGEONE = false;
    const esa = await h.call('POST', '/api/admin/site-logo', { body: multipart(png(600 * KiB + 1), 'image/png', 'logo.png') });
    assert.equal(esa.status, 200, esa.text);
  } finally {
    h.restore();
  }
});

test('EdgeOne 主题 ZIP 和 multipart 请求分别受限，拒绝前不覆盖或删除旧资源', async () => {
  const h = await authenticatedHarness();
  try {
    const zip = themeZip();
    const saved = await h.call('POST', '/api/admin/themes/upload', { body: multipart(zip, 'application/zip', 'theme.zip') });
    assert.equal(saved.status, 200, saved.text);
    const limits = await h.call('GET', '/api/admin/themes');
    assert.equal(limits.json.upload_max_bytes, 800 * KiB);
    const oldCore = h.memory.data.get('core');
    const oldAssets = [...h.memory.data].filter(([key]) => key.startsWith('theme_'));

    const largeZip = new Uint8Array(800 * KiB + 1);
    largeZip.set(zip);
    const oversizedFile = await h.call('POST', '/api/admin/themes/upload', {
      body: multipart(largeZip, 'application/zip', 'theme.zip'),
    });
    assert.equal(oversizedFile.status, 413, oversizedFile.text);
    assert.match(oversizedFile.json.error, /800 KiB/);

    const largeRequest = multipart(zip, 'application/zip', 'theme.zip');
    largeRequest.append('padding', 'x'.repeat(900 * KiB));
    const oversizedRequest = await h.call('POST', '/api/admin/themes/upload', { body: largeRequest });
    assert.equal(oversizedRequest.status, 413, oversizedRequest.text);
    assert.match(oversizedRequest.json.error, /900 KiB/);
    assert.equal(h.memory.data.get('core'), oldCore);
    assert.deepEqual([...h.memory.data].filter(([key]) => key.startsWith('theme_')), oldAssets);
  } finally {
    h.restore();
  }
});

test('EdgeOne 小备份可导出恢复，超限文件和无 Content-Length 的请求在解密前拒绝', async () => {
  const h = await authenticatedHarness();
  const originalDecrypt = crypto.subtle.decrypt;
  let decryptCalls = 0;
  try {
    await h.addClient('backup-original');
    const exported = await h.call('POST', '/api/admin/download/backup', { body: { backup_password: 'backup-pass' } });
    assert.equal(exported.status, 200, exported.text);
    assert.ok(new TextEncoder().encode(exported.text).byteLength < 800 * KiB);
    const restored = await h.call('POST', '/api/admin/upload/backup?confirm_restore=true&acknowledge_overwrite=true', {
      body: { backup: exported.json, backup_password: 'backup-pass' },
    });
    assert.equal(restored.status, 200, restored.text);

    h.memory.data.set('node_existing', 'history-must-survive');
    const oldCore = h.memory.data.get('core');
    crypto.subtle.decrypt = async function (...args) {
      decryptCalls += 1;
      return originalDecrypt.apply(this, args);
    };
    for (const size of [800 * KiB + 1, 900 * KiB + 1]) {
      const oversized = await h.call('POST', '/api/admin/upload/backup?confirm_restore=true&acknowledge_overwrite=true', {
        body: { backup: { ...exported.json, ciphertext: 'A'.repeat(size) }, backup_password: 'backup-pass' },
      });
      assert.equal(oversized.status, 413, oversized.text);
      assert.equal(h.memory.data.get('core'), oldCore);
      assert.equal(h.memory.data.get('node_existing'), 'history-must-survive');
    }
    assert.equal(decryptCalls, 0, '超限请求不能执行解密或恢复');
  } finally {
    crypto.subtle.decrypt = originalDecrypt;
    h.restore();
  }
});

test('EdgeOne 超限备份导出在 PBKDF2 和 AES 之前返回可读 413，原配置不变', async () => {
  const h = await authenticatedHarness();
  const originalEncrypt = crypto.subtle.encrypt;
  const originalDeriveKey = crypto.subtle.deriveKey;
  let cryptoCalls = 0;
  try {
    await h.addClient('export-size-test');
    const baseCore = JSON.parse(h.memory.data.get('core'));
    const baseClient = baseCore.clients[0];
    crypto.subtle.encrypt = async function (...args) {
      cryptoCalls += 1;
      return originalEncrypt.apply(this, args);
    };
    crypto.subtle.deriveKey = async function (...args) {
      cryptoCalls += 1;
      return originalDeriveKey.apply(this, args);
    };
    for (const [count, message] of [[400, /800 KiB/], [1000, /1 MiB/]]) {
      const core = {
        ...baseCore,
        clients: Array.from({ length: count }, (_, index) => ({
          ...baseClient, uuid: crypto.randomUUID(), token: `token-${index}`, token_hash: `hash-${index}`,
          remark: 'r'.repeat(512), public_remark: 'p'.repeat(512), sort_order: index + 1,
        })),
      };
      const originalCore = JSON.stringify(core);
      h.memory.data.set('core', originalCore);
      h.worker.resetKvModuleCacheForTests();
      const exported = await h.call('POST', '/api/admin/download/backup', { body: { backup_password: 'backup-pass' } });
      assert.equal(exported.status, 413, exported.text);
      assert.match(exported.json.error, message);
      assert.equal(h.memory.data.get('core'), originalCore);
    }
    assert.equal(cryptoCalls, 0, '超限导出不能先派生密钥或加密');
  } finally {
    crypto.subtle.encrypt = originalEncrypt;
    crypto.subtle.deriveKey = originalDeriveKey;
    h.restore();
  }
});
