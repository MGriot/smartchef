-- 037_ollama_url.sql
-- Per-account override of the Ollama base URL (host + port), settable from
-- the AI Provider card in Account settings instead of only via the
-- server-side OLLAMA_URL env var. NULL means "use the server's default".

ALTER TABLE account
  ADD COLUMN IF NOT EXISTS ollama_url TEXT;
