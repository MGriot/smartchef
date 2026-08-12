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
import { encrypt } from "../services/crypto.service";

export const authRouter = Router();

const SESSION_SECRET = process.env.SESSION_SECRET ?? "smartchef-dev-secret-change-me";
const COOKIE_NAME = "smartchef_session";
const COOKIE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

interface Account {
  id: string;
  name: string;
  username: string;
  password_hash: string;
  avatar_url: string | null;
  role: string;
}

// Shared cookie-check helper for /api/auth/* admin-only routes (this
// router is excluded from the global requireAuth middleware, so each
// route that needs auth checks the cookie itself — same reason
// PUT /account and GET /llm-config already do).
async function requireAdminFromCookie(req: Request): Promise<{ id: string } | null> {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return null;
  let accountId: string;
  try {
    accountId = (jwt.verify(token, SESSION_SECRET) as { sub: string }).sub;
  } catch {
    return null;
  }
  const requester = await queryOne<{ role: string }>("SELECT role FROM account WHERE id=$1", [accountId]);
  return requester?.role === "admin" ? { id: accountId } : null;
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
  const hasAccount = await queryOne<{ id: string }>("SELECT id FROM account LIMIT 1");
  if (!hasAccount) {
    return res.json({ data: { hasAccount: false, authenticated: false } });
  }

  const token = req.cookies?.[COOKIE_NAME];
  let account: Account | null = null;
  if (token) {
    try {
      const payload = jwt.verify(token, SESSION_SECRET) as { sub: string };
      account = await queryOne<Account>("SELECT * FROM account WHERE id = $1", [payload.sub]);
    } catch {
      account = null;
    }
  }

  res.json({
    data: {
      hasAccount: true,
      authenticated: !!account,
      id: account?.id,
      name: account?.name,
      username: account?.username,
      role: account?.role,
      avatarUrl: account?.avatar_url ?? undefined,
    },
  });
});

const SetupSchema = z.object({
  name: z.string().min(1),
  username: z.string().min(3).max(50).regex(/^[a-z0-9_.-]+$/, "Lowercase letters, numbers, - _ . only"),
  password: z.string().min(4),
  avatarUrl: z.string().optional().nullable(),
});

// POST /auth/setup — only when no account row exists yet. This is always
// the instance's very first account, so it's always the admin.
authRouter.post("/setup", async (req: Request, res: Response) => {
  const existing = await queryOne<Account>("SELECT id FROM account LIMIT 1");
  if (existing) return res.status(409).json({ error: "Account already set up" });

  const parsed = SetupSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const d = parsed.data;
  const username = d.username.toLowerCase();
  const id = uuidv4();
  const passwordHash = await bcrypt.hash(d.password, 10);
  await query(
    `INSERT INTO account (id, name, username, password_hash, avatar_url, role) VALUES ($1, $2, $3, $4, $5, 'admin')`,
    [id, d.name, username, passwordHash, d.avatarUrl || null]
  );

  issueSession(res, id);
  res.json({ data: { id, name: d.name, username, role: "admin", avatarUrl: d.avatarUrl || null } });
});

const LoginSchema = z.object({ username: z.string().min(1), password: z.string().min(1) });

// POST /auth/login
authRouter.post("/login", async (req: Request, res: Response) => {
  const parsed = LoginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const account = await queryOne<Account>("SELECT * FROM account WHERE username = $1", [parsed.data.username.toLowerCase()]);
  // Generic message on either failure — don't reveal whether the username exists.
  if (!account) return res.status(401).json({ error: "Incorrect username or password" });

  const ok = await bcrypt.compare(parsed.data.password, account.password_hash);
  if (!ok) return res.status(401).json({ error: "Incorrect username or password" });

  issueSession(res, account.id);
  res.json({ data: { id: account.id, name: account.name, username: account.username, role: account.role, avatarUrl: account.avatar_url } });
});

// POST /auth/logout
authRouter.post("/logout", (_req: Request, res: Response) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ success: true });
});

const AccountUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  username: z.string().min(3).max(50).regex(/^[a-z0-9_.-]+$/, "Lowercase letters, numbers, - _ . only").optional(),
  avatarUrl: z.string().optional().nullable(),
  password: z.string().min(4).optional(),
  llmProvider: z.enum(["ollama", "anthropic", "gemini", "openai"]).optional(),
  // "" clears the stored key, undefined/omitted leaves it untouched.
  anthropicApiKey: z.string().optional(),
  geminiApiKey: z.string().optional(),
  openaiApiKey: z.string().optional(),
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

  if (d.username !== undefined) {
    const username = d.username.toLowerCase();
    const existing = await queryOne<{ id: string }>("SELECT id FROM account WHERE username=$1 AND id!=$2", [username, accountId]);
    if (existing) return res.status(409).json({ error: "Username already taken" });
  }

  const updates: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  if (d.name !== undefined) { updates.push(`name=$${i++}`); params.push(d.name); }
  if (d.username !== undefined) { updates.push(`username=$${i++}`); params.push(d.username.toLowerCase()); }
  if (d.avatarUrl !== undefined) { updates.push(`avatar_url=$${i++}`); params.push(d.avatarUrl || null); }
  if (d.password) { updates.push(`password_hash=$${i++}`); params.push(await bcrypt.hash(d.password, 10)); }
  if (d.llmProvider !== undefined) { updates.push(`llm_provider=$${i++}`); params.push(d.llmProvider); }
  if (d.anthropicApiKey !== undefined) {
    updates.push(`anthropic_api_key_encrypted=$${i++}`);
    params.push(d.anthropicApiKey ? encrypt(d.anthropicApiKey) : null);
  }
  if (d.geminiApiKey !== undefined) {
    updates.push(`gemini_api_key_encrypted=$${i++}`);
    params.push(d.geminiApiKey ? encrypt(d.geminiApiKey) : null);
  }
  if (d.openaiApiKey !== undefined) {
    updates.push(`openai_api_key_encrypted=$${i++}`);
    params.push(d.openaiApiKey ? encrypt(d.openaiApiKey) : null);
  }
  if (!updates.length) return res.json({ success: true });

  params.push(accountId);
  await query(`UPDATE account SET ${updates.join(", ")}, updated_at=now() WHERE id=$${i}`, params);
  res.json({ success: true });
});

// GET /auth/llm-config — which cloud LLM provider (if any) is configured
// for recipe-import parsing. Booleans only, never the raw key values.
// Requires auth manually, same reason/pattern as PUT /account above.
authRouter.get("/llm-config", async (req: Request, res: Response) => {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: "Not authenticated" });
  let accountId: string;
  try {
    accountId = (jwt.verify(token, SESSION_SECRET) as { sub: string }).sub;
  } catch {
    return res.status(401).json({ error: "Not authenticated" });
  }

  const account = await queryOne<{
    llm_provider: string;
    anthropic_api_key_encrypted: string | null;
    gemini_api_key_encrypted: string | null;
    openai_api_key_encrypted: string | null;
  }>(
    "SELECT llm_provider, anthropic_api_key_encrypted, gemini_api_key_encrypted, openai_api_key_encrypted FROM account WHERE id = $1",
    [accountId]
  );
  if (!account) return res.status(404).json({ error: "Account not found" });

  res.json({
    data: {
      provider: account.llm_provider,
      hasAnthropicKey: !!account.anthropic_api_key_encrypted,
      hasGeminiKey: !!account.gemini_api_key_encrypted,
      hasOpenaiKey: !!account.openai_api_key_encrypted,
    },
  });
});

const CreateUserSchema = z.object({
  name: z.string().min(1),
  username: z.string().min(3).max(50).regex(/^[a-z0-9_.-]+$/, "Lowercase letters, numbers, - _ . only"),
  password: z.string().min(4),
  role: z.enum(["admin", "user"]).default("user"),
  avatarUrl: z.string().optional().nullable(),
});

// POST /auth/users — admin-only, creates/invites a new user.
authRouter.post("/users", async (req: Request, res: Response) => {
  const admin = await requireAdminFromCookie(req);
  if (!admin) return res.status(403).json({ error: "Admin only" });

  const parsed = CreateUserSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const d = parsed.data;
  const username = d.username.toLowerCase();

  const existing = await queryOne("SELECT id FROM account WHERE username=$1", [username]);
  if (existing) return res.status(409).json({ error: "Username already taken" });

  const id = uuidv4();
  const passwordHash = await bcrypt.hash(d.password, 10);
  await query(
    `INSERT INTO account (id, name, username, password_hash, avatar_url, role) VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, d.name, username, passwordHash, d.avatarUrl || null, d.role]
  );
  res.status(201).json({ data: { id, name: d.name, username, role: d.role, avatarUrl: d.avatarUrl || null } });
});

// GET /auth/users — admin-only, lists every user (no password hashes).
authRouter.get("/users", async (req: Request, res: Response) => {
  const admin = await requireAdminFromCookie(req);
  if (!admin) return res.status(403).json({ error: "Admin only" });

  const users = await query(
    `SELECT id, username, name, role, avatar_url AS "avatarUrl" FROM account ORDER BY created_at ASC`
  );
  res.json({ data: users });
});
