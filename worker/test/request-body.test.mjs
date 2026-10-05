import assert from 'node:assert/strict';
import test from 'node:test';
import { readJsonWithLimit, readRequestBytesWithLimit } from '../src/utils/request-body.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function streamedRequest(chunks, { keepOpen = false } = {}) {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      if (!keepOpen) controller.close();
    },
    cancel() { cancelled = true; },
  });
  // EdgeOne's documented body chunks include strings, ArrayBuffers and views;
  // the Node Request implementation alone would only exercise Uint8Array.
  return { request: { headers: new Headers(), body }, get cancelled() { return cancelled; } };
}

test('Uint8Array JSON request chunks retain their complete UTF-8 payload', async () => {
  const payload = { name: '节点', temperature: 23 };
  const bytes = encoder.encode(JSON.stringify(payload));
  const { request } = streamedRequest([bytes.subarray(0, 4), bytes.subarray(4)]);
  assert.deepEqual(await readJsonWithLimit(request, 1024), { ok: true, body: payload });
});

test('ArrayBuffer JSON request chunks are copied as bytes', async () => {
  const bytes = encoder.encode('{"username":"admin","password":"valid-password-123"}');
  const { request } = streamedRequest([bytes.buffer.slice(0)]);
  assert.deepEqual(await readJsonWithLimit(request, 1024), {
    ok: true, body: { username: 'admin', password: 'valid-password-123' },
  });
});

test('DataView chunks honor a nonzero offset and exclude unrelated backing-buffer bytes', async () => {
  const bytes = encoder.encode('{"name":"节点"}');
  const storage = new Uint8Array(bytes.byteLength + 8);
  storage.fill(0xff);
  storage.set(bytes, 3);
  const view = new DataView(storage.buffer, 3, bytes.byteLength);
  const { request } = streamedRequest([view]);
  assert.deepEqual(await readJsonWithLimit(request, 1024), { ok: true, body: { name: '节点' } });
});

for (const View of [Uint16Array, Float32Array]) {
  test(`${View.name} chunks preserve raw bytes rather than numeric element values`, async () => {
    const text = '{"x":1} '; // Eight bytes fit either view without padding the payload.
    const storage = new Uint8Array(16);
    storage.fill(0xff);
    storage.set(encoder.encode(text), 4);
    const view = new View(storage.buffer, 4, 8 / View.BYTES_PER_ELEMENT);
    const { request } = streamedRequest([view]);
    const result = await readRequestBytesWithLimit(request, 8);
    assert.equal(result.ok, true);
    assert.equal(decoder.decode(result.bytes), text);
  });
}

test('string and binary chunks can form one valid UTF-8 JSON request', async () => {
  const { request } = streamedRequest(['{"name":"', encoder.encode('节点'), '🌡️","temperature":23', '}']);
  assert.deepEqual(await readJsonWithLimit(request, 1024), {
    ok: true, body: { name: '节点🌡️', temperature: 23 },
  });
});

test('UTF-8 codepoints split across byte chunks survive concatenation', async () => {
  const payload = { message: '节点🌡️' };
  const bytes = encoder.encode(JSON.stringify(payload));
  const chunks = Array.from(bytes, value => new Uint8Array([value]));
  const { request } = streamedRequest(chunks);
  assert.deepEqual(await readJsonWithLimit(request, bytes.byteLength), { ok: true, body: payload });
});

test('the byte budget accepts its exact UTF-8 boundary', async () => {
  const { request } = streamedRequest(['"界', '"']);
  assert.deepEqual(await readJsonWithLimit(request, 5), { ok: true, body: '界' });
});

test('an accumulated byte budget overflow cancels the body reader', { timeout: 1000 }, async () => {
  const fixture = streamedRequest([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])], { keepOpen: true });
  assert.deepEqual(await readRequestBytesWithLimit(fixture.request, 5), { ok: false, reason: 'too_large' });
  assert.equal(fixture.cancelled, true);
});

test('string chunks are measured in UTF-8 bytes and cancelled when over budget', { timeout: 1000 }, async () => {
  const fixture = streamedRequest(['"界', '"'], { keepOpen: true });
  assert.deepEqual(await readRequestBytesWithLimit(fixture.request, 4), { ok: false, reason: 'too_large' });
  assert.equal(fixture.cancelled, true);
});

test('genuinely malformed JSON retains the invalid_json result used for HTTP 400', async () => {
  const { request } = streamedRequest([encoder.encode(String.raw`{"recovery_key":"masked\*\*"}`)]);
  assert.deepEqual(await readJsonWithLimit(request, 1024), { ok: false, reason: 'invalid_json' });
});

for (const invalid of [42, { unexpected: 'chunk' }]) {
  test(`unsupported ${typeof invalid} request chunk throws TypeError`, async () => {
    const { request } = streamedRequest([invalid]);
    await assert.rejects(readRequestBytesWithLimit(request, 1024), TypeError);
  });
}
