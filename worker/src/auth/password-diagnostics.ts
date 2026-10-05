import { hashPassword, verifyPassword } from './password';

export type PasswordCryptoStage = 'known_vector' | 'hash_password' | 'verify_roundtrip';
export type PasswordCryptoStatus = {
  ok: boolean;
  error?: string;
  diagnostic?: { stage: PasswordCryptoStage; message: string; stack: string };
};

const PUBLIC_PASSWORD = 'edgeone-public-password-diagnostic-v1';
// Node crypto.pbkdf2Sync: salt bytes 0..15, 10,000 iterations, SHA-256, 32 bytes.
const KNOWN_HASH = 'pbkdf2_sha256$10000$AAECAwQFBgcICQoLDA0ODw==$Y/hPmIndnWw5a1r0tN3mdo4GnQ9AFCF/tTKX/Gd3LPQ=';

function errorField(error: unknown, field: 'name' | 'message' | 'stack', fallback: string): string {
  try {
    if (error !== null && (typeof error === 'object' || typeof error === 'function')) {
      const value = (error as Record<string, unknown>)[field];
      if (typeof value === 'string') return value;
    }
  } catch {
    // Native and cross-realm crypto exceptions can expose throwing getters.
  }
  return fallback;
}

function diagnosticText(text: string, roundtripHash: string): string {
  const values = [PUBLIC_PASSWORD, KNOWN_HASH, roundtripHash,
    ...KNOWN_HASH.split('$').slice(2), ...roundtripHash.split('$').slice(2)];
  let result = text;
  for (const value of values.filter(Boolean).sort((a, b) => b.length - a.length)) {
    result = result.replaceAll(value, '[redacted]');
  }
  return result.replace(/pbkdf2_sha256\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+/g, '[redacted]');
}

/** Validate native password crypto using public fixtures and an in-memory hash only. */
export async function checkPasswordCrypto(): Promise<PasswordCryptoStatus> {
  let stage: PasswordCryptoStage = 'known_vector';
  let roundtripHash = '';
  try {
    if (!await verifyPassword(PUBLIC_PASSWORD, KNOWN_HASH)) {
      const error = new Error('Known PBKDF2 test vector did not verify');
      error.name = 'PasswordKnownVectorError';
      throw error;
    }
    stage = 'hash_password';
    roundtripHash = await hashPassword(PUBLIC_PASSWORD);
    stage = 'verify_roundtrip';
    if (!await verifyPassword(PUBLIC_PASSWORD, roundtripHash)) {
      const error = new Error('In-memory password hash did not verify');
      error.name = 'PasswordRoundtripError';
      throw error;
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: diagnosticText(errorField(error, 'name', 'PasswordCryptoError'), roundtripHash).slice(0, 100),
      diagnostic: {
        stage,
        message: diagnosticText(errorField(error, 'message', typeof error === 'string' ? error : 'Unknown password crypto error'), roundtripHash).slice(0, 400),
        stack: diagnosticText(errorField(error, 'stack', ''), roundtripHash).slice(0, 1500),
      },
    };
  }
}
