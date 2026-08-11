-- 020_auth.sql
-- Single shared password gate per SmartChef instance. Not per-user data
-- isolation — this app already syncs one shared household dataset across
-- devices via mDNS/CRDT. "account" is a single row by convention: the
-- app shows a one-time setup screen when the table is empty, and a plain
-- password prompt afterwards.

CREATE TABLE IF NOT EXISTS account (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name          VARCHAR(200) NOT NULL,
  password_hash TEXT NOT NULL,
  avatar_url    TEXT,
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TRIGGER trg_account_updated_at
  BEFORE UPDATE ON account FOR EACH ROW EXECUTE FUNCTION set_updated_at();
