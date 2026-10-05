export type LimitedBodyResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: 'too_large' };

export type LimitedJsonResult =
  | { ok: true; body: unknown }
  | { ok: false; reason: 'too_large' | 'invalid_json' };

const encoder = new TextEncoder();

function requestChunkBytes(value: unknown): Uint8Array {
  // EO readers also return strings and raw buffers; TypedArray.set does not
  // copy bytes from an ArrayBuffer or DataView directly.
  if (typeof value === 'string') return encoder.encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError('Unsupported request body chunk type');
}

export async function readRequestBytesWithLimit(request: Request, maxBytes: number): Promise<LimitedBodyResult> {
  const declaredLength = Number(request.headers.get('Content-Length') || '0');
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    return { ok: false, reason: 'too_large' };
  }

  const stream = request.body;
  if (!stream) return { ok: true, bytes: new Uint8Array() };

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = requestChunkBytes(value);
      total += chunk.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: 'too_large' };
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

export async function readJsonWithLimit(
  request: Request,
  maxBytes: number,
  options: { emptyValue?: unknown } = {},
): Promise<LimitedJsonResult> {
  const body = await readRequestBytesWithLimit(request, maxBytes);
  if (!body.ok) return body;
  const text = new TextDecoder().decode(body.bytes);
  if (text.trim() === '' && 'emptyValue' in options) return { ok: true, body: options.emptyValue };
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }
}
