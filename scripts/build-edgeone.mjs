import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { zipSync } from 'fflate';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/** Publish the exact Go implementation bundled with this panel, including SSL support. */
export function buildAgentSourceArchives(output, source = join(root, 'agent')) {
  const names = readdirSync(source).filter(name =>
    name === 'go.mod' || name === 'go.sum' || (name.endsWith('.go') && !name.endsWith('_test.go')),
  ).concat('LICENSE').sort();
  for (const required of ['go.mod', 'go.sum', 'main.go']) {
    if (!names.includes(required)) throw new Error(`Agent source is missing ${required}`);
  }
  const blocks = [];
  const zipFiles = {};
  for (const name of names) {
    const archivePath = `agent/${name}`;
    const content = readFileSync(name === 'LICENSE' ? join(root, 'LICENSE') : join(source, name));
    const header = Buffer.alloc(512);
    header.write(archivePath, 0, 100, 'utf8');
    const octal = (value, offset, width) => header.write(value.toString(8).padStart(width - 1, '0') + '\0', offset, width, 'ascii');
    octal(0o644, 100, 8);
    octal(0, 108, 8);
    octal(0, 116, 8);
    octal(content.length, 124, 12);
    octal(0, 136, 12);
    header.fill(0x20, 148, 156);
    header.write('0', 156, 1, 'ascii');
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    blocks.push(header, content, Buffer.alloc((512 - content.length % 512) % 512));
    zipFiles[archivePath] = [content, { mtime: new Date('1980-01-01T00:00:00Z') }];
  }
  blocks.push(Buffer.alloc(1024));
  const target = join(output, 'agent');
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'source.tar.gz'), gzipSync(Buffer.concat(blocks)));
  writeFileSync(join(target, 'source.zip'), zipSync(zipFiles));
  return names;
}

function currentCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

export async function buildEdgeOne({ outfile = join(root, 'worker', 'dist', 'edgeone-entry.js'), entry = join(root, 'worker', 'src', 'edgeone-entry.ts'), minify = true } = {}) {
  mkdirSync(dirname(outfile), { recursive: true });
  const result = await build({
    entryPoints: [entry], outfile, bundle: true, format: 'esm', platform: 'browser',
    target: 'es2022', minify, sourcemap: false, legalComments: 'none',
    mainFields: ['browser', 'module', 'main'], conditions: ['browser', 'worker', 'import'],
    loader: { '.sh': 'text', '.ps1': 'text' },
    define: { __BUILD_COMMIT__: JSON.stringify(currentCommit()) }, metafile: true,
  });
  const invalid = Object.keys(result.metafile.inputs).filter(input => /^(?:node:|cloudflare:)/.test(input));
  if (invalid.length) throw new Error(`Unsupported EdgeOne runtime imports: ${invalid.join(', ')}`);
  const bytes = statSync(outfile).size;
  if (bytes > 5 * 1024 * 1024) throw new Error('EdgeOne function bundle exceeds 5 MiB');
  return { outfile, bytes };
}

export async function buildEdgeOneOutput() {
  const info = await buildEdgeOne();
  const handler = join(root, 'worker', 'dist', 'edgeone-handler.js');
  await build({
    stdin: {
      contents: `import handleRequest from ${JSON.stringify(info.outfile)};\nexport function onRequest(context) { return handleRequest(context); }`,
      resolveDir: root, sourcefile: 'edgeone-handler.js', loader: 'js',
    },
    outfile: handler, bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
    // EO's builder discovers and invokes a literal onRequest identifier.
    minify: false, legalComments: 'none',
  });
  const handlerBytes = statSync(handler).size;
  if (handlerBytes > 5 * 1024 * 1024) throw new Error('EdgeOne handler exceeds 5 MiB');
  const output = join(root, 'edgeone-dist');
  rmSync(output, { recursive: true, force: true });
  cpSync(join(root, 'frontend', 'dist'), output, { recursive: true });
  cpSync(join(root, 'LICENSE'), join(output, 'LICENSE'));
  buildAgentSourceArchives(output);
  const routes = ['api/[[path]].js', 'agent/[[path]].js', 'ping.js'];
  for (const route of routes) {
    const path = join(output, 'edge-functions', route);
    mkdirSync(dirname(path), { recursive: true });
    cpSync(handler, path);
  }
  writeFileSync(join(output, 'package.json'), JSON.stringify({ name: 'eo-vps-monitor-output', private: true, type: 'module' }, null, 2) + '\n');
  const config = JSON.parse(readFileSync(join(root, 'edgeone.json'), 'utf8'));
  delete config.buildCommand;
  delete config.installCommand;
  delete config.outputDirectory;
  writeFileSync(join(output, 'edgeone.json'), JSON.stringify(config, null, 2) + '\n');
  console.log(`[build-edgeone] ${output}, function ${(handlerBytes / 1024).toFixed(1)} KiB`);
}

if (import.meta.url === `file://${process.argv[1]}`) await buildEdgeOneOutput();
