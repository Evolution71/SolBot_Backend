import crypto from "crypto";

// Import after setupEnv has populated process.env (jest setupFiles runs first).
import { verifyTelegramLogin, issueSessionToken, verifySessionToken } from "../services/authService";

function signPayload(fields: Record<string, string | number>, botToken: string) {
  const dataCheckString = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join("\n");
  const secretKey = crypto.createHash("sha256").update(botToken).digest();
  return crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
}

describe("verifyTelegramLogin", () => {
  const botToken = process.env.TELEGRAM_BOT_TOKEN as string;

  it("accepts a correctly signed, fresh payload", () => {
    const fields = { id: 12345, username: "degen", auth_date: Math.floor(Date.now() / 1000) };
    const hash = signPayload(fields, botToken);

    const result = verifyTelegramLogin({ ...fields, hash });
    expect(result.ok).toBe(true);
  });

  it("rejects a tampered payload (wrong id, valid-looking hash from a different payload)", () => {
    const fields = { id: 12345, username: "degen", auth_date: Math.floor(Date.now() / 1000) };
    const hash = signPayload(fields, botToken);

    // Attacker tries to swap in a different Telegram id after signing.
    const forged = { ...fields, id: 99999, hash };
    const result = verifyTelegramLogin(forged);
    expect(result.ok).toBe(false);
  });

  it("rejects a payload signed with the wrong bot token", () => {
    const fields = { id: 12345, username: "degen", auth_date: Math.floor(Date.now() / 1000) };
    const hash = signPayload(fields, "some-other-bots-token");

    const result = verifyTelegramLogin({ ...fields, hash });
    expect(result.ok).toBe(false);
  });

  it("rejects a stale login attempt", () => {
    const fields = {
      id: 12345,
      username: "degen",
      auth_date: Math.floor(Date.now() / 1000) - 60 * 60 * 48, // 48h old
    };
    const hash = signPayload(fields, botToken);

    const result = verifyTelegramLogin({ ...fields, hash });
    expect(result.ok).toBe(false);
  });
});

describe("session tokens", () => {
  it("round-trips claims through issue/verify", () => {
    const token = issueSessionToken({ telegramUserId: "12345", username: "degen" });
    const claims = verifySessionToken(token);
    expect(claims.telegramUserId).toBe("12345");
    expect(claims.username).toBe("degen");
  });

  it("throws on a tampered token", () => {
    const token = issueSessionToken({ telegramUserId: "12345" });
    const tampered = token.slice(0, -2) + "xx";
    expect(() => verifySessionToken(tampered)).toThrow();
  });
});
