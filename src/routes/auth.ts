import { Router } from "express";
import { verifyTelegramLogin, issueSessionToken } from "../services/authService";
import { supabase } from "../db/supabase";
import { logger } from "../utils/logger";

export const authRouter = Router();

/**
 * Called by the frontend after the Telegram Login Widget returns a signed
 * payload. We verify the signature server-side (proving it really came from
 * Telegram, not a forged request), then issue our own short-lived JWT for
 * subsequent /api/me/* calls.
 */
authRouter.post("/telegram", async (req, res) => {
  const payload = req.body;

  if (!payload || typeof payload.id === "undefined" || !payload.hash) {
    return res.status(400).json({ error: "Malformed login payload" });
  }

  const result = verifyTelegramLogin(payload);
  if (!result.ok) {
    logger.warn({ reason: result.reason }, "Rejected Telegram login attempt");
    return res.status(401).json({ error: result.reason });
  }

  const telegramUserId = String(payload.id);

  // Keep the user record in sync with their latest Telegram profile info.
  await supabase.from("users").upsert(
    { telegram_user_id: telegramUserId, telegram_handle: payload.username ?? null },
    { onConflict: "telegram_user_id" }
  );

  const token = issueSessionToken({ telegramUserId, username: payload.username });
  res.json({ token, telegramUserId });
});
