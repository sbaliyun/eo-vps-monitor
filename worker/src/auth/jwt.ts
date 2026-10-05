import { sign, verify } from 'hono/jwt';

const MIN_JWT_SECRET_BYTES = 32;

export class AuthConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthConfigurationError';
  }
}

type JwtEnv = {
  JWT_SECRET?: string;
};

export type AdminJwtPayload = {
  userId: string;
  username: string;
  sessionVersion: number;
};

export function requireJwtSecret(env: JwtEnv): string {
  const secret = env.JWT_SECRET?.trim() ?? '';
  const secretBytes = new TextEncoder().encode(secret).byteLength;

  if (secretBytes < MIN_JWT_SECRET_BYTES) {
    throw new AuthConfigurationError('JWT_SECRET must be at least 32 bytes');
  }

  return secret;
}

export async function generateToken(
  userId: string,
  username: string,
  sessionVersion: number,
  env: JwtEnv,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    kind: 'cf-monitor-session',
    purpose: 'admin-session',
    userId,
    username,
    sessionVersion,
    iat: now,
    exp: now + 7 * 24 * 60 * 60,
  };

  return sign(payload, requireJwtSecret(env), 'HS256');
}

export async function verifyAdminToken(token: string, env: JwtEnv): Promise<AdminJwtPayload | null> {
  const payload = await verify(token, requireJwtSecret(env), 'HS256');

  if (
    !payload ||
    payload.kind !== 'cf-monitor-session' ||
    payload.purpose !== 'admin-session' ||
    typeof payload.userId !== 'string' ||
    typeof payload.username !== 'string' ||
    typeof payload.sessionVersion !== 'number' ||
    !Number.isSafeInteger(payload.sessionVersion) ||
    payload.sessionVersion < 1
  ) {
    return null;
  }

  return {
    userId: payload.userId,
    username: payload.username,
    sessionVersion: payload.sessionVersion,
  };
}

export type SessionCryptoStatus = {
  ok: boolean;
  error?: string;
  diagnostic?: { stage: 'sign' | 'verify'; message: string; stack: string };
};

function redactSessionDiagnostic(text: string, secret: string, token: string): string {
  const sensitive = new Set([secret, secret.trim(), token]);
  for (const value of [...sensitive]) {
    if (value) {
      sensitive.add(JSON.stringify(value).slice(1, -1));
      try {
        sensitive.add(encodeURIComponent(value));
      } catch {
        // A malformed surrogate has no valid URI encoding.
      }
      const bytes = new TextEncoder().encode(value);
      const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
      sensitive.add(hex);
      sensitive.add(hex.toUpperCase());
      try {
        const encoded = btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
        sensitive.add(encoded);
        sensitive.add(encoded.replace(/=+$/, ''));
        sensitive.add(encoded.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
      } catch {
        // Keep reporting the original crypto error if base64 is unavailable.
      }
    }
  }
  let result = text;
  for (const value of [...sensitive].sort((a, b) => b.length - a.length)) {
    if (value) result = result.replaceAll(value, '[redacted]');
  }
  return result.replace(/\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[redacted-token]');
}

function cryptoErrorField(error: unknown, field: 'name' | 'message' | 'stack', fallback: string): string {
  try {
    if (error && (typeof error === 'object' || typeof error === 'function')) {
      const value = (error as Record<string, unknown>)[field];
      if (typeof value === 'string') return value;
    }
  } catch {
    // Native or cross-realm errors may expose throwing property accessors.
  }
  return fallback;
}

export async function checkSessionCrypto(env: JwtEnv): Promise<SessionCryptoStatus> {
  // Exercise the deployed signing and verification path without exposing a
  // token, setting cookies or creating a KV account. This id is not a UUID.
  const probeId = '__edgeone_session_health__';
  let stage: 'sign' | 'verify' = 'sign';
  let token = '';
  try {
    token = await generateToken(probeId, 'runtime-health', 1, env);
    stage = 'verify';
    const identity = await verifyAdminToken(token, env);
    return identity?.userId === probeId
      ? { ok: true }
      : { ok: false, error: 'SessionVerificationError' };
  } catch (error) {
    const secret = env.JWT_SECRET ?? '';
    const name = cryptoErrorField(error, 'name', 'CryptoRuntimeError');
    const message = cryptoErrorField(error, 'message', typeof error === 'string' ? error : 'Unknown crypto error');
    const stack = cryptoErrorField(error, 'stack', '');
    return {
      ok: false,
      error: redactSessionDiagnostic(name, secret, token).slice(0, 100),
      diagnostic: {
        stage,
        // Redact before truncating so a partial secret cannot remain at the boundary.
        message: redactSessionDiagnostic(message, secret, token).slice(0, 400),
        stack: redactSessionDiagnostic(stack, secret, token).slice(0, 2000),
      },
    };
  }
}
