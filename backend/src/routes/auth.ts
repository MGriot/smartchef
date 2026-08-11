// ════════════════════════════════════════════════════════════════════════
// SmartChef — Routes: Auth
// Single shared password gate per instance (see 020_auth.sql). No
// registration flow beyond a one-time "set up your instance" screen shown
// while the `account` table is empty. Session = JWT in an httpOnly cookie,
// stateless — no session table/cleanup needed.
// ════════════════════════════════════════════════════════════════════════

import { Router, Request, Response } from "express";
import { query, queryOne } from "../db/pool";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

export const authRouter = Router();

const SESSION_SECRET = process.env.SESSION_SECRET ?? "smartchef-dev-secret-change-me";
const COOKIE_NAME = "smartchef_session";
const COOKIE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

interface Account {
  id: string;
  name: string;
  password_hash: string;
  avatar_url: string | null;
}

// "lax" works for today's same-origin nginx-proxied browser use, but a
// native app calling the API from a different origin (capacitor://localhost
// hitting a Tailscale https://*.ts.net URL) needs "none" — which in turn
// requires `secure: true` per spec, so the two are turned on together.
const COOKIE_SAME_SITE = (process.env.COOKIE_SAME_SITE ?? "lax") as "lax" | "strict" | "none";

function issueSession(res: Response, accountId: string) {
  const token = jwt.sign({ sub: accountId }, SESSION_SECRET, { expiresIn: "90d" });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: COOKIE_SAME_SITE,
    // Plain HTTP on the LAN by default (no TLS termination in the compose
    // stack) — a `secure` cookie would silently never be sent back. Opt in
    // explicitly via COOKIE_SECURE=true once/if TLS is added in front.
    secure: process.env.COOKIE_SECURE === "true" || COOKIE_SAME_SITE === "none",
    maxAge: COOKIE_MAX_AGE_MS,
  });
}

// GET /auth/status
authRouter.get("/status", async (req: Request, res: Response) => {
  const account = await queryOne<Account>("SELECT * FROM account LIMIT 1");
  if (!account) {
    return res.json({ data: { hasAccount: false, authenticated: false } });
  }

  const token = req.cookies?.[COOKIE_NAME];
  let authenticated = false;
  if (token) {
    try {
      const payload = jwt.verify(token, SESSION_SECRET) as { sub: string };
      authenticated = payload.sub === account.id;
    } catch {
      authenticated = false;
    }
  }

  res.json({
    data: {
      hasAccount: true,
      authenticated,
      name: authenticated ? account.name : undefined,
      avatarUrl: authenticated ? account.avatar_url ?? undefined : undefined,
    },
  });
});

const SetupSchema = z.object({
  name: z.string().min(1),
  password: z.string().min(4),
  avatarUrl: z.string().optional().nullable(),
});

// POST /auth/setup — only when no account row exists yet
authRouter.post("/setup", async (req: Request, res: Response) => {
  const existing = await queryOne<Account>("SELECT id FROM account LIMIT 1");
  if (existing) return res.status(409).json({ error: "Account already set up" });

  const parsed = SetupSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const d = parsed.data;
  const id = uuidv4();
  const passwordHash = await bcrypt.hash(d.password, 10);
  await query(
    `INSERT INTO account (id, name, password_hash, avatar_url) VALUES ($1, $2, $3, $4)`,
    [id, d.name, passwordHash, d.avatarUrl || null]
  );

  issueSession(res, id);
  res.json({ data: { id, name: d.name, avatarUrl: d.avatarUrl || null } });
});

const LoginSchema = z.object({ password: z.string().min(1) });

// POST /auth/login
authRouter.post("/login", async (req: Request, res: Response) => {
  const parsed = LoginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const account = await queryOne<Account>("SELECT * FROM account LIMIT 1");
  if (!account) return res.status(404).json({ error: "No account set up yet" });

  const ok = await bcrypt.compare(parsed.data.password, account.password_hash);
  if (!ok) return res.status(401).json({ error: "Incorrect password" });

  issueSession(res, account.id);
  res.json({ data: { id: account.id, name: account.name, avatarUrl: account.avatar_url } });
});

// POST /auth/logout
authRouter.post("/logout", (_req: Request, res: Response) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ success: true });
});

const AccountUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  avatarUrl: z.string().optional().nullable(),
  password: z.string().min(4).optional(),
});

// PUT /auth/account — requires auth (mounted after requireAuth in index.ts
// for everything except the routes above, but this one also needs it
// explicitly since /api/auth itself is excluded from the global gate)
authRouter.put("/account", async (req: Request, res: Response) => {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: "Not authenticated" });

  let accountId: string;
  try {
    const payload = jwt.verify(token, SESSION_SECRET) as { sub: string };
    accountId = payload.sub;
  } catch {
    return res.status(401).json({ error: "Not authenticated" });
  }

  const parsed = AccountUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const d = parsed.data;

  const updates: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  if (d.name !== undefined) { updates.push(`name=$${i++}`); params.push(d.name); }
  if (d.avatarUrl !== undefined) { updates.push(`avatar_url=$${i++}`); params.push(d.avatarUrl || null); }
  if (d.password) { updates.push(`password_hash=$${i++}`); params.push(await bcrypt.hash(d.password, 10)); }
  if (!updates.length) return res.json({ success: true });

  params.push(accountId);
  await query(`UPDATE account SET ${updates.join(", ")}, updated_at=now() WHERE id=$${i}`, params);
  res.json({ success: true });
});
