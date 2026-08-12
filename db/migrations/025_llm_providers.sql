-- 025_llm_providers.sql
-- Adds cloud LLM provider selection + encrypted API keys to the account
-- row, for recipe-import parsing. Local Ollama stays the default;
-- 'llm_provider' is an explicit opt-in, never auto-selected just because a
-- key happens to be configured.

ALTER TABLE account
  ADD COLUMN llm_provider VARCHAR(20) NOT NULL DEFAULT 'ollama'
    CHECK (llm_provider IN ('ollama', 'anthropic', 'gemini', 'openai')),
  ADD COLUMN anthropic_api_key_encrypted TEXT,
  ADD COLUMN gemini_api_key_encrypted TEXT,
  ADD COLUMN openai_api_key_encrypted TEXT;
