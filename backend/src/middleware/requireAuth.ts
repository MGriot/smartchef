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
  // Pure existence check — "has anyone ever set this instance up" — not an
  // identity lookup, so LIMIT 1 with no ORDER BY is fine here (its id is
  // never used for anything below).
  const anyAccount = await queryOne<{ id: string }>("SELECT id FROM account LIMIT 1");
  if (!anyAccount) return next(); // no account set up yet — nothing to protect

  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: "Not authenticated" });

  let payload: { sub: string };
  try {
    payload = jwt.verify(token, SESSION_SECRET) as { sub: string };
  } catch {
    return res.status(401).json({ error: "Not authenticated" });
  }

  // Looked up by the JWT's own sub claim — not "whichever row sorts
  // first" — required now that more than one account can exist.
  const account = await queryOne<{ id: string; role: string }>(
    "SELECT id, role FROM account WHERE id = $1",
    [payload.sub]
  );
  if (!account) return res.status(401).json({ error: "Not authenticated" });

  req.userId = account.id;
  req.userRole = account.role as "admin" | "user";
  next();
}
