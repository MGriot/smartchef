// ════════════════════════════════════════════════════════════════════════
// SmartChef — Encrypts/decrypts secrets (cloud LLM API keys) at rest in
// the DB, using AES-256-GCM via Node's built-in crypto. Same "dev fallback
// + change-me-in-prod" pattern as SESSION_SECRET (auth.ts). This protects
// stored keys from a DB-only leak; it does not protect against someone
// with both DB and env access — same trust boundary the app already
// accepts for SESSION_SECRET/JWTs.
// ════════════════════════════════════════════════════════════════════════

import crypto from "node:crypto";

const ENCRYPTION_SECRET = process.env.LLM_KEY_ENCRYPTION_SECRET
  ?? "smartchef-dev-encryption-secret-change-me";

const KEY = crypto.scryptSync(ENCRYPTION_SECRET, "smartchef-llm-keys", 32);

export function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(12); // 96-bit IV, standard for GCM
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${ciphertext.toString("hex")}`;
}

export function decrypt(encoded: string): string {
  const [ivHex, tagHex, dataHex] = encoded.split(":");
  if (!ivHex || !tagHex || !dataHex) throw new Error("Malformed encrypted value");
  const decipher = crypto.createDecipheriv("aes-256-gcm", KEY, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]).toString("utf8");
}
