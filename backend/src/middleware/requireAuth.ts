// Verifies the session cookie set by /api/auth/{setup,login}. Mounted on
// every /api/* router except /api/auth itself. Also lets requests through
// when no account has been set up yet, so the first-run setup screen's own
// calls to GET /api/auth/status work — everything else 404s harmlessly
// against an empty DB until setup happens anyway.

import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { queryOne } from "../db/pool";

const SESSION_SECRET = process.env.SESSION_SECRET ?? "smartchef-dev-secret-change-me";
const COOKIE_NAME = "smartchef_session";

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const account = await queryOne<{ id: string }>("SELECT id FROM account LIMIT 1");
  if (!account) return next(); // no account set up yet — nothing to protect

  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: "Not authenticated" });

  try {
    const payload = jwt.verify(token, SESSION_SECRET) as { sub: string };
    if (payload.sub !== account.id) return res.status(401).json({ error: "Not authenticated" });
  } catch {
    return res.status(401).json({ error: "Not authenticated" });
  }

  next();
}
