import axios from "axios";
import { config } from "../config";
import { logger } from "../utils/logger";

/**
 * Minimal, dependency-light monitoring hook. This intentionally doesn't
 * bind to a specific vendor (Sentry, Datadog, etc.) — swap the body of
 * `captureException`/`alert` for a real SDK call when you pick one. Until
 * then, every error is still structured-logged (so `railway logs` / any log
 * drain gives you a searchable trail), and if ALERT_WEBHOOK_URL is set,
 * critical failures also get pushed in near-real-time to wherever that
 * webhook points — a Slack/Discord incoming webhook or a Telegram bot
 * message to an admin chat all work with the same simple POST-JSON shape
 * used here.
 */

let lastAlertAt = 0;
const ALERT_THROTTLE_MS = 30_000; // avoid spamming the webhook during an outage storm

export function captureException(err: unknown, context: Record<string, unknown> = {}) {
  const error = err instanceof Error ? err : new Error(String(err));
  logger.error({ err: error, ...context }, "Captured exception");
  void maybeAlert(`🚨 ${context.context ?? "Error"}: ${error.message}`, context);
}

export function captureMessage(message: string, context: Record<string, unknown> = {}) {
  logger.warn({ ...context }, message);
  void maybeAlert(`⚠️ ${message}`, context);
}

async function maybeAlert(text: string, context: Record<string, unknown>) {
  if (!config.monitoring.alertWebhookUrl) return;

  const now = Date.now();
  if (now - lastAlertAt < ALERT_THROTTLE_MS) return;
  lastAlertAt = now;

  try {
    await axios.post(
      config.monitoring.alertWebhookUrl,
      {
        text: `NEXUS SOL BOT [${config.nodeEnv}]: ${text}`,
        context,
      },
      { timeout: 5000 }
    );
  } catch (err) {
    // Never let alerting itself crash the request path.
    logger.warn({ err }, "Failed to deliver alert webhook");
  }
}
