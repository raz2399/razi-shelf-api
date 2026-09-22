-- =====================================================================
-- Razi-Nova Shelf  ·  database schema  ·  v1
-- Multi-store from the start. Every operational row carries store_id.
-- Safe to run on an empty database. Re-running is a no-op.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- Stores
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stores (
  id               SERIAL PRIMARY KEY,
  code             TEXT        NOT NULL UNIQUE,              -- short, used in URLs: 'lindsay'
  name             TEXT        NOT NULL,
  timezone         TEXT        NOT NULL DEFAULT 'America/Los_Angeles',
  cleared_through  DATE,                                     -- expired tags on/before this date are considered handled
  look_back_days   INT         NOT NULL DEFAULT 14,
  look_ahead_days  INT         NOT NULL DEFAULT 30,
  suggest_after    INT         NOT NULL DEFAULT 3,           -- corrections needed before a rule change is suggested
  active           BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------
-- Zones: each store's own physical layout (aisle + side, or perimeter)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS zones (
  id          SERIAL PRIMARY KEY,
  store_id    INT     NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  code        TEXT    NOT NULL,                              -- '1A', '6B', 'PR'
  aisle       TEXT    NOT NULL,                              -- '1', 'Produce'
  side        TEXT    NOT NULL DEFAULT '',                   -- 'A', 'B', 'A+B', ''
  name        TEXT    NOT NULL,
  contents    TEXT    NOT NULL DEFAULT '',
  walk_order  INT     NOT NULL,
  kind        TEXT    NOT NULL DEFAULT 'aisle' CHECK (kind IN ('aisle','perimeter')),
  qr_code     TEXT    NOT NULL UNIQUE,                       -- printed on the endcap card
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (store_id, code)
);

-- ---------------------------------------------------------------------
-- Placement rules: first match by priority wins. Per store, because
-- layouts differ. A new store clones another store's rules to start.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS zone_rules (
  id          SERIAL PRIMARY KEY,
  store_id    INT     NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  priority    INT     NOT NULL,
  match_type  TEXT    NOT NULL CHECK (match_type IN ('dept','keyword','dept_fallback')),
  pattern     TEXT    NOT NULL,                              -- dept name or keyword, upper case
  zone_code   TEXT    NOT NULL,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  note        TEXT    NOT NULL DEFAULT '',
  created_by  TEXT    NOT NULL DEFAULT 'system',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS zone_rules_store_idx ON zone_rules (store_id, active, priority);

-- ---------------------------------------------------------------------
-- Items: the chain-wide item record. Price lives per store.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS items (
  upc          TEXT PRIMARY KEY,                             -- leading zeros stripped
  description  TEXT NOT NULL,
  size         TEXT NOT NULL DEFAULT '',
  pack         TEXT NOT NULL DEFAULT '',
  dept         TEXT NOT NULL DEFAULT '',
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS store_items (
  store_id    INT  NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  upc         TEXT NOT NULL REFERENCES items(upc) ON DELETE CASCADE,
  retail      NUMERIC(10,2),
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (store_id, upc)
);

-- ---------------------------------------------------------------------
-- Where each item physically lives, per store.
-- Trust order: scan (3) > correction (2) > rule (1).
-- A rule guess never overwrites a human-verified location.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS item_locations (
  store_id     INT  NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  upc          TEXT NOT NULL,
  zone_code    TEXT NOT NULL,
  section      TEXT NOT NULL DEFAULT '',
  shelf        TEXT NOT NULL DEFAULT '',
  source       TEXT NOT NULL CHECK (source IN ('rule','correction','scan')),
  rule_id      INT  REFERENCES zone_rules(id) ON DELETE SET NULL,   -- set while source = 'rule'
  guess_rule_id INT REFERENCES zone_rules(id) ON DELETE SET NULL,   -- the rule that guessed before a human verified
  verified_by  TEXT,
  verified_at  TIMESTAMPTZ,
  scan_count   INT  NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (store_id, upc)
);
CREATE INDEX IF NOT EXISTS item_locations_zone_idx ON item_locations (store_id, zone_code);
CREATE INDEX IF NOT EXISTS item_locations_src_idx  ON item_locations (store_id, source);

-- Append-only history of every location change. Never updated, never deleted.
CREATE TABLE IF NOT EXISTS location_events (
  id          BIGSERIAL PRIMARY KEY,
  store_id    INT  NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  upc         TEXT NOT NULL,
  from_zone   TEXT,
  to_zone     TEXT NOT NULL,
  from_source TEXT,
  source      TEXT NOT NULL CHECK (source IN ('rule','correction','scan')),
  rule_id     INT,                                            -- the rule that had guessed, if any
  actor       TEXT NOT NULL DEFAULT 'system',
  device      TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT '',
  client_id   TEXT UNIQUE,                                    -- idempotency key from the phone
  at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS location_events_store_idx ON location_events (store_id, at DESC);
CREATE INDEX IF NOT EXISTS location_events_rule_idx  ON location_events (store_id, rule_id, to_zone);

-- Rule changes the system proposes from human corrections. A person decides.
CREATE TABLE IF NOT EXISTS rule_suggestions (
  id           SERIAL PRIMARY KEY,
  store_id     INT  NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  rule_id      INT  NOT NULL REFERENCES zone_rules(id) ON DELETE CASCADE,
  from_zone    TEXT NOT NULL,
  to_zone      TEXT NOT NULL,
  moved        INT  NOT NULL DEFAULT 0,                       -- verified items the rule got wrong this way
  agreed       INT  NOT NULL DEFAULT 0,                       -- verified items the rule got right
  sample       TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  decided_by   TEXT,
  decided_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS rule_suggestions_open_uq
  ON rule_suggestions (store_id, rule_id, to_zone) WHERE status = 'pending';

-- ---------------------------------------------------------------------
-- Deals: BRdata TPR/ADP/FUT imports and ads planned in the app.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS deals (
  id          BIGSERIAL PRIMARY KEY,
  store_id    INT  NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  upc         TEXT NOT NULL,
  deal_type   TEXT NOT NULL,                                  -- TPR, ADP, FUT, AD
  starts      DATE,
  ends        DATE NOT NULL,
  sale_price  NUMERIC(10,2),
  vendor      TEXT NOT NULL DEFAULT '',
  source      TEXT NOT NULL DEFAULT 'brdata' CHECK (source IN ('brdata','ad_plan')),
  created_by  TEXT NOT NULL DEFAULT 'system',
  imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (store_id, upc, deal_type, starts, ends)
);
CREATE INDEX IF NOT EXISTS deals_store_end_idx   ON deals (store_id, ends);
CREATE INDEX IF NOT EXISTS deals_store_start_idx ON deals (store_id, starts);

-- ---------------------------------------------------------------------
-- Floor work: a tag hung or pulled, or flagged as impossible.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tag_work (
  id          BIGSERIAL PRIMARY KEY,
  store_id    INT    NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  deal_id     BIGINT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  action      TEXT   NOT NULL CHECK (action IN ('hang','pull')),
  status      TEXT   NOT NULL CHECK (status IN ('done','flagged')),
  reason      TEXT   NOT NULL DEFAULT '',
  verified    BOOLEAN NOT NULL DEFAULT FALSE,                 -- scan matched on the shelf
  zone_code   TEXT,
  actor       TEXT   NOT NULL,
  device      TEXT   NOT NULL DEFAULT '',
  client_id   TEXT,
  at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (deal_id, action)
);
CREATE INDEX IF NOT EXISTS tag_work_store_idx ON tag_work (store_id, at DESC);

-- Proof an aisle was walked: the endcap QR scanned.
CREATE TABLE IF NOT EXISTS zone_signoffs (
  id         BIGSERIAL PRIMARY KEY,
  store_id   INT  NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  zone_code  TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'tags' CHECK (kind IN ('tags','confirm','sweep')),
  actor      TEXT NOT NULL,
  device     TEXT NOT NULL DEFAULT '',
  client_id  TEXT UNIQUE,
  at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS zone_signoffs_idx ON zone_signoffs (store_id, zone_code, at DESC);

-- Schema version marker for future migrations.
CREATE TABLE IF NOT EXISTS schema_version (version INT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
INSERT INTO schema_version (version) VALUES (1) ON CONFLICT DO NOTHING;

COMMIT;
