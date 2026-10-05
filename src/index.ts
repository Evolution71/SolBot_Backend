import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { config } from "./config";
import { logger } from "./utils/logger";
import { captureException } from "./services/monitoringService";
import { bot } from "./bot/bot";
import { healthRouter } from "./routes/health";
import { webhookRouter } from "./routes/webhook";
import { apiRouter } from "./routes/api";
import { authRouter } from "./routes/auth";
import { waitlistRouter } from "./routes/waitlist";
import { publicDataRouter } from "./routes/publicData";
import { supportRouter } from "./routes/support";
import { checkOpenPositions } from "./services/positionMonitorService";

const app = express();

app.use(helmet());

// CORS is locked to explicit origins (set CORS_ALLOWED_ORIGINS, comma
// separated, e.g. "https://yourapp.netlify.app,https://yourdomain.com").
// If left unset, we deny cross-origin requests by default rather than
// silently opening things up -- a wildcard "*" here would let any website
// call your authenticated API on behalf of a logged-in user's browser.
app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true); // same-origin / server-to-server / curl
      if (config.security.corsAllowedOrigins.includes(origin)) return callback(null, true);
      callback(new Error(`Origin ${origin} not allowed by CORS policy`));
    },
    credentials: true,
  })
);

app.use(express.json());

app.use(
  rateLimit({
    windowMs: 60_000,
    limit: 60,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// Tighter limit specifically on auth to slow down brute-force/credential-
// stuffing style abuse of the login endpoint.
app.use(
  "/api/auth",
  rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: true, legacyHeaders: false })
);

app.use("/health", healthRouter);
app.use("/webhook", webhookRouter);
app.use("/api/auth", authRouter);
app.use(
  "/api/waitlist",
  rateLimit({ windowMs: 60_000, limit: 5, standardHeaders: true, legacyHeaders: false })
);
app.use("/api/waitlist", waitlistRouter);
app.use(
  "/api/support",
  rateLimit({ windowMs: 60_000, limit: 5, standardHeaders: true, legacyHeaders: false })
);
app.use("/api/support", supportRouter);
app.use("/api", publicDataRouter);
app.use("/api", apiRouter);

// Global safety net: log + alert on anything that slips past individual
// route try/catch blocks, without crashing the process for a single bad
// request. A crashed process still gets caught by uncaughtException below
// and restarted by Railway's restart policy (see railway.json).
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  captureException(err, { context: "express_error_handler" });
  res.status(500).json({ error: "Internal server error" });
});

process.on("uncaughtException", (err) => {
  captureException(err, { context: "uncaughtException" });
});

process.on("unhandledRejection", (reason) => {
  captureException(reason, { context: "unhandledRejection" });
});

async function main() {
  app.listen(config.port, () => {
    logger.info(`HTTP server listening on :${config.port}`);
  });

  if (config.telegram.webhookUrl) {
    app.use(bot.webhookCallback("/telegram/webhook"));
    await bot.telegram.setWebhook(config.telegram.webhookUrl);
    logger.info({ url: config.telegram.webhookUrl }, "Telegram webhook set");
  } else {
    await bot.launch();
    logger.info("Telegram bot launched via long-polling");
  }

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));

  // Take-profit / stop-loss engine: every 20 seconds, check every open
  // monitored position's current market value and auto-sell any that have
  // hit their configured target. This is what makes "buy at X, sell when
  // it reaches Y" actually automated instead of something the user has to
  // watch and trigger manually.
  //
  // SCALING NOTE: like pendingTradeStore, this assumes a single backend
  // instance. If you run multiple Railway replicas, move this to a proper
  // job queue/cron service so positions aren't checked (and potentially
  // double-closed) by more than one instance at once.
  const POSITION_CHECK_INTERVAL_MS = 20_000;
  setInterval(() => {
    checkOpenPositions().catch((err) => captureException(err, { context: "position_monitor_interval" }));
  }, POSITION_CHECK_INTERVAL_MS);
  logger.info(`Position monitor running every ${POSITION_CHECK_INTERVAL_MS / 1000}s`);
}

main().catch((err) => {
  captureException(err, { context: "startup" });
  process.exit(1);
});
