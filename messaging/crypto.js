// AES-256-GCM encryption for chat message bodies at rest.
//
// Household members sending DMs or posting to the household channel
// write plaintext in their browser, but we never store that plaintext.
// Every message body is encrypted with the household-wide key before
// it lands in the database, and decrypted only when serving it back
// to an authenticated member of the conversation.
//
// We reuse the same encryption key (INTEGRATION_TOKEN_ENCRYPTION_KEY)
// that guards OAuth refresh tokens so there is exactly one secret to
// manage for the whole app. If you ever want to split messaging onto
// its own key, swap the env-var name below and re-encrypt existing
// rows by loading + re-saving them.
//
// Format of each stored ciphertext blob:
//   base64( [1 byte version][12 byte IV][16 byte auth tag][N byte ciphertext] )
// Identical framing to integrations/crypto.js so any future key-rotation
// tool can treat both the same way.

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
      "INTEGRATION_TOKEN_ENCRYPTION_KEY is not set; messaging encryption cannot run. " +
        "Generate one with `node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"` " +
        "and put it in .env."
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

export function encryptMessageBody(plaintext) {
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
  const payload = Buffer.concat([Buffer.from([VERSION_BYTE]), iv, tag, cipherBytes]);
  return payload.toString("base64");
}

export function decryptMessageBody(ciphertext) {
  if (ciphertext == null || ciphertext === "") {
    return null;
  }
  const key = resolveKey();
  const payload = Buffer.from(String(ciphertext), "base64");
  if (payload.length < 1 + IV_LENGTH + TAG_LENGTH) {
    throw new Error("Encrypted message payload is too short to be valid.");
  }
  const version = payload[0];
  if (version !== VERSION_BYTE) {
    throw new Error(`Unrecognized message encryption version byte: 0x${version.toString(16)}`);
  }
  const iv = payload.subarray(1, 1 + IV_LENGTH);
  const tag = payload.subarray(1 + IV_LENGTH, 1 + IV_LENGTH + TAG_LENGTH);
  const cipherBytes = payload.subarray(1 + IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(cipherBytes), decipher.final()]);
  return plaintext.toString("utf8");
}

// Non-throwing variant for the rare case where a corrupt row should
// render as "[unavailable]" instead of 500-ing the whole thread.
export function tryDecryptMessageBody(ciphertext) {
  try {
    return decryptMessageBody(ciphertext);
  } catch {
    return null;
  }
}

export function isMessagingEncryptionConfigured() {
  try {
    resolveKey();
    return true;
  } catch {
    return false;
  }
}
