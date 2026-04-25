// AES-256-GCM encryption for OAuth tokens at rest.
//
// We never send raw tokens over the wire to the browser, and they never
// appear in API responses. But the data blob is stored in Postgres, so
// if someone dumps the database we don't want the refresh tokens sitting
// there in plaintext — they'd give unbounded access to that user's
// calendar until the user manually revokes the app on Google/Microsoft
// (which most people never do).
//
// Format of the ciphertext blob returned by encryptSecret():
//   base64( [12 bytes IV] [16 bytes auth tag] [N bytes ciphertext] )
// This is a self-contained package: decrypt reads the IV and tag back
// off the front, so rotating the key just means re-encrypting every
// stored secret once. A version byte is prepended so that if we ever
// switch algorithms we can recognize old payloads.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION_BYTE = 0x01; // v1 = AES-256-GCM with 12-byte IV + 16-byte tag
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const ALGO = "aes-256-gcm";

let cachedKey = null;
let cachedKeyFingerprint = "";

function resolveKey() {
  const raw = String(process.env.INTEGRATION_TOKEN_ENCRYPTION_KEY || "").trim();
  if (!raw) {
    throw new Error(
      "INTEGRATION_TOKEN_ENCRYPTION_KEY is not set. Generate one with " +
        "`node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"` " +
        "and add it to your .env file."
    );
  }

  if (cachedKey && cachedKeyFingerprint === raw) {
    return cachedKey;
  }

  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(
      `INTEGRATION_TOKEN_ENCRYPTION_KEY must decode to 32 bytes (got ${key.length}). ` +
        "Use a fresh 32-byte random value encoded as base64."
    );
  }

  cachedKey = key;
  cachedKeyFingerprint = raw;
  return key;
}

export function encryptSecret(plaintext) {
  if (plaintext == null || plaintext === "") {
    return null;
  }

  const key = resolveKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGO, key, iv);
  const cipherBytes = Buffer.concat([
    cipher.update(String(plaintext), "utf8"),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();

  // [version][iv][tag][ciphertext] — single flat buffer, base64 encoded.
  const payload = Buffer.concat([Buffer.from([VERSION_BYTE]), iv, tag, cipherBytes]);
  return payload.toString("base64");
}

export function decryptSecret(ciphertext) {
  if (ciphertext == null || ciphertext === "") {
    return null;
  }

  const key = resolveKey();
  const payload = Buffer.from(String(ciphertext), "base64");
  if (payload.length < 1 + IV_LENGTH + TAG_LENGTH) {
    throw new Error("Encrypted payload is too short to be valid.");
  }

  const version = payload[0];
  if (version !== VERSION_BYTE) {
    throw new Error(`Unrecognized encryption version byte: 0x${version.toString(16)}`);
  }

  const iv = payload.subarray(1, 1 + IV_LENGTH);
  const tag = payload.subarray(1 + IV_LENGTH, 1 + IV_LENGTH + TAG_LENGTH);
  const cipherBytes = payload.subarray(1 + IV_LENGTH + TAG_LENGTH);

  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(cipherBytes), decipher.final()]);
  return plaintext.toString("utf8");
}

// Non-throwing variant for display/logging paths where we'd rather drop
// the value than crash the request.
export function tryDecryptSecret(ciphertext) {
  try {
    return decryptSecret(ciphertext);
  } catch {
    return null;
  }
}

export function isEncryptionConfigured() {
  try {
    resolveKey();
    return true;
  } catch {
    return false;
  }
}
