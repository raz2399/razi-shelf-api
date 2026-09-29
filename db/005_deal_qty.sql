-- =====================================================================
-- 005  Deal quantity
--
-- BRdata carries how many units the deal price covers: "2 for $5.00".
-- Without it a card reads "$5.00, was $1.99", which is nonsense on a shelf.
-- unit_price is what compares against regular retail; sale_price is what
-- the shelf tag says.
-- =====================================================================
BEGIN;

ALTER TABLE deals ADD COLUMN IF NOT EXISTS qty INT NOT NULL DEFAULT 1
  CHECK (qty >= 1 AND qty <= 99);

-- The per-unit price of a deal, for honest comparison with regular retail.
CREATE OR REPLACE FUNCTION shelf_unit_price(sale NUMERIC, qty INT)
RETURNS NUMERIC LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN sale IS NULL OR qty IS NULL OR qty < 1 THEN sale
              ELSE ROUND(sale / qty, 2) END
$$;

INSERT INTO schema_version (version) VALUES (5) ON CONFLICT DO NOTHING;
COMMIT;
