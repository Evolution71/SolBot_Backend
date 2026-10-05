import crypto from "crypto";
import { config } from "../config";

/**
 * SECURITY MODEL
 * ---------------------------------------------------------------------------
 * This bot NEVER asks a user for their existing wallet's private key or seed
 * phrase. That flow is how the vast majority of Telegram "trading bot" scams
 * steal funds, and we don't build it.
 *
 * Instead, on /start the bot GENERATES a fresh keypair per user (see
 * walletService.ts). That keypair's secret key is encrypted with AES-256-GCM
 * using WALLET_ENCRYPTION_KEY before it ever touches the database, and it is
 * decrypted only in-process, only at the moment a signed transaction needs to
 * be built, and never logged or returned to the client.
 *
 * Users can withdraw 100% of funds from their generated wallet at any time
 * via /wallet, and can connect an external wallet (Phantom/Solflare) on the
 * dashboard for withdrawals instead of relying on the bot.
 * ---------------------------------------------------------------------------
 */

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // recommended for GCM

function getKey(): Buffer {
  const hex = config.security.walletEncryptionKey;
  if (hex.length !== 64) {
    throw new Error(
      "WALLET_ENCRYPTION_KEY must be a 64-char hex string (32 bytes). Generate with: openssl rand -hex 32"
    );
  }
  return Buffer.from(hex, "hex");
}

export function encryptSecret(plaintext: Uint8Array | string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const input =
    typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : Buffer.from(plaintext);

  const encrypted = Buffer.concat([cipher.update(input), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Store iv + authTag + ciphertext together, base64-encoded
  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

export function decryptSecret(payload: string): Buffer {
  const key = getKey();
  const raw = Buffer.from(payload, "base64");

  const iv = raw.subarray(0, IV_LENGTH);
  const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + 16);
  const ciphertext = raw.subarray(IV_LENGTH + 16);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
