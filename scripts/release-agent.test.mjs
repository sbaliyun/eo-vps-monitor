import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporaryRoot = join(root, 'worker', '.tmp', 'audit-release-tests');
const workflow = await readFile(new URL('../.github/workflows/release-agent.yml', import.meta.url), 'utf8');

function releaseCommands(source) {
  const lines = source.split(/\r?\n/);
  const selected = [];
  let name = '';
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^      - name: (.+)$/);
    if (match) name = match[1];
    if (!/^        run: \|/.test(lines[index]) || !/immutable|release tags|Verify published/i.test(name)) continue;
    const script = [];
    while (++index < lines.length && (/^          /.test(lines[index]) || !lines[index].trim())) script.push(lines[index].slice(10));
    index -= 1;
    selected.push(script.join('\n'));
  }
  assert.ok(selected.length >= 2, 'exercise the real release workflow commands');
  return selected.join('\n');
}

async function fixture({
  tag = false,
  release = false,
  failUpload = false,
  badDigest = false,
  version = 'v9.0.0',
  eventName = 'workflow_dispatch',
  ref = 'refs/heads/main',
  tagSha = 'b'.repeat(40),
  annotated = false,
  tagQueryFailure = 0,
  tagMoves = 0,
} = {}) {
  await mkdir(temporaryRoot, { recursive: true });
  const directory = await mkdtemp(join(temporaryRoot, 'run-'));
  try {
    const agent = join(directory, 'agent');
    await mkdir(join(agent, 'dist'), { recursive: true });
    const content = Buffer.from('synthetic release binary');
    await writeFile(join(agent, 'dist', 'agent-fixture'), content);
    const metadata = join(directory, 'remote.json');
    await writeFile(metadata, JSON.stringify({ tag_name: version, target_commitish: 'a'.repeat(40), draft: true,
      assets: [{ name: 'agent-fixture', size: content.length, digest: `sha256:${badDigest ? '0'.repeat(64) : createHash('sha256').update(content).digest('hex')}` }] }));
    const log = join(directory, 'commands.log');
    await writeFile(log, '');
    // Command substitutions run in subshells, so query state must outlive them.
    const tagQueryCount = join(directory, 'tag-query-count');
    await writeFile(tagQueryCount, '0');
    const script = join(directory, 'fixture.sh');
    await writeFile(script, `
set -euo pipefail
git() {
  printf 'git' >> "$AUDIT_COMMAND_LOG"; printf ' %s' "$@" >> "$AUDIT_COMMAND_LOG"; printf '\\n' >> "$AUDIT_COMMAND_LOG"
  case "$1" in
    ls-remote)
      local query_count resolved_sha argument emitted
      query_count="$(cat "$TAG_QUERY_COUNT")"
      query_count=$((query_count + 1))
      printf '%s' "$query_count" > "$TAG_QUERY_COUNT"
      if [ "$TAG_QUERY_FAILURE" -ne 0 ]; then return "$TAG_QUERY_FAILURE"; fi
      if [ "$TAG_PRESENT" != 1 ]; then return 2; fi
      resolved_sha="$TAG_SHA"
      if [ "$TAG_MOVES_AFTER" -gt 0 ] && [ "$query_count" -gt "$TAG_MOVES_AFTER" ]; then
        resolved_sha="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      fi
      emitted=0
      for argument in "$@"; do
        case "$argument" in
          "refs/tags/$AGENT_VERSION")
            if [ "$TAG_ANNOTATED" = 1 ]; then
              printf '%s\\t%s\\n' "cccccccccccccccccccccccccccccccccccccccc" "$argument"
            else
              printf '%s\\t%s\\n' "$resolved_sha" "$argument"
            fi
            emitted=1 ;;
          "refs/tags/$AGENT_VERSION^{}")
            if [ "$TAG_ANNOTATED" = 1 ]; then
              printf '%s\\t%s\\n' "$resolved_sha" "$argument"
              emitted=1
            fi ;;
        esac
      done
      if [ "$emitted" = 1 ]; then return 0; else return 2; fi ;;
    tag) TAG_PRESENT=1; TAG_SHA="$GITHUB_SHA" ;;
    config|push) return 0 ;;
    rev-parse) printf '%s\\n' "$GITHUB_SHA" ;;
    *) printf 'Unexpected git call\\n' >&2; return 99 ;;
  esac
}
gh() {
  printf 'gh' >> "$AUDIT_COMMAND_LOG"; printf ' %s' "$@" >> "$AUDIT_COMMAND_LOG"; printf '\\n' >> "$AUDIT_COMMAND_LOG"
  if [ "$1" = api ]; then
    if [[ "$*" == *--paginate* ]]; then [ "$RELEASE_PRESENT" = 0 ] || printf '%s\\n' "$AGENT_VERSION"; return 0; fi
    if [[ "$2" == *"/releases/tags/"* ]]; then printf 'Draft releases are not returned by the published-tag endpoint\\n' >&2; return 1; fi
    cat "$REMOTE_RELEASE_JSON"; return 0
  fi
  case "$2" in
    view) if [ "$RELEASE_PRESENT" = 1 ]; then
      if [[ "$*" == *"--json databaseId"* ]]; then printf '123456\\n'; else cat "$REMOTE_RELEASE_JSON"; fi
      return 0
      else printf 'release not found\\n' >&2; return 1; fi ;;
    create) RELEASE_PRESENT=1 ;;
    upload) if [ "$FAIL_UPLOAD" = 1 ]; then return 1; fi ;;
    edit) return 0 ;;
    *) printf 'Unexpected gh call\\n' >&2; return 99 ;;
  esac
}
node() {
  if [ "$1" != ../scripts/verify-release-assets.mjs ]; then return 99; fi
  shift
  "$NODE_EXECUTABLE" "$REAL_VERIFY_SCRIPT" "$@"
}
${releaseCommands(workflow)}
`);
    const bash = process.platform === 'win32'
      ? join(dirname(dirname(spawnSync('where.exe', ['git'], { encoding: 'utf8' }).stdout.trim().split(/\r?\n/)[0])), 'bin', 'bash.exe')
      : 'bash';
    const result = spawnSync(bash, ['--noprofile', '--norc', script], {
      cwd: agent, encoding: 'utf8', timeout: 20_000,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: directory,
        AGENT_VERSION: version, AGENT_VERSION_TAG: version, GITHUB_SHA: 'a'.repeat(40), GITHUB_REPOSITORY: 'synthetic/repo',
        GITHUB_EVENT_NAME: eventName, GITHUB_REF: ref,
        GITHUB_ENV: join(directory, 'github-env'), RUNNER_TEMP: directory, GH_TOKEN: 'synthetic-token',
        AUDIT_COMMAND_LOG: log, REMOTE_RELEASE_JSON: metadata, NODE_EXECUTABLE: process.execPath,
        REAL_VERIFY_SCRIPT: join(root, 'scripts', 'verify-release-assets.mjs'),
        TAG_PRESENT: tag ? '1' : '0', TAG_SHA: tagSha, TAG_ANNOTATED: annotated ? '1' : '0',
        TAG_QUERY_COUNT: tagQueryCount, TAG_QUERY_FAILURE: String(tagQueryFailure === true ? 128 : tagQueryFailure),
        TAG_MOVES_AFTER: String(tagMoves === true ? 1 : tagMoves),
        RELEASE_PRESENT: release ? '1' : '0', FAIL_UPLOAD: failUpload ? '1' : '0' },
    });
    assert.ifError(result.error);
    return { status: result.status, output: result.stdout + result.stderr, commands: await readFile(log, 'utf8') };
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(temporaryRoot) + sep), 'temporary cleanup stays in its named workspace directory');
    await rm(directory, { recursive: true, force: true });
  }
}

test('AUD-18 existing tag or published assets are never replaced by the current checkout', async () => {
  for (const state of [
    { tag: true },
    { tag: true, tagSha: 'a'.repeat(40) },
    { tag: true, tagSha: 'a'.repeat(40), annotated: true },
    { release: true },
    { tag: true, release: true },
  ]) {
    const result = await fixture(state);
    assert.notEqual(result.status, 0, 'a used immutable version must be rejected');
    assert.doesNotMatch(result.commands, /gh release (upload|edit|create)/, 'rejection happens before release mutation');
  }
});

test('tag-triggered lightweight and annotated releases reuse the matching immutable tag', async () => {
  for (const annotated of [false, true]) {
    const result = await fixture({
      tag: true,
      tagSha: 'a'.repeat(40),
      annotated,
      eventName: 'push',
      ref: 'refs/tags/v9.0.0',
    });
    assert.equal(result.status, 0, result.output);
    assert.doesNotMatch(result.commands, /^git (?:tag|push)\s/m, 'the triggering tag must not be recreated or pushed');
    assert.match(result.commands, /gh release create[^\n]*--draft/);
    assert.match(result.commands, /gh release edit v9\.0\.0 --draft=false/);
    assert.doesNotMatch(result.commands, /--force|--clobber/);
  }
});

test('tag-triggered releases reject another commit, a missing tag and a mismatched trigger ref', async () => {
  const trigger = { tag: true, tagSha: 'a'.repeat(40), eventName: 'push', ref: 'refs/tags/v9.0.0' };
  for (const state of [
    { tagSha: 'b'.repeat(40) },
    { tagSha: 'b'.repeat(40), annotated: true },
    { tag: false },
    { ref: 'refs/heads/main' },
    { ref: 'refs/tags/v9.0.1' },
  ]) {
    const result = await fixture({ ...trigger, ...state });
    assert.notEqual(result.status, 0, result.output);
    assert.doesNotMatch(result.commands, /^git (?:tag|push)\s/m);
    assert.doesNotMatch(result.commands, /gh release (?:create|upload|edit)\s/, 'rejection must precede release mutation');
  }
});

test('tag-triggered releases reject both published releases and drafts', async () => {
  for (const release of ['published', 'draft']) {
    const result = await fixture({
      tag: true,
      tagSha: 'a'.repeat(40),
      eventName: 'push',
      ref: 'refs/tags/v9.0.0',
      release,
    });
    assert.notEqual(result.status, 0, result.output);
    assert.doesNotMatch(result.commands, /^git (?:tag|push)\s/m);
    assert.doesNotMatch(result.commands, /gh release (?:create|upload|edit)\s/);
  }
});

test('release tag queries fail closed on network errors for both trigger modes', async () => {
  for (const eventName of ['workflow_dispatch', 'push']) {
    const result = await fixture({
      tag: true,
      tagSha: 'a'.repeat(40),
      eventName,
      ref: eventName === 'push' ? 'refs/tags/v9.0.0' : 'refs/heads/main',
      tagQueryFailure: 128,
    });
    assert.notEqual(result.status, 0, result.output);
    assert.doesNotMatch(result.commands, /^git (?:tag|push)\s/m);
    assert.doesNotMatch(result.commands, /gh release (?:create|upload|edit)\s/);
  }
});

test('a triggering tag moved after validation cannot create or publish a release', async () => {
  for (const annotated of [false, true]) {
    for (const tagMoves of [1, 2]) {
      const result = await fixture({
        tag: true,
        tagSha: 'a'.repeat(40),
        annotated,
        eventName: 'push',
        ref: 'refs/tags/v9.0.0',
        tagMoves,
      });
      assert.notEqual(result.status, 0, result.output);
      assert.doesNotMatch(result.commands, /^git (?:tag|push)\s/m);
      assert.doesNotMatch(result.commands, /gh release (?:create|upload|edit)\s/, 'each remote recheck must reject a moved tag');
    }
  }
});

test('AUD-18 a new release remains draft until uploaded bytes match their recorded digests', async () => {
  const result = await fixture();
  assert.equal(result.status, 0, result.output);
  assert.doesNotMatch(result.commands, /--clobber/);
  assert.match(result.commands, /gh release create[^\n]*--draft/);
  assert.match(result.commands, /gh api repos\/synthetic\/repo\/releases\/123456/);
  assert.match(result.commands, /gh release edit[^\n]*--draft=false/);
});

test('AUD-18 interrupted upload or mismatched remote digest cannot publish the draft', async () => {
  for (const state of [{ failUpload: true }, { badDigest: true }]) {
    const result = await fixture(state);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.commands, /gh release edit[^\n]*--draft=false/);
  }
});

test('R-A09 build metadata keeps tag identity while draft assets are read by release ID', async () => {
  const result = await fixture({ version: 'v9.0.0-rc.1+build.7' });
  assert.equal(result.status, 0, result.output);
  assert.match(result.commands, /git tag v9\.0\.0-rc\.1\+build\.7 /);
  assert.match(result.commands, /gh release view v9\.0\.0-rc\.1\+build\.7[^\n]*--json databaseId/);
  assert.match(result.commands, /gh api repos\/synthetic\/repo\/releases\/123456/);
  assert.match(result.commands, /gh release edit v9\.0\.0-rc\.1\+build\.7 --draft=false/);
});
