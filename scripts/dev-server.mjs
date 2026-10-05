#!/usr/bin/env node
/**
 * 本地模拟 EdgeOne Pages：
 *  - 静态资源来自 edgeone-dist，页面导航请求走 SPA 回退；
 *  - 其余请求交给函数入口；
 *  - MONITOR_KV 用原始 binding 实现，并持久化到 .dev/eo-kv.json。
 *
 * 用法：JWT_SECRET=至少32字节 node scripts/dev-server.mjs [--port 8787]
 */
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildEdgeOne } from './build-edgeone.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1] || process.env.PORT || 8787);
const staticDir = existsSync(join(root, 'edgeone-dist', 'index.html'))
  ? join(root, 'edgeone-dist') : join(root, 'frontend', 'dist');
const kvFile = join(root, '.dev', 'eo-kv.json');

const outfile = join(root, 'worker', '.tmp', 'dev-entry.mjs');
await buildEdgeOne({ entry: join(root, 'worker', 'src', 'dev-entry.ts'), outfile, minify: false });
const worker = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);

mkdirSync(dirname(kvFile), { recursive: true });
const initial = existsSync(kvFile) ? JSON.parse(readFileSync(kvFile, 'utf8')) : {};
const data = new Map(Object.entries(initial));
let saveTimer = null;
function persistKv() {
  clearTimeout(saveTimer);
  saveTimer = null;
  writeFileSync(kvFile, JSON.stringify(Object.fromEntries(data)));
}
function scheduleKvSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persistKv, 200);
}
const binding = {
  async get(key) { return data.get(key) ?? null; },
  async put(key, value) { data.set(key, value); scheduleKvSave(); },
  async delete(key) { data.delete(key); scheduleKvSave(); },
};

const env = {
  JWT_SECRET: process.env.JWT_SECRET || 'local-dev-secret-please-change-0123456789abcdef',
  MONITOR_KV: binding,
  ADMIN_RECOVERY_KEY: process.env.ADMIN_RECOVERY_KEY || 'local-dev-admin-recovery-key-0123456789abcdef',
  CRON_SECRET: process.env.CRON_SECRET || '',
};

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8',
};

function staticFile(pathname) {
  const safe = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  const file = join(staticDir, safe);
  if (!file.startsWith(staticDir)) return null;
  try {
    const stat = statSync(file);
    if (stat.isFile()) return file;
    if (stat.isDirectory() && existsSync(join(file, 'index.html'))) return join(file, 'index.html');
  } catch {
    return null;
  }
  return null;
}

function isNavigation(req) {
  return req.headers['sec-fetch-mode'] === 'navigate' || (req.method === 'GET' && String(req.headers.accept || '').includes('text/html'));
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || `localhost:${port}`}`);
    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname !== '/' && !url.pathname.startsWith('/api/')) {
      const file = staticFile(url.pathname);
      if (file) {
        res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
        res.end(req.method === 'HEAD' ? undefined : readFileSync(file));
        return;
      }
    }
    if (isNavigation(req) && !url.pathname.startsWith('/api/')) {
      const index = join(staticDir, 'index.html');
      if (existsSync(index)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(readFileSync(index));
        return;
      }
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) value.forEach(item => headers.append(key, item));
      else if (value !== undefined) headers.set(key, value);
    }
    const request = new Request(url, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
    });
    // Mirror the runtime metadata; client-supplied proxy headers are sanitized
    // inside onRequest, exactly as they are in the deployed EdgeOne function.
    request.eo = { clientIp: req.socket.remoteAddress || '127.0.0.1' };
    const response = await worker.onRequest({ request, env });
    const out = {};
    response.headers.forEach((value, key) => {
      if (key === 'set-cookie') return;
      out[key] = value;
    });
    const cookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    if (cookies.length) out['set-cookie'] = cookies;
    res.writeHead(response.status, out);
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error(error);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('dev server error');
  }
});

server.listen(port, () => {
  console.log(`[dev] EO VPS Monitor 本地模拟运行在 http://localhost:${port}`);
  console.log(`[dev] KV 数据文件：${kvFile}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    persistKv();
    server.close(() => process.exit(0));
  });
}
