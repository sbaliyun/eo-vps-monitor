import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const tmp = await mkdtemp(join(tmpdir(), 'cf-monitor-agent-command-'));
const projectLinksSource = await readFile(new URL('./projectLinks.ts', import.meta.url), 'utf8');
const commandSource = await readFile(new URL('./agentInstallCommand.ts', import.meta.url), 'utf8');
await writeFile(join(tmp, 'projectLinks.ts'), projectLinksSource);
await writeFile(join(tmp, 'agentInstallCommand.ts'), commandSource.replace("from './projectLinks'", "from './projectLinks.ts'"));

const { buildAgentInstallCommand, buildAgentUninstallAllCommand, defaultAgentInstallOptions } = await import(pathToFileURL(join(tmp, 'agentInstallCommand.ts')).href);
const { CF_MONITOR_REPOSITORY } = await import(pathToFileURL(join(tmp, 'projectLinks.ts')).href);

const base = {
  serverUrl: 'https://panel.example',
  token: 'token123',
  options: { ...defaultAgentInstallOptions },
  instanceId: '33bc95df-513d-41be-8d98-30979fb17029',
  nodeName: 'node-123',
};

assert.equal(
  buildAgentInstallCommand({ platform: 'unix', ...base }),
  `wget -qO- 'https://raw.githubusercontent.com/${CF_MONITOR_REPOSITORY}/refs/heads/main/agent/install.sh' | sh -s -- '-s' 'https://panel.example' '-t' 'token123' '-n' 'node-123' '-i' '33bc95df-513d-41be-8d98-30979fb17029' '--mode' 'http'`,
);

assert.equal(
  buildAgentInstallCommand({
    platform: 'unix',
    ...base,
    options: { ...defaultAgentInstallOptions, trafficResetDay: '15', downloadProxy: '127.0.0.1:10808' },
  }),
  `wget -qO- 'https://raw.githubusercontent.com/${CF_MONITOR_REPOSITORY}/refs/heads/main/agent/install.sh' | sh -s -- '-s' 'https://panel.example' '-t' 'token123' '-r' '15' '-n' 'node-123' '-i' '33bc95df-513d-41be-8d98-30979fb17029' '--mode' 'http' '--proxy' 'http://127.0.0.1:10808'`,
);

assert.equal(
  buildAgentInstallCommand({
    platform: 'unix',
    ...base,
    options: { ...defaultAgentInstallOptions, installMode: 'user' },
  }),
  `wget -qO- 'https://raw.githubusercontent.com/${CF_MONITOR_REPOSITORY}/refs/heads/main/agent/install.sh' | sh -s -- '-s' 'https://panel.example' '-t' 'token123' '-n' 'node-123' '-i' '33bc95df-513d-41be-8d98-30979fb17029' '--mode' 'http' '--install-mode' 'user'`,
);

assert.equal(
  buildAgentUninstallAllCommand({ platform: 'unix' }),
  `wget -qO- 'https://raw.githubusercontent.com/${CF_MONITOR_REPOSITORY}/refs/heads/main/agent/install.sh' | sh -s -- '--uninstall-all' '--yes'`,
);

// Panel-hosted scripts retain the EO Agent features and bypass a GitHub-only proxy.
const panelOptions = { ...defaultAgentInstallOptions, ghproxy: 'https://github-proxy.example' };
const panelInstall = buildAgentInstallCommand({ platform: 'unix', ...base, options: panelOptions, scriptBase: 'panel.example/agent///' });
assert.ok(panelInstall.startsWith("wget -qO- 'https://panel.example/agent/install.sh' | sh"));
assert.ok(panelInstall.includes("'--install-ghproxy' 'https://github-proxy.example'"));
const panelUninstall = buildAgentUninstallAllCommand({ platform: 'unix', serverUrl: 'panel.example/path', ghproxy: panelOptions.ghproxy });
assert.ok(panelUninstall.startsWith("wget -qO- 'https://panel.example/agent/install.sh' | sh"));
assert.ok(panelUninstall.includes("'--uninstall-all' '--yes'"));
const windowsCommand = buildAgentInstallCommand({ platform: 'windows', ...base, scriptBase: 'https://panel.example/agent/' });
const windowsScript = Buffer.from(windowsCommand.split(' -EncodedCommand ')[1], 'base64').toString('utf16le');
assert.ok(windowsScript.includes("iwr 'https://panel.example/agent/install-windows.ps1'"));
assert.ok(windowsScript.includes("'-Mode' 'http'") || windowsScript.includes("-Mode 'http'"));
const windowsUninstall = buildAgentUninstallAllCommand({ platform: 'windows', serverUrl: 'https://panel.example' });
assert.ok(Buffer.from(windowsUninstall.split(' -EncodedCommand ')[1], 'base64').toString('utf16le')
  .includes("iwr 'https://panel.example/agent/install-windows.ps1'"));
const invalidBase = buildAgentInstallCommand({ platform: 'unix', ...base, scriptBase: 'https://user:password@bad.example/agent' });
assert.ok(!invalidBase.includes('password'));
assert.ok(invalidBase.includes('raw.githubusercontent.com'));

await rm(tmp, { recursive: true, force: true });
