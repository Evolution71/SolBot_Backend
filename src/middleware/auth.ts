import { NextFunction, Request, Response } from "express";
import { verifySessionToken } from "../services/authService";

export interface AuthedRequest extends Request {
  auth?: { telegramUserId: string; username?: string };
}

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.header("authorization") || "";
  const [scheme, token] = header.split(" ");

  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({ error: "Missing or malformed Authorization header" });
  }

  try {
    const claims = verifySessionToken(token);
    req.auth = { telegramUserId: claims.telegramUserId, username: claims.username };
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired session — please log in again" });
  }
}
