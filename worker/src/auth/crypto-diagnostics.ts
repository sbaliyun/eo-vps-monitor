export type HmacProbeStage = 'import_sign_key' | 'sign' | 'import_verify_key' | 'verify';

export type HmacProbeResult = {
  name: 'hono_parameters' | 'string_hash' | 'string_algorithm';
  ok: boolean;
  stage?: HmacProbeStage;
  error?: { name: string; message: string; stack: string };
};

function errorStringField(error: unknown, field: 'name' | 'message' | 'stack'): string | undefined {
  try {
    if (error !== null && (typeof error === 'object' || typeof error === 'function')) {
      const value = (error as Record<string, unknown>)[field];
      if (typeof value === 'string') return value;
    }
  } catch {
    // Native and cross-realm exceptions may expose fields through getters.
  }
  return undefined;
}

function diagnosticError(error: unknown): { name: string; message: string; stack: string } {
  let message = errorStringField(error, 'message');
  if (message === undefined) {
    try {
      message = String(error);
    } catch {
      message = 'Unknown crypto exception';
    }
  }
  return {
    name: (errorStringField(error, 'name') ?? 'Error').slice(0, 400),
    message: message.slice(0, 400),
    stack: (errorStringField(error, 'stack') ?? '').slice(0, 1500),
  };
}

/** Compare runtime parameter support without reading credentials or persisting data. */
export async function probeHmacRuntime(): Promise<HmacProbeResult[]> {
  const encoder = new TextEncoder();
  const keyBytes = encoder.encode('edgeone-public-hmac-diagnostic-key-v1');
  const messageBytes = encoder.encode('edgeone-public-hmac-diagnostic-message-v1');
  const cases = [
    { name: 'hono_parameters' as const, hash: { name: 'SHA-256' }, stringAlgorithm: false },
    { name: 'string_hash' as const, hash: 'SHA-256', stringAlgorithm: false },
    { name: 'string_algorithm' as const, hash: 'SHA-256', stringAlgorithm: true },
  ];
  const results: HmacProbeResult[] = [];
  for (const probe of cases) {
    const keyAlgorithm = { name: 'HMAC', hash: probe.hash };
    const signatureAlgorithm = probe.stringAlgorithm ? 'HMAC' : keyAlgorithm;
    let stage: HmacProbeStage = 'import_sign_key';
    try {
      // Match Hono's separate key imports and usages rather than widening them.
      const signingKey = await crypto.subtle.importKey('raw', keyBytes, keyAlgorithm, false, ['sign']);
      stage = 'sign';
      const signature = await crypto.subtle.sign(signatureAlgorithm, signingKey, messageBytes);
      stage = 'import_verify_key';
      const verificationKey = await crypto.subtle.importKey('raw', keyBytes, keyAlgorithm, false, ['verify']);
      stage = 'verify';
      const verified = await crypto.subtle.verify(signatureAlgorithm, verificationKey, signature, messageBytes);
      if (!verified) {
        const error = new Error('Synthetic HMAC verification returned false');
        error.name = 'HmacVerificationError';
        throw error;
      }
      results.push({ name: probe.name, ok: true });
    } catch (error) {
      results.push({ name: probe.name, ok: false, stage, error: diagnosticError(error) });
    }
  }
  return results;
}
