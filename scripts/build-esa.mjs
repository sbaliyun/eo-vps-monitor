#!/usr/bin/env node
/**
 * 把 worker/src/esa-entry.ts 打包成单个 ES Module，供 ESA 函数和 Pages 使用。
 * 产物：worker/dist/esa-entry.js（esa.jsonc 的 entry 指向这里）。
 *
 * ESA 边缘运行时没有 Node 内置模块：这里以 browser 平台打包，任何 node: 导入都会让构建失败。
 */
import { execSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function resolveCommit() {
  for (const key of ['CURRENT_GIT_COMMIT', 'GITHUB_SHA', 'COMMIT_SHA', 'COMMIT_ID', 'GIT_COMMIT']) {
    const value = (process.env[key] || '').trim();
    if (/^[0-9a-f]{7,40}$/i.test(value)) return value.toLowerCase();
  }
  try {
    return execSync('git rev-parse HEAD', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
}

export async function buildEsa({ outfile = join(root, 'worker', 'dist', 'esa-entry.js'), entry = join(root, 'worker', 'src', 'esa-entry.ts'), minify = true } = {}) {
  mkdirSync(dirname(outfile), { recursive: true });
  const commit = resolveCommit();
  const result = await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify,
    sourcemap: false,
    legalComments: 'none',
    mainFields: ['browser', 'module', 'main'],
    conditions: ['browser', 'worker', 'import'],
    define: { __BUILD_COMMIT__: JSON.stringify(commit) },
    logLevel: 'warning',
    metafile: true,
  });
  const nodeImports = Object.keys(result.metafile.inputs).filter(input => input.startsWith('node:'));
  if (nodeImports.length > 0) throw new Error(`ESA 运行时不支持 Node 内置模块: ${nodeImports.join(', ')}`);
  return { outfile, commit, bytes: statSync(outfile).size };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const info = await buildEsa();
  console.log(`[build-esa] ${info.outfile} (${(info.bytes / 1024).toFixed(1)} KiB)${info.commit ? ` commit=${info.commit.slice(0, 7)}` : ''}`);
}
