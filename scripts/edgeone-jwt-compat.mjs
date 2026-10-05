import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const EXPECTED_HONO_VERSION = '4.13.7';
const EXPECTED_IS_CRYPTO_KEY = `function isCryptoKey(key) {
  const runtime = getRuntimeKey();
  if (runtime === "node" && !!crypto.webcrypto) {
    return key instanceof crypto.webcrypto.CryptoKey;
  }
  return key instanceof CryptoKey;
}`;
const COMPATIBLE_IS_CRYPTO_KEY = `function isCryptoKey(key) {
  // Primitive JWT secrets cannot be CryptoKey instances. EdgeOne may omit
  // the global CryptoKey constructor while still providing crypto.subtle.
  if (key === null || (typeof key !== "object" && typeof key !== "function")) {
    return false;
  }
  const runtime = getRuntimeKey();
  if (runtime === "node" && !!crypto.webcrypto) {
    return key instanceof crypto.webcrypto.CryptoKey;
  }
  return key instanceof CryptoKey;
}`;
const EXPECTED_HMAC_ALGORITHMS = `function getKeyAlgorithm(name) {
  switch (name) {
    case "HS256":
      return {
        name: "HMAC",
        hash: {
          name: "SHA-256"
        }
      };
    case "HS384":
      return {
        name: "HMAC",
        hash: {
          name: "SHA-384"
        }
      };
    case "HS512":
      return {
        name: "HMAC",
        hash: {
          name: "SHA-512"
        }
      };`;
// EO accepts SHA identifiers as strings but rejects the equivalent nested
// object during HMAC key import. Keep Hono's signing/verification algorithms.
const COMPATIBLE_HMAC_ALGORITHMS = EXPECTED_HMAC_ALGORITHMS.replace(
  /hash: \{\n          name: "(SHA-(?:256|384|512))"\n        \}/g,
  'hash: "$1"',
);

export function patchHonoJws(source, packageInfo) {
  if (packageInfo.name !== 'hono' || packageInfo.version !== EXPECTED_HONO_VERSION) {
    throw new Error(`EdgeOne JWT compatibility requires hono@${EXPECTED_HONO_VERSION}; review the adapter before upgrading`);
  }
  const occurrences = source.split(EXPECTED_IS_CRYPTO_KEY).length - 1;
  if (occurrences !== 1) {
    throw new Error('Hono isCryptoKey source changed; review the EdgeOne JWT compatibility adapter');
  }
  if (source.split(EXPECTED_HMAC_ALGORITHMS).length - 1 !== 1) {
    throw new Error('Hono HMAC algorithm source changed; review the EdgeOne JWT compatibility adapter');
  }
  return source
    .replace(EXPECTED_IS_CRYPTO_KEY, COMPATIBLE_IS_CRYPTO_KEY)
    .replace(EXPECTED_HMAC_ALGORITHMS, COMPATIBLE_HMAC_ALGORITHMS);
}

export function honoCryptoKeyCompatibilityPlugin() {
  let patchedModules = 0;
  return {
    name: 'edgeone-hono-crypto-key-compatibility',
    setup(build) {
      build.onStart(() => { patchedModules = 0; });
      build.onLoad({ filter: /[\\/]node_modules[\\/]hono[\\/]dist[\\/]utils[\\/]jwt[\\/]jws\.js$/ }, async args => {
        const [source, packageText] = await Promise.all([
          readFile(args.path, 'utf8'),
          readFile(resolve(dirname(args.path), '../../../package.json'), 'utf8'),
        ]);
        const contents = patchHonoJws(source, JSON.parse(packageText));
        patchedModules += 1;
        return { contents, loader: 'js', resolveDir: dirname(args.path) };
      });
      build.onEnd(() => {
        if (patchedModules !== 1) {
          return { errors: [{ text: `Expected one Hono JWT compatibility patch, applied ${patchedModules}; review the EdgeOne bundle` }] };
        }
        return {};
      });
    },
  };
}
