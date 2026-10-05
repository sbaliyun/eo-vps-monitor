import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { unzipSync } from 'fflate';
import { buildAgentSourceArchives } from '../scripts/build-edgeone.mjs';

const agent = fileURLToPath(new URL('./', import.meta.url));
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const pwshAvailable = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { timeout: 10000 }).status === 0;

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'eo-agent-source-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  buildAgentSourceArchives(root);
  return root;
}

function tarFiles(bytes) {
  const files = {};
  for (let offset = 0; bytes[offset];) {
    const name = bytes.subarray(offset, offset + 100).toString().replace(/\0.*$/, '');
    const size = parseInt(bytes.subarray(offset + 124, offset + 136).toString(), 8);
    assert.ok(Number.isSafeInteger(size) && size >= 0);
    assert.ok(!files[name], `duplicate archive entry ${name}`);
    files[name] = bytes.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

test('EO 源码归档可解压，包含本仓库完整 Go 编译输入且不带测试或安装器', t => {
  const root = fixture(t);
  const tar = tarFiles(gunzipSync(readFileSync(join(root, 'agent/source.tar.gz'))));
  const zip = unzipSync(readFileSync(join(root, 'agent/source.zip')));
  const expected = readdirSync(agent).filter(name => name === 'go.mod' || name === 'go.sum' || (name.endsWith('.go') && !name.endsWith('_test.go'))).concat('LICENSE').map(name => `agent/${name}`).sort();
  for (const archive of [tar, zip]) {
    assert.deepEqual(Object.keys(archive).sort(), expected);
    for (const name of expected) {
      const original = name === 'agent/LICENSE' ? new URL('../LICENSE', import.meta.url) : join(agent, name.slice(6));
      assert.deepEqual(Buffer.from(archive[name]), readFileSync(original));
    }
  }
});

for (const installer of ['install.sh', 'install-linux.sh']) {
  test(`${installer} 的默认 Release 失败后解压同源源码并调用 Go`, { skip: process.platform === 'win32' }, t => {
    const root = fixture(t);
    const source = readFileSync(join(agent, installer), 'utf8');
    const definitions = source.split(installer === 'install.sh' ? /^while \[ "\$#" -gt 0 \]; do/m : /^while \[\[ \$# -gt 0 \]\]; do/m)[0];
    const binaryStart = source.indexOf('if [[ -n "$BINARY" ]]; then', source.indexOf('INSTALL_GHPROXY="$(normalize_proxy_url'));
    const binaryEnd = source.indexOf('if ! is_macos; then', binaryStart);
    const prepare = installer === 'install.sh' ? 'prepare_binary' : source.slice(binaryStart, binaryEnd);
    assert.ok(installer === 'install.sh' || (binaryStart > 0 && binaryEnd > binaryStart));
    const script = join(root, 'fixture.sh');
    const log = join(root, 'download.log');
    writeFileSync(script, `${definitions}
ROOT=${quote(root)}
SERVER=https://panel.example/
export TMPDIR="$ROOT"
SCRIPT_DIR="$ROOT/no-local-source"
INSTALL_GHPROXY=https://github-proxy.example
download_file() {
  printf '%s\\n' "$1" >> "$ROOT/download.log"
  case "$1" in
    https://panel.example/agent/source.tar.gz) cp "$ROOT/agent/source.tar.gz" "$2" ;;
    *) return 22 ;;
  esac
}

go() {
  [ -f go.mod ] && [ -f main.go ] || return 77
  printf '%s\\n' "$PWD" > "$ROOT/build-dir"
  printf 'synthetic executable' > "$WORK_BIN"
}
${prepare}
[ -s "$WORK_BIN" ] || exit 78
`);
    const result = spawnSync(installer === 'install.sh' ? 'sh' : 'bash', [script], { encoding: 'utf8', timeout: 10000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const requests = readFileSync(log, 'utf8').trim().split('\n');
    assert.ok(requests[0].startsWith('https://github-proxy.example/https://github.com/'));
    assert.equal(requests.at(-1), 'https://panel.example/agent/source.tar.gz');
    assert.ok(existsSync(join(readFileSync(join(root, 'build-dir'), 'utf8').trim(), 'traffic_replace_windows.go')));
  });
}

test('缺少 Go 时给出可执行的解决方式，并且不下载源码或启动服务', { skip: process.platform === 'win32' }, t => {
  const root = fixture(t);
  const definitions = readFileSync(join(agent, 'install.sh'), 'utf8').split(/^while \[ "\$#" -gt 0 \]; do/m)[0];
  const script = join(root, 'no-go.sh');
  writeFileSync(script, `${definitions}
ROOT=${quote(root)}
export TMPDIR="$ROOT"
SERVER=https://panel.example
has() { [ "$1" != go ] && command -v "$1" >/dev/null 2>&1; }
download_file() { printf '%s\\n' "$1" >> "$ROOT/download.log"; return 22; }
prepare_binary
`);
  const result = spawnSync('sh', [script], { encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Install Go.*AGENT_REPOSITORY/);
  assert.equal(readFileSync(join(root, 'download.log'), 'utf8').trim().split('\n').length, 1);
});

test('Release 校验失败会阻止安装，不能借源码回退绕过校验', { skip: process.platform === 'win32' }, t => {
  const root = fixture(t);
  const definitions = readFileSync(join(agent, 'install.sh'), 'utf8').split(/^while \[ "\$#" -gt 0 \]; do/m)[0];
  const script = join(root, 'bad-checksum.sh');
  writeFileSync(script, `${definitions}
ROOT=${quote(root)}
export TMPDIR="$ROOT"
SERVER=https://panel.example
download_file() { printf 'downloaded bytes' > "$2"; }
verify_binary_checksum() { printf 'invalid checksum\\n' >&2; return 33; }
go() { printf 'UNEXPECTED_GO_EXECUTION\\n'; return 99; }
prepare_binary
`);
  const result = spawnSync('sh', [script], { encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.status, 33);
  assert.doesNotMatch(result.stdout, /UNEXPECTED_GO_EXECUTION/);
  assert.match(result.stderr, /invalid checksum/);
});

for (const scenario of ['build', 'checksum', 'no-go']) {
  test(`Windows 安装器同源源码流程：${scenario}`, { skip: !pwshAvailable }, t => {
    const root = fixture(t);
    const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', join(agent, 'testdata/edgeone-source.ps1'),
      '-Installer', join(agent, 'install-windows.ps1'), '-Root', root, '-Case', scenario], { encoding: 'utf8', timeout: 15000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const observed = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
    if (scenario === 'build') {
      assert.equal(observed.error, null);
      assert.equal(observed.binary_selected, true);
      assert.equal(observed.requests.at(-1), 'https://panel.example/agent/source.zip');
      assert.ok(existsSync(join(observed.compiled_directory, 'main.go')));
      assert.equal(observed.checksum_checked, false);
    } else {
      assert.equal(observed.binary_selected, false);
      assert.equal(observed.compiled_directory, '');
      assert.equal(observed.requests.length, 1);
      if (scenario === 'checksum') {
        assert.equal(observed.error, 'Synthetic checksum mismatch');
        assert.equal(observed.checksum_checked, true);
      } else {
        assert.match(observed.error, /Install Go.*AGENT_REPOSITORY/);
      }
    }
  });
}
