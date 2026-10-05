export type LoginErrorDiagnostic = {
  stage: string;
  error: string;
  message: string;
  stack: string;
};

function errorField(error: unknown, field: 'name' | 'message' | 'stack', fallback: string): string {
  try {
    if (error && (typeof error === 'object' || typeof error === 'function')) {
      const value = (error as Record<string, unknown>)[field];
      if (typeof value === 'string') return value;
    }
  } catch {
    // Native and cross-realm errors may expose throwing property accessors.
  }
  return fallback;
}

function sensitiveVariants(values: readonly string[]): Set<string> {
  const variants = new Set<string>();
  for (const value of values) {
    if (typeof value === 'string' && value) {
      variants.add(value);
      if (value.trim()) variants.add(value.trim());
    }
  }

  for (const value of [...variants]) {
    const passwordHash = /^pbkdf2_sha256\$\d+\$([^$]+)\$([^$]+)$/i.exec(value);
    const token = /^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(value);
    const components = passwordHash ? passwordHash.slice(1) : token ? value.split('.') : [];
    for (const component of components) {
      if (!component) continue;
      variants.add(component);
      const base64 = component.replace(/-/g, '+').replace(/_/g, '/');
      const urlBase64 = base64.replace(/\+/g, '-').replace(/\//g, '_');
      variants.add(base64);
      variants.add(base64.replace(/=+$/, ''));
      variants.add(urlBase64);
      variants.add(urlBase64.replace(/=+$/, ''));
      const padded = base64 + '='.repeat((4 - base64.length % 4) % 4);
      variants.add(padded);
      variants.add(padded.replace(/\+/g, '-').replace(/\//g, '_'));
      try {
        const binary = atob(padded);
        const hex = Array.from(binary, byte => byte.charCodeAt(0).toString(16).padStart(2, '0')).join('');
        if (hex) {
          variants.add(hex);
          variants.add(hex.toUpperCase());
        }
      } catch {
        // A non-base64 component still receives text and encoding redactions.
      }
    }
  }

  for (const value of [...variants]) {
    variants.add(JSON.stringify(value).slice(1, -1));
    for (const encode of [encodeURIComponent, encodeURI]) {
      try {
        const encoded = encode(value);
        variants.add(encoded);
        variants.add(encoded.replace(/%[0-9A-F]{2}/g, part => part.toLowerCase()));
      } catch {
        // A malformed surrogate has no URI representation.
      }
    }

    const bytes = new TextEncoder().encode(value);
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    variants.add(hex);
    variants.add(hex.toUpperCase());
    try {
      const encoded = btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
      const urlEncoded = encoded.replace(/\+/g, '-').replace(/\//g, '_');
      variants.add(encoded);
      variants.add(encoded.replace(/=+$/, ''));
      variants.add(urlEncoded);
      variants.add(urlEncoded.replace(/=+$/, ''));
    } catch {
      // Keep the remaining redactions if the runtime has no base64 encoder.
    }
  }
  return variants;
}

function redact(text: string, variants: ReadonlySet<string>): string {
  const sensitive = new Set(variants);
  // JWT payloads can be short and an unsigned JWT can have an empty signature.
  // Also mask hashes when the caller did not supply the original credentials.
  const patterns = [
    /\beyJ[A-Za-z0-9_-]{7,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g,
    /\bpbkdf2_sha256\$\d+\$[A-Za-z0-9+/_=-]+\$[A-Za-z0-9+/_=-]+/gi,
    /\bpbkdf2_sha256%24\d+%24(?:[A-Za-z0-9_-]|%[0-9a-f]{2})+%24(?:[A-Za-z0-9_-]|%[0-9a-f]{2})+/gi,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) sensitive.add(match[0]);
  }

  let result = text;
  // Replace whole values first, including overlapping token/hash matches.
  for (const value of [...sensitive].sort((left, right) => right.length - left.length)) {
    if (value) result = result.replaceAll(value, '[redacted]');
  }
  return result;
}

export function loginErrorDiagnostic(
  stage: string,
  error: unknown,
  sensitive: readonly string[] = [],
): LoginErrorDiagnostic {
  const variants = sensitiveVariants(sensitive);
  const name = errorField(error, 'name', 'LoginRuntimeError');
  const message = errorField(error, 'message', typeof error === 'string' ? error : 'Unknown login error');
  const stack = errorField(error, 'stack', '');
  // Redact before truncating so a partial credential cannot survive a boundary.
  return {
    stage: redact(stage, variants).slice(0, 100),
    error: redact(name, variants).slice(0, 100),
    message: redact(message, variants).slice(0, 400),
    stack: redact(stack, variants).slice(0, 2000),
  };
}
