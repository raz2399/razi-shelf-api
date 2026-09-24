-- =====================================================================
-- 004  UPC matching
--
-- The item file and BRdata store UPCs without the trailing check digit
-- (11 digits, zero padded). A scanner reads the full 12-digit UPC-A off
-- the product. Those are the same item and must match.
--
-- shelf_upc_key() turns any of these into one canonical 12-digit UPC-A:
--   11 digits (no check digit)  -> add the check digit
--   12 digits                   -> already UPC-A
--   13 digits starting with 0   -> drop the leading zero (EAN-13 of a UPC)
--   14 digits starting with 00  -> drop both (GTIN-14 of a UPC)
--    8 digits                   -> expand UPC-E to UPC-A
-- Anything else returns NULL and falls back to plain digit matching.
-- =====================================================================

BEGIN;

CREATE OR REPLACE FUNCTION shelf_upc_check_digit(d11 TEXT)
RETURNS TEXT LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE s INT := 0; i INT;
BEGIN
  IF length(d11) <> 11 OR d11 !~ '^[0-9]+$' THEN RETURN NULL; END IF;
  FOR i IN 1..11 LOOP
    s := s + substr(d11, i, 1)::INT * CASE WHEN i % 2 = 1 THEN 3 ELSE 1 END;
  END LOOP;
  RETURN ((10 - (s % 10)) % 10)::TEXT;
END $$;

-- UPC-E (8 digits, including its number system and check digit) -> UPC-A (12)
CREATE OR REPLACE FUNCTION shelf_upce_to_upca(e TEXT)
RETURNS TEXT LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE ns TEXT; body TEXT; chk TEXT; last TEXT; a TEXT;
BEGIN
  IF length(e) <> 8 OR e !~ '^[01][0-9]{7}$' THEN RETURN NULL; END IF;
  ns := substr(e, 1, 1); body := substr(e, 2, 6); chk := substr(e, 8, 1);
  last := substr(body, 6, 1);
  a := CASE last
         WHEN '0' THEN ns || substr(body,1,2) || '00000' || substr(body,3,3)
         WHEN '1' THEN ns || substr(body,1,2) || '10000' || substr(body,3,3)
         WHEN '2' THEN ns || substr(body,1,2) || '20000' || substr(body,3,3)
         WHEN '3' THEN ns || substr(body,1,3) || '00000' || substr(body,4,2)
         WHEN '4' THEN ns || substr(body,1,4) || '00000' || substr(body,5,1)
         ELSE           ns || substr(body,1,5) || '0000'  || last
       END;
  RETURN a || chk;
END $$;

CREATE OR REPLACE FUNCTION shelf_upc_key(raw TEXT)
RETURNS TEXT LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE d TEXT; c TEXT;
BEGIN
  IF raw IS NULL THEN RETURN NULL; END IF;
  d := regexp_replace(raw, '[^0-9]', '', 'g');
  IF d = '' THEN RETURN NULL; END IF;
  d := regexp_replace(d, '^0+', '');
  IF d = '' THEN RETURN NULL; END IF;

  IF length(d) = 8 THEN
    c := shelf_upce_to_upca(lpad(d, 8, '0'));
    IF c IS NOT NULL THEN RETURN c; END IF;
  END IF;
  IF length(d) = 14 AND substr(d, 1, 2) = '00' THEN d := substr(d, 3); END IF;
  IF length(d) = 13 AND substr(d, 1, 1) = '0' THEN d := substr(d, 2); END IF;
  IF length(d) = 12 THEN RETURN d; END IF;
  IF length(d) <= 11 THEN
    d := lpad(d, 11, '0');
    RETURN d || shelf_upc_check_digit(d);
  END IF;
  RETURN NULL;                                  -- longer than a UPC: no canonical form
END $$;

-- Canonical key kept beside every item, maintained by the database itself.
ALTER TABLE items ADD COLUMN IF NOT EXISTS upc_key TEXT
  GENERATED ALWAYS AS (shelf_upc_key(upc)) STORED;
CREATE INDEX IF NOT EXISTS items_upc_key_idx ON items (upc_key);

-- Aisle cards are also scanned to START an aisle, not only to sign it off.
ALTER TABLE zone_signoffs DROP CONSTRAINT IF EXISTS zone_signoffs_kind_check;
ALTER TABLE zone_signoffs ADD CONSTRAINT zone_signoffs_kind_check
  CHECK (kind IN ('start','tags','confirm','sweep'));

-- Bulk "we already handled these" marks, so a backlog can be cleared honestly
-- and undone if someone clears the wrong thing.
ALTER TABLE tag_work ADD COLUMN IF NOT EXISTS batch_id TEXT;
CREATE INDEX IF NOT EXISTS tag_work_batch_idx ON tag_work (store_id, batch_id);

INSERT INTO schema_version (version) VALUES (4) ON CONFLICT DO NOTHING;

COMMIT;
