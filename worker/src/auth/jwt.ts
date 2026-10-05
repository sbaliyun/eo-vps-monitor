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

export async function checkSessionCrypto(env: JwtEnv): Promise<{ ok: boolean; error?: string }> {
  // Exercise the deployed signing and verification path without exposing a
  // token, setting cookies or creating a KV account. This id is not a UUID.
  const probeId = '__edgeone_session_health__';
  try {
    const token = await generateToken(probeId, 'runtime-health', 1, env);
    const identity = await verifyAdminToken(token, env);
    return identity?.userId === probeId
      ? { ok: true }
      : { ok: false, error: 'SessionVerificationError' };
  } catch (error) {
    // Report only the exception class; crypto errors may contain a token.
    return { ok: false, error: error instanceof Error ? error.name : 'CryptoRuntimeError' };
  }
}
