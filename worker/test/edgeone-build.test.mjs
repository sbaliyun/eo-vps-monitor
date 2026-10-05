import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';
import { buildSync } from 'esbuild';

const root = fileURLToPath(new URL('../../', import.meta.url));
const routes = [
  'edge-functions/api/[[path]].ts',
  'edge-functions/agent/[[path]].ts',
  'edge-functions/ping.ts',
  'edgeone-dist/edge-functions/api/[[path]].js',
  'edgeone-dist/edge-functions/agent/[[path]].js',
  'edgeone-dist/edge-functions/ping.js',
];

function loadLikeEdgeOneCli(entry) {
  assert.ok(existsSync(entry), 'Build artifacts are required: run npm run build before this deployment regression test');
  // edgeone@1.6.41 EdgeFunctionBuilder.bundleAndGetString options. No raw
  // loaders or custom plugins may hide a problem the platform would encounter.
  const bundled = buildSync({
    entryPoints: [entry], bundle: true, write: false,
    outfile: './.tef_dist/assets.js', define: {},
  }).outputFiles.find(output => output.path.endsWith('.js')).text;
  assert.match(bundled, /\bfunction onRequest\s*\(/, 'The handler must survive the platform rebuild as a literal identifier');
  assert.match(bundled, /onRequest(?![a-zA-Z])/, 'The platform handler discovery must recognize the bundle');

  // The CLI adds responseFoo, then arrangeText inserts the function assignment
  // inside esbuild's IIFE. A re-export can contain the word onRequest while its
  // actual function name is minified; evaluating this assignment catches that.
  const text = `${bundled}responseFoo`;
  const runnable = text.replace(/\}\)\(\)\;\n(?:\/\*[\s\S]*?\*\/\n?)*responseFoo/, `
        pagesFunctionResponse = onRequest;
      })();`);
  assert.notEqual(runnable, text, 'The official arrangeText replacement must match the IIFE tail');
  const context = vm.createContext({
    console, Request, Response, Headers, URL, URLSearchParams,
    TextEncoder, TextDecoder, AbortController, AbortSignal,
    ReadableStream, WritableStream, TransformStream,
    crypto: globalThis.crypto, atob, btoa, setTimeout, clearTimeout,
    fetch: async () => { throw new Error('Unexpected external request in build regression'); },
    pagesFunctionResponse: undefined,
  });
  vm.runInContext(runnable, context, { filename: entry, timeout: 10_000 });
  assert.equal(typeof context.pagesFunctionResponse, 'function');
  return context.pagesFunctionResponse;
}

function binding() {
  const data = new Map();
  return {
    async get(key) { return data.get(key) ?? null; },
    async put(key, value) { data.set(key, value); },
    async delete(key) { data.delete(key); },
  };
}

for (const route of routes) {
  test(`official EdgeOne builder discovers and executes ${route}`, async () => {
    const onRequest = loadLikeEdgeOneCli(resolve(root, route));
    const response = await onRequest({
      request: new Request('https://monitor.example.test/api/version'),
      env: { MONITOR_KV: binding(), JWT_SECRET: 'build-test-jwt-secret-0123456789abcdef',
        ADMIN_RECOVERY_KEY: 'build-test-recovery-secret-0123456789abcdef' },
    });
    assert.equal(response.status, 200);
    const version = await response.json();
    assert.equal(version.name, 'EO VPS Monitor');
    assert.equal(version.platform, 'tencent-edgeone');
    assert.equal(response.headers.get('X-Monitor-Platform'), 'tencent-edgeone');

    const missing = await onRequest({ request: new Request('https://monitor.example.test/api/version'), env: {} });
    assert.equal(missing.status, 503);
    assert.match((await missing.json()).error, /MONITOR_KV/);
  });
}
