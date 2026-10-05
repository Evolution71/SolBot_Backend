import { Router } from "express";
import axios from "axios";
import { config } from "../config";
import { supabase } from "../db/supabase";
import { logger } from "../utils/logger";

export const waitlistRouter = Router();

async function verifyTurnstile(token: string, remoteIp?: string): Promise<boolean> {
  if (!config.turnstile.secretKey) {
    logger.warn("TURNSTILE_SECRET_KEY not set — refusing signups until CAPTCHA is configured");
    return false;
  }

  try {
    const { data } = await axios.post(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      new URLSearchParams({
        secret: config.turnstile.secretKey,
        response: token,
        ...(remoteIp ? { remoteip: remoteIp } : {}),
      }),
      { timeout: 8000 }
    );
    return Boolean(data.success);
  } catch (err) {
    logger.warn({ err }, "Turnstile verification request failed");
    return false;
  }
}

/**
 * Accepts an early-access signup, but ONLY after independently verifying
 * the CAPTCHA token against Cloudflare's own servers. The frontend widget
 * proves a browser rendered a challenge; this verification is what proves
 * a human actually solved it — skipping this step would make the CAPTCHA
 * purely cosmetic.
 */
waitlistRouter.post("/", async (req, res) => {
  const { contact, turnstileToken } = req.body ?? {};

  if (!contact || typeof contact !== "string" || contact.trim().length < 3) {
    return res.status(400).json({ error: "Please provide a valid contact (email or Telegram @handle)." });
  }
  if (!turnstileToken || typeof turnstileToken !== "string") {
    return res.status(400).json({ error: "Missing CAPTCHA verification." });
  }

  const human = await verifyTurnstile(turnstileToken, req.ip);
  if (!human) {
    return res.status(403).json({ error: "CAPTCHA verification failed — please try again." });
  }

  const { error } = await supabase.from("waitlist").insert({ contact: contact.trim() });
  if (error && error.code !== "23505") {
    // 23505 = unique violation (already on the list) — treat as success.
    logger.error({ error }, "Failed to insert waitlist signup");
    return res.status(500).json({ error: "Something went wrong — please try again." });
  }

  res.status(200).json({ ok: true });
});
