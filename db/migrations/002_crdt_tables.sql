-- ════════════════════════════════════════════════════════════════════════
-- SmartChef — Migration 002: CRDT & Sync Tables
-- ════════════════════════════════════════════════════════════════════════

-- Log di tutte le operazioni CRDT (append-only)
CREATE TABLE crdt_operations (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  device_id    VARCHAR(100) NOT NULL,
  entity_type  VARCHAR(50)  NOT NULL, -- 'recipe' | 'ingredient' | 'menu' | 'shopping_list'
  entity_id    UUID         NOT NULL,
  op_type      VARCHAR(20)  NOT NULL, -- 'insert' | 'update' | 'delete'
  payload      JSONB        NOT NULL,
  vector_clock JSONB        NOT NULL DEFAULT '{}',
  applied_at   TIMESTAMPTZ  DEFAULT now(),
  synced       BOOLEAN      DEFAULT false
);

CREATE INDEX idx_crdt_ops_entity   ON crdt_operations(entity_type, entity_id);
CREATE INDEX idx_crdt_ops_device   ON crdt_operations(device_id);
CREATE INDEX idx_crdt_ops_unsynced ON crdt_operations(synced) WHERE synced = false;
CREATE INDEX idx_crdt_ops_time     ON crdt_operations(applied_at DESC);

-- Registro dei dispositivi conosciuti (per P2P discovery)
CREATE TABLE known_devices (
  device_id    VARCHAR(100) PRIMARY KEY,
  device_name  VARCHAR(200),
  last_seen_at TIMESTAMPTZ DEFAULT now(),
  ip_address   VARCHAR(45),
  port         INT,
  vector_clock JSONB DEFAULT '{}'
);

-- Snapshot del clock corrente per ogni entità (evita replay completo)
CREATE TABLE entity_clocks (
  entity_type  VARCHAR(50) NOT NULL,
  entity_id    UUID        NOT NULL,
  device_id    VARCHAR(100) NOT NULL,
  clock_value  BIGINT       NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ  DEFAULT now(),
  PRIMARY KEY (entity_type, entity_id, device_id)
);
