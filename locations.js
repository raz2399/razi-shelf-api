'use strict';
// Location memory. The one place that decides where an item lives.
//   scan        a person scanned it on the shelf in that zone      (trust 3)
//   correction  a person said "it's actually in this zone"         (trust 2)
//   rule        the placement engine guessed from the description  (trust 1)
// Human evidence always replaces a guess. A guess never replaces human evidence.

const { rulesFor, place, forget } = require('./matcher');

const HUMAN = new Set(['scan', 'correction']);

// Guess locations for items that have no human-verified location yet.
// Pass upcs to limit the work; omit to refresh every rule-sourced row for the store.
async function applyRules(pool, storeId, upcs) {
  const compiled = await rulesFor(pool, storeId);
  const params = [storeId];
  let filter = `
    SELECT i.upc, i.description, i.dept
      FROM items i
      LEFT JOIN item_locations l ON l.store_id = $1 AND l.upc = i.upc
     WHERE (l.upc IS NULL OR l.source = 'rule')`;
  if (upcs) {
    params.push(upcs);
    filter += ' AND i.upc = ANY($2)';
  } else {
    filter += ` AND i.upc IN (SELECT upc FROM item_locations WHERE store_id = $1 AND source = 'rule'
                              UNION SELECT upc FROM deals WHERE store_id = $1)`;
  }
  const { rows } = await pool.query(filter, params);

  const setUpc = [], setZone = [], setRule = [], clearUpc = [];
  for (const r of rows) {
    const p = place(compiled, r.description, r.dept);
    if (p) { setUpc.push(r.upc); setZone.push(p.zone); setRule.push(p.ruleId); }
    else clearUpc.push(r.upc);
  }

  if (setUpc.length) {
    await pool.query(
      `INSERT INTO item_locations (store_id, upc, zone_code, source, rule_id, updated_at)
       SELECT $1, u, z, 'rule', r, NOW() FROM UNNEST($2::text[], $3::text[], $4::int[]) AS t(u, z, r)
       ON CONFLICT (store_id, upc) DO UPDATE
         SET zone_code = EXCLUDED.zone_code, rule_id = EXCLUDED.rule_id, updated_at = NOW()
       WHERE item_locations.source = 'rule'
         AND (item_locations.zone_code IS DISTINCT FROM EXCLUDED.zone_code
              OR item_locations.rule_id IS DISTINCT FROM EXCLUDED.rule_id)`,
      [storeId, setUpc, setZone, setRule]
    );
  }
  if (clearUpc.length) {
    // No rule claims these anymore: drop stale guesses so they show as unplaced.
    await pool.query(
      `DELETE FROM item_locations WHERE store_id = $1 AND source = 'rule' AND upc = ANY($2)`,
      [storeId, clearUpc]
    );
  }
  return { guessed: setUpc.length, unplaced: clearUpc.length };
}

// Record human evidence of where an item lives. Idempotent on clientId.
async function setLocation(pool, { storeId, upc, zone, source, actor, device = '', note = '', clientId = null, section = '', shelf = '' }) {
  if (!HUMAN.has(source)) throw new Error('setLocation only accepts human sources');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const z = await client.query('SELECT 1 FROM zones WHERE store_id = $1 AND code = $2 AND active', [storeId, zone]);
    if (!z.rowCount) { await client.query('ROLLBACK'); return { error: 'unknown zone ' + zone, status: 400 }; }

    const cur = await client.query(
      'SELECT * FROM item_locations WHERE store_id = $1 AND upc = $2 FOR UPDATE',
      [storeId, upc]
    );
    const prev = cur.rows[0] || null;
    const guessRule = prev ? (prev.source === 'rule' ? prev.rule_id : prev.guess_rule_id) : null;
    const changed = !prev || prev.zone_code !== zone || prev.source === 'rule';

    // Idempotency: the event row is the receipt. A replayed request stops here.
    if (clientId || changed) {
      const ev = await client.query(
        `INSERT INTO location_events
           (store_id, upc, from_zone, to_zone, from_source, source, rule_id, actor, device, note, client_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (client_id) DO NOTHING RETURNING id`,
        [storeId, upc, prev ? prev.zone_code : null, zone, prev ? prev.source : null,
         source, guessRule, actor, device, note, clientId]
      );
      if (!ev.rowCount) { await client.query('ROLLBACK'); return { duplicate: true }; }
    }

    // A correction does not downgrade a scan in the same zone; it only moves an item.
    const keepSource = prev && prev.source === 'scan' && source === 'correction' && prev.zone_code === zone;
    const finalSource = keepSource ? 'scan' : source;

    await client.query(
      `INSERT INTO item_locations
         (store_id, upc, zone_code, section, shelf, source, rule_id, guess_rule_id,
          verified_by, verified_at, scan_count, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,NULL,$7,$8,NOW(),$9,NOW())
       ON CONFLICT (store_id, upc) DO UPDATE SET
         zone_code     = EXCLUDED.zone_code,
         section       = COALESCE(NULLIF(EXCLUDED.section,''), item_locations.section),
         shelf         = COALESCE(NULLIF(EXCLUDED.shelf,''),   item_locations.shelf),
         source        = EXCLUDED.source,
         rule_id       = NULL,
         guess_rule_id = COALESCE(item_locations.guess_rule_id, EXCLUDED.guess_rule_id),
         verified_by   = EXCLUDED.verified_by,
         verified_at   = NOW(),
         scan_count    = item_locations.scan_count + $9,
         updated_at    = NOW()`,
      [storeId, upc, zone, section, shelf, finalSource, guessRule, actor, source === 'scan' ? 1 : 0]
    );

    let suggestion = null;
    if (guessRule) suggestion = await maybeSuggest(client, storeId, guessRule);

    await client.query('COMMIT');
    return {
      upc, zone, source: finalSource,
      was: prev ? { zone: prev.zone_code, source: prev.source } : null,
      moved: !!prev && prev.zone_code !== zone,
      suggestion
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// When people keep moving items away from what a rule guessed, propose a change.
// Weighs the evidence both ways so a rule that is right for most items is not broken.
async function maybeSuggest(db, storeId, ruleId) {
  const rule = await db.query('SELECT id, pattern, zone_code FROM zone_rules WHERE id = $1 AND store_id = $2', [ruleId, storeId]);
  if (!rule.rowCount) return null;
  const r = rule.rows[0];
  const st = await db.query('SELECT suggest_after FROM stores WHERE id = $1', [storeId]);
  const need = st.rows[0].suggest_after;

  const tally = await db.query(
    `SELECT l.zone_code, COUNT(*)::int AS n,
            (ARRAY_AGG(i.description ORDER BY l.verified_at DESC))[1:5] AS sample
       FROM item_locations l JOIN items i ON i.upc = l.upc
      WHERE l.store_id = $1 AND l.guess_rule_id = $2 AND l.source IN ('scan','correction')
      GROUP BY l.zone_code`,
    [storeId, ruleId]
  );
  const agreed = (tally.rows.find(t => t.zone_code === r.zone_code) || { n: 0 }).n;
  const best = tally.rows.filter(t => t.zone_code !== r.zone_code).sort((a, b) => b.n - a.n)[0];
  if (!best || best.n < need || best.n <= agreed) return null;

  const rejected = await db.query(
    `SELECT moved FROM rule_suggestions
      WHERE store_id = $1 AND rule_id = $2 AND to_zone = $3 AND status = 'rejected'
      ORDER BY decided_at DESC LIMIT 1`,
    [storeId, ruleId, best.zone_code]
  );
  if (rejected.rowCount && best.n < rejected.rows[0].moved * 2) return null;

  const up = await db.query(
    `INSERT INTO rule_suggestions (store_id, rule_id, from_zone, to_zone, moved, agreed, sample)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (store_id, rule_id, to_zone) WHERE status = 'pending'
     DO UPDATE SET moved = EXCLUDED.moved, agreed = EXCLUDED.agreed,
                   sample = EXCLUDED.sample, updated_at = NOW()
     RETURNING id`,
    [storeId, ruleId, r.zone_code, best.zone_code, best.n, agreed, (best.sample || []).join(' | ')]
  );
  return { id: up.rows[0].id, pattern: r.pattern, from: r.zone_code, to: best.zone_code, moved: best.n, agreed };
}

async function decideSuggestion(pool, { storeId, id, decision, actor }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const s = await client.query(
      `SELECT * FROM rule_suggestions WHERE id = $1 AND store_id = $2 AND status = 'pending' FOR UPDATE`,
      [id, storeId]
    );
    if (!s.rowCount) { await client.query('ROLLBACK'); return { error: 'suggestion not found or already decided', status: 404 }; }
    const sug = s.rows[0];
    await client.query(
      `UPDATE rule_suggestions SET status = $1, decided_by = $2, decided_at = NOW(), updated_at = NOW() WHERE id = $3`,
      [decision === 'approve' ? 'approved' : 'rejected', actor, id]
    );
    if (decision === 'approve') {
      await client.query(
        `UPDATE zone_rules SET zone_code = $1, updated_at = NOW(),
                note = TRIM(note || ' moved ' || $2 || '->' || $1 || ' by ' || $3)
          WHERE id = $4 AND store_id = $5`,
        [sug.to_zone, sug.from_zone, actor, sug.rule_id, storeId]
      );
    }
    await client.query('COMMIT');
    forget(storeId);
    let refreshed = null;
    if (decision === 'approve') {
      const { rows } = await pool.query(
        `SELECT upc FROM item_locations WHERE store_id = $1 AND source = 'rule' AND rule_id = $2`,
        [storeId, sug.rule_id]
      );
      refreshed = await applyRules(pool, storeId, rows.map(r => r.upc));
    }
    return { ok: true, decision, refreshed };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { applyRules, setLocation, maybeSuggest, decideSuggestion };
