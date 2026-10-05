// Leave room below EdgeOne's 1 MiB request limit for multipart and JSON envelopes.
export const EDGEONE_MAX_UPLOAD_REQUEST_BYTES = 900 * 1024;
export const EDGEONE_MAX_UPLOAD_FILE_BYTES = 800 * 1024;
// Base64 adds roughly one third, so a 600 KiB image stays below our 900 KiB KV budget.
export const EDGEONE_MAX_SITE_LOGO_BYTES = 600 * 1024;
export const EDGEONE_MAX_CRYPTO_BYTES = 1024 * 1024;
