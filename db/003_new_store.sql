-- =====================================================================
-- Adding a store. Copies another store's zones and rules as a starting
-- point; locations, deals and history always start empty.
--   SELECT shelf_clone_store('lindsay', 'porterville', 'Razco Foods Porterville');
-- Then edit the new store's zones to match its real layout.
-- =====================================================================
CREATE OR REPLACE FUNCTION shelf_clone_store(src TEXT, new_code TEXT, new_name TEXT, tz TEXT DEFAULT 'America/Los_Angeles')
RETURNS INT LANGUAGE plpgsql AS $$
DECLARE s_id INT; n_id INT;
BEGIN
  SELECT id INTO s_id FROM stores WHERE code = src;
  IF s_id IS NULL THEN RAISE EXCEPTION 'source store % not found', src; END IF;
  INSERT INTO stores (code, name, timezone, look_back_days, look_ahead_days, suggest_after)
  SELECT lower(new_code), new_name, tz, look_back_days, look_ahead_days, suggest_after FROM stores WHERE id = s_id
  RETURNING id INTO n_id;
  INSERT INTO zones (store_id, code, aisle, side, name, contents, walk_order, kind, qr_code)
  SELECT n_id, code, aisle, side, name, contents, walk_order, kind,
         'RZN-' || upper(new_code) || '-' || code
    FROM zones WHERE store_id = s_id AND active;
  INSERT INTO zone_rules (store_id, priority, match_type, pattern, zone_code, note, created_by)
  SELECT n_id, priority, match_type, pattern, zone_code, 'cloned from ' || src, 'clone'
    FROM zone_rules WHERE store_id = s_id AND active;
  RETURN n_id;
END $$;
