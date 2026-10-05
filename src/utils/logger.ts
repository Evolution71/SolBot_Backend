import pino from "pino";
import { config } from "../config";

export const logger = pino({
  level: config.logLevel,
  transport:
    config.nodeEnv === "development"
      ? { target: "pino-pretty", options: { colorize: true } }
      : undefined,
  redact: {
    // Belt-and-braces: even though we should never log these, redact if they
    // ever end up in a log call by mistake.
    paths: [
      "*.privateKey",
      "*.encryptedPrivateKey",
      "*.token",
      "*.secret",
      "req.headers.authorization",
    ],
    censor: "[REDACTED]",
  },
});
