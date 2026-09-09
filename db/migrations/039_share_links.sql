-- 039_share_links.sql
-- Public, unauthenticated read links for a single recipe.
--
-- Server mode only, and deliberately so: a public URL needs a server that
-- is running and reachable, and standalone mode's whole premise is that
-- there isn't one. The offline builds offer the existing file export
-- instead rather than pretending this exists.
--
-- The token is the credential, so it is generated from crypto-quality
-- randomness (see routes/share.ts) and never derived from the recipe id —
-- a guessable token would make every recipe public at once. Tokens are
-- revocable, which is why the row is deleted rather than the recipe being
-- flagged: revoking must not touch the recipe itself.

CREATE TABLE IF NOT EXISTS recipe_share_links (
  token       VARCHAR(64) PRIMARY KEY,
  recipe_id   UUID NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  created_by  UUID REFERENCES account(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- NULL means "until revoked". A date lets someone share a recipe for a
  -- dinner party without it staying public forever.
  expires_at  TIMESTAMPTZ,
  -- Cheap signal for the owner: has anyone actually opened this?
  view_count  INT NOT NULL DEFAULT 0,
  last_seen_at TIMESTAMPTZ
);

-- The owner's "is this recipe shared?" lookup runs on every recipe page.
CREATE INDEX IF NOT EXISTS idx_recipe_share_links_recipe ON recipe_share_links(recipe_id);
