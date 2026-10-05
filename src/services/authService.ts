import crypto from "crypto";
import jwt from "jsonwebtoken";
import { config } from "../config";

/**
 * Telegram Login Widget verification.
 * https://core.telegram.org/widgets/login#checking-authorization
 *
 * The widget returns a payload signed with a hash derived from the bot
 * token. We recompute that hash server-side and reject anything that
 * doesn't match — this is what proves the login actually came from
 * Telegram and wasn't forged by a client sending an arbitrary user id.
 */
export interface TelegramLoginPayload {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number;
  hash: string;
}

const MAX_AUTH_AGE_SECONDS = 24 * 60 * 60; // reject stale login attempts

export function verifyTelegramLogin(payload: TelegramLoginPayload): { ok: true } | { ok: false; reason: string } {
  const { hash, ...fields } = payload;

  const ageSeconds = Math.floor(Date.now() / 1000) - fields.auth_date;
  if (ageSeconds > MAX_AUTH_AGE_SECONDS || ageSeconds < -60) {
    return { ok: false, reason: "Login attempt expired — try again." };
  }

  const dataCheckString = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${(fields as any)[key]}`)
    .join("\n");

  const secretKey = crypto.createHash("sha256").update(config.telegram.botToken).digest();
  const computedHash = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  const validLength =
    computedHash.length === hash.length &&
    crypto.timingSafeEqual(Buffer.from(computedHash), Buffer.from(hash));

  if (!validLength) {
    return { ok: false, reason: "Signature mismatch — this login wasn't issued by Telegram." };
  }

  return { ok: true };
}

export interface SessionClaims {
  telegramUserId: string;
  username?: string;
}

export function issueSessionToken(claims: SessionClaims): string {
  // `expiresIn` accepts values like "12h"/"7d", but newer @types/jsonwebtoken
  // versions narrow its type to a specific literal union rather than plain
  // `string`. Our value comes from an env var (always a runtime `string`),
  // so we cast it here rather than fighting the library's type definitions —
  // the runtime behavior is unaffected either way.
  const options: jwt.SignOptions = {
    expiresIn: config.security.jwtExpiresIn as jwt.SignOptions["expiresIn"],
  };
  return jwt.sign(claims, config.security.jwtSecret, options);
}

export function verifySessionToken(token: string): SessionClaims {
  return jwt.verify(token, config.security.jwtSecret) as SessionClaims;
}
