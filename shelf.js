'use strict';
// Razi-Nova Shelf API  ·  v1
// Mount once in your server:
//   const shelf = require('./shelf/shelf');
//   app.use('/api/shelf/v1', shelf({ pool }));
//
// Every store-scoped route lives under /s/:store where :store is the store code.

const express = require('express');
const { types } = require('pg');
const { applyRules, setLocation, decideSuggestion } = require('./locations');

const CHUNK = 2000;

// Calendar dates stay calendar dates ('2026-09-22'), never shifted by time zones.
// Money comes back as a number. These are process-wide pg settings.
types.setTypeParser(1082, v => v);                 // DATE
types.setTypeParser(1700, v => v === null ? null : parseFloat(v)); // NUMERIC

module.exports = function shelfRouter({ pool, token = process.env.SHELF_API_TOKEN, corsOrigin = process.env.SHELF_CORS_ORIGIN || '*' }) {
  const r = express.Router();
  r.use(express.json({ limit: '25mb' }));

  // ---------- CORS: the phone app is served from another origin ----------
  r.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', corsOrigin);
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Shelf-Token');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // ---------- optional shared token ----------
  r.use((req, res, next) => {
    if (!token) return next();
    const given = req.get('X-Shelf-Token') || (req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (given === token) return next();
    res.status(401).json({ error: 'unauthorized' });
  });

  const wrap = fn => (req, res) => fn(req, res).catch(e => {
    console.error('[shelf]', req.method, req.originalUrl, e);
    res.status(500).json({ error: e.message });
  });

  // ---------- input helpers ----------
  const str = (v, max = 200) => String(v == null ? '' : v).trim().slice(0, max);
  const upcOf = v => str(v, 32).replace(/\D/g, '').replace(/^0+/, '') || null;
  const dateOf = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null;
  const money = v => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) / 100 : null; };
  const bad = (res, msg) => res.status(400).json({ error: msg });

  // ---------- resolve the store and its local "today" ----------
  r.param('store', (req, res, next, code) => (async () => {
    const { rows } = await pool.query(
      `SELECT s.*,
              (NOW() AT TIME ZONE s.timezone)::date AS today,
              GREATEST(COALESCE(s.cleared_through, '1900-01-01'),
                       (NOW() AT TIME ZONE s.timezone)::date - s.look_back_days - 1) AS floor
         FROM stores s WHERE s.code = $1 AND s.active`,
      [String(code).toLowerCase()]
    );
    if (!rows.length) return res.status(404).json({ error: 'unknown store ' + code });
    req.store = rows[0];
    next();
  })().catch(e => { console.error('[shelf] store', e); res.status(500).json({ error: e.message }); }));

  // Deals that matter right now: ending inside the window, or starting soon.
  const WINDOW = `
    SELECT d.* FROM deals d
     WHERE d.store_id = $1
       AND ( (d.ends > $2::date AND d.ends <= $3::date + $4::int)
          OR (d.starts >= $3::date AND d.starts <= $3::date + $4::int) )`;
  const winArgs = s => [s.id, s.floor, s.today, s.look_ahead_days];

  // =====================================================================
  // Stores
  // =====================================================================
  r.get('/stores', wrap(async (req, res) => {
    const { rows } = await pool.query('SELECT code, name, timezone FROM stores WHERE active ORDER BY name');
    res.json({ stores: rows });
  }));

  r.get('/s/:store', wrap(async (req, res) => {
    const s = req.store;
    const { rows } = await pool.query(
      `SELECT code, aisle, side, name, contents, walk_order, kind, qr_code
         FROM zones WHERE store_id = $1 AND active ORDER BY walk_order`, [s.id]);
    res.json({ store: { code: s.code, name: s.name, today: s.today, cleared_through: s.cleared_through }, zones: rows });
  }));

  // =====================================================================
  // Items
  // =====================================================================
  r.post('/s/:store/items/import', wrap(async (req, res) => {
    const list = Array.isArray(req.body.items) ? req.body.items : [];
    if (!list.length) return bad(res, 'items required');
    let n = 0;
    for (let i = 0; i < list.length; i += CHUNK) {
      const part = list.slice(i, i + CHUNK)
        .map(x => ({ upc: upcOf(x.upc), d: str(x.description, 120), sz: str(x.size, 30), pk: str(x.pack, 20),
                     dp: str(x.dept, 60).toUpperCase(), rt: money(x.retail) }))
        .filter(x => x.upc && x.d);
      // Item files repeat UPCs. Last row wins, same as the file's own order.
      const uniq = [...new Map(part.map(x => [x.upc, x])).values()];
      part.length = 0; part.push(...uniq);
      if (!part.length) continue;
      const cols = k => part.map(x => x[k]);
      await pool.query(
        `INSERT INTO items (upc, description, size, pack, dept, updated_at)
         SELECT * , NOW() FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[], $5::text[])
         ON CONFLICT (upc) DO UPDATE SET description = EXCLUDED.description, size = EXCLUDED.size,
           pack = EXCLUDED.pack, dept = EXCLUDED.dept, updated_at = NOW()
         WHERE (items.description, items.size, items.pack, items.dept)
               IS DISTINCT FROM (EXCLUDED.description, EXCLUDED.size, EXCLUDED.pack, EXCLUDED.dept)`,
        [cols('upc'), cols('d'), cols('sz'), cols('pk'), cols('dp')]
      );
      await pool.query(
        `INSERT INTO store_items (store_id, upc, retail, updated_at)
         SELECT $1, u, r, NOW() FROM UNNEST($2::text[], $3::numeric[]) AS t(u, r)
         ON CONFLICT (store_id, upc) DO UPDATE SET retail = EXCLUDED.retail, active = TRUE, updated_at = NOW()
         WHERE store_items.retail IS DISTINCT FROM EXCLUDED.retail OR NOT store_items.active`,
        [req.store.id, cols('upc'), cols('rt')]
      );
      n += part.length;
    }
    // Descriptions may have changed: refresh guesses. Bulk loaders pass ?defer=1 on all but the last chunk.
    const placed = req.query.defer ? null : await applyRules(pool, req.store.id);
    res.json({ ok: true, items: n, placed });
  }));

  r.get('/s/:store/items/:upc', wrap(async (req, res) => {
    const upc = upcOf(req.params.upc);
    if (!upc) return bad(res, 'bad upc');
    const { rows } = await pool.query(
      `SELECT i.upc, i.description, i.size, i.pack, i.dept, si.retail,
              l.zone_code, l.source, l.section, l.shelf, z.aisle, z.side, z.name AS zone_name
         FROM items i
         LEFT JOIN store_items si   ON si.store_id = $1 AND si.upc = i.upc
         LEFT JOIN item_locations l ON l.store_id = $1 AND l.upc = i.upc
         LEFT JOIN zones z          ON z.store_id = $1 AND z.code = l.zone_code
        WHERE i.upc = $2`, [req.store.id, upc]);
    if (!rows.length) return res.status(404).json({ error: 'not in item file', upc });
    res.json({ item: rows[0] });
  }));

  // =====================================================================
  // Deals
  // =====================================================================
  r.post('/s/:store/deals/import', wrap(async (req, res) => {
    const list = Array.isArray(req.body.deals) ? req.body.deals : [];
    if (!list.length) return bad(res, 'deals required');
    let n = 0; const upcs = new Set();
    for (let i = 0; i < list.length; i += CHUNK) {
      const part = list.slice(i, i + CHUNK)
        .map(x => ({ upc: upcOf(x.upc), t: str(x.deal_type, 8).toUpperCase(), s: dateOf(x.starts),
                     e: dateOf(x.ends), p: money(x.sale_price), v: str(x.vendor, 30) }))
        .filter(x => x.upc && x.t && x.e);
      const uniq = [...new Map(part.map(x => [[x.upc, x.t, x.s, x.e].join('|'), x])).values()];
      part.length = 0; part.push(...uniq);
      if (!part.length) continue;
      part.forEach(x => upcs.add(x.upc));
      const cols = k => part.map(x => x[k]);
      await pool.query(
        `INSERT INTO deals (store_id, upc, deal_type, starts, ends, sale_price, vendor, source)
         SELECT $1, u, t, s, e, p, v, 'brdata'
           FROM UNNEST($2::text[], $3::text[], $4::date[], $5::date[], $6::numeric[], $7::text[]) AS x(u,t,s,e,p,v)
         ON CONFLICT (store_id, upc, deal_type, starts, ends) DO UPDATE
           SET sale_price = EXCLUDED.sale_price, vendor = EXCLUDED.vendor
         WHERE deals.sale_price IS DISTINCT FROM EXCLUDED.sale_price OR deals.vendor IS DISTINCT FROM EXCLUDED.vendor`,
        [req.store.id, cols('upc'), cols('t'), cols('s'), cols('e'), cols('p'), cols('v')]
      );
      n += part.length;
    }
    const placed = req.query.defer ? null : await applyRules(pool, req.store.id);
    res.json({ ok: true, deals: n, placed });
  }));

  r.post('/s/:store/deals/plan', wrap(async (req, res) => {
    const upc = upcOf(req.body.upc), starts = dateOf(req.body.starts), ends = dateOf(req.body.ends);
    const price = money(req.body.sale_price), actor = str(req.body.actor, 60);
    if (!upc || !starts || !ends || !price || !actor) return bad(res, 'upc, starts, ends, sale_price, actor required');
    if (ends < starts) return bad(res, 'ends before starts');
    const it = await pool.query('SELECT 1 FROM items WHERE upc = $1', [upc]);
    if (!it.rowCount) return res.status(404).json({ error: 'not in item file', upc });
    const { rows } = await pool.query(
      `INSERT INTO deals (store_id, upc, deal_type, starts, ends, sale_price, source, created_by)
       VALUES ($1,$2,'AD',$3,$4,$5,'ad_plan',$6)
       ON CONFLICT (store_id, upc, deal_type, starts, ends) DO UPDATE SET sale_price = EXCLUDED.sale_price
       RETURNING id`, [req.store.id, upc, starts, ends, price, actor]);
    await applyRules(pool, req.store.id, [upc]);
    res.json({ ok: true, id: rows[0].id });
  }));

  r.get('/s/:store/deals/planned', wrap(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT d.id, d.upc, d.starts, d.ends, d.sale_price, d.created_by, i.description, i.size, si.retail,
              l.zone_code, z.aisle, z.side
         FROM deals d
         JOIN items i ON i.upc = d.upc
         LEFT JOIN store_items si   ON si.store_id = d.store_id AND si.upc = d.upc
         LEFT JOIN item_locations l ON l.store_id = d.store_id AND l.upc = d.upc
         LEFT JOIN zones z          ON z.store_id = d.store_id AND z.code = l.zone_code
        WHERE d.store_id = $1 AND d.source = 'ad_plan' AND d.ends >= $2
        ORDER BY d.starts, i.description`, [req.store.id, req.store.today]);
    res.json({ planned: rows });
  }));

  r.get('/s/:store/expiring', wrap(async (req, res) => {
    const days = Math.min(Math.max(parseInt(req.query.days || '7', 10), 1), 60);
    const { rows } = await pool.query(
      `SELECT d.upc, d.deal_type, d.ends, d.sale_price, i.description, i.size, si.retail,
              l.zone_code, l.source, z.aisle, z.side, z.walk_order
         FROM deals d
         LEFT JOIN items i          ON i.upc = d.upc
         LEFT JOIN store_items si   ON si.store_id = d.store_id AND si.upc = d.upc
         LEFT JOIN item_locations l ON l.store_id = d.store_id AND l.upc = d.upc
         LEFT JOIN zones z          ON z.store_id = d.store_id AND z.code = l.zone_code
        WHERE d.store_id = $1 AND d.ends >= $2 AND d.ends <= $2::date + $3::int
        ORDER BY d.ends, z.walk_order NULLS LAST, i.description`,
      [req.store.id, req.store.today, days]);
    res.json({ today: req.store.today, expiring: rows });
  }));

  // =====================================================================
  // Confirm mode: walk an aisle, prove where items really are
  // =====================================================================
  r.get('/s/:store/confirm', wrap(async (req, res) => {
    const { rows } = await pool.query(
      `WITH w AS (${WINDOW}), u AS (SELECT DISTINCT upc FROM w)
       SELECT COALESCE(l.zone_code, '?') AS zone_code,
              COUNT(*) FILTER (WHERE l.source = 'scan')::int       AS scanned,
              COUNT(*) FILTER (WHERE l.source = 'correction')::int AS corrected,
              COUNT(*) FILTER (WHERE l.source = 'rule')::int       AS guessed,
              COUNT(*) FILTER (WHERE l.upc IS NULL)::int           AS unplaced
         FROM u LEFT JOIN item_locations l ON l.store_id = $1 AND l.upc = u.upc
        GROUP BY 1`, winArgs(req.store));
    const zones = await pool.query(
      'SELECT code, aisle, side, name, walk_order FROM zones WHERE store_id = $1 AND active ORDER BY walk_order', [req.store.id]);
    const by = Object.fromEntries(rows.map(x => [x.zone_code, x]));
    const out = zones.rows.map(z => ({ ...z, ...(by[z.code] || { scanned: 0, corrected: 0, guessed: 0, unplaced: 0 }) }));
    res.json({ zones: out, unplaced: (by['?'] || { unplaced: 0 }).unplaced });
  }));

  r.get('/s/:store/confirm/:zone', wrap(async (req, res) => {
    const zone = str(req.params.zone, 10).toUpperCase();
    const { rows } = await pool.query(
      `WITH w AS (${WINDOW}), u AS (SELECT DISTINCT upc FROM w)
       SELECT u.upc, i.description, i.size, si.retail, l.source, l.verified_by, l.verified_at
         FROM u
         JOIN item_locations l ON l.store_id = $1 AND l.upc = u.upc AND l.zone_code = $5
         LEFT JOIN items i ON i.upc = u.upc
         LEFT JOIN store_items si ON si.store_id = $1 AND si.upc = u.upc
        ORDER BY (l.source = 'rule') DESC, i.description`,
      [...winArgs(req.store), zone]);
    res.json({ zone, items: rows });
  }));

  r.post('/s/:store/locations/scan', wrap(async (req, res) => {
    const upc = upcOf(req.body.upc), zone = str(req.body.zone, 10).toUpperCase(), actor = str(req.body.actor, 60);
    if (!upc || !zone || !actor) return bad(res, 'upc, zone, actor required');
    const it = await pool.query(
      `SELECT i.description, i.size FROM items i WHERE i.upc = $1`, [upc]);
    if (!it.rowCount) return res.status(404).json({ error: 'not in item file', upc });
    const out = await setLocation(pool, { storeId: req.store.id, upc, zone, source: 'scan', actor,
      device: str(req.body.device, 60), clientId: str(req.body.client_id, 80) || null,
      section: str(req.body.section, 10), shelf: str(req.body.shelf, 10) });
    if (out.error) return res.status(out.status).json(out);
    res.json({ ...out, item: it.rows[0] });
  }));

  r.post('/s/:store/locations/correct', wrap(async (req, res) => {
    const upc = upcOf(req.body.upc), zone = str(req.body.zone, 10).toUpperCase(), actor = str(req.body.actor, 60);
    if (!upc || !zone || !actor) return bad(res, 'upc, zone, actor required');
    const it = await pool.query('SELECT 1 FROM items WHERE upc = $1', [upc]);
    if (!it.rowCount) return res.status(404).json({ error: 'not in item file', upc });
    const out = await setLocation(pool, { storeId: req.store.id, upc, zone, source: 'correction', actor,
      device: str(req.body.device, 60), note: str(req.body.note, 200), clientId: str(req.body.client_id, 80) || null });
    if (out.error) return res.status(out.status).json(out);
    res.json(out);
  }));

  r.get('/s/:store/locations/stats', wrap(async (req, res) => {
    const { rows } = await pool.query(
      `WITH w AS (${WINDOW}), u AS (SELECT DISTINCT upc FROM w)
       SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE l.source = 'scan')::int       AS scanned,
              COUNT(*) FILTER (WHERE l.source = 'correction')::int AS corrected,
              COUNT(*) FILTER (WHERE l.source = 'rule')::int       AS guessed,
              COUNT(*) FILTER (WHERE l.upc IS NULL)::int           AS unplaced
         FROM u LEFT JOIN item_locations l ON l.store_id = $1 AND l.upc = u.upc`, winArgs(req.store));
    const x = rows[0];
    x.confirmed_pct = x.total ? Math.round((x.scanned + x.corrected) / x.total * 100) : 0;
    res.json(x);
  }));

  // =====================================================================
  // Tag work: hang new tags, pull expired ones, zone by zone
  // =====================================================================
  // One card per item and action. Several deal rows can collapse into one card.
  const OPEN_WORK = `
    WITH cand AS (
      SELECT d.*, 'pull'::text AS action FROM deals d
       WHERE d.store_id = $1 AND d.ends < $3 AND d.ends > $2
      UNION ALL
      SELECT d.*, 'hang'::text AS action FROM deals d
       WHERE d.store_id = $1 AND d.starts <= $3 AND d.ends >= $3 AND d.starts > $2
    ), open AS (
      SELECT c.* FROM cand c
       WHERE NOT EXISTS (SELECT 1 FROM tag_work t WHERE t.deal_id = c.id AND t.action = c.action)
    ), card AS (
      SELECT DISTINCT ON (o.upc, o.action)
             o.upc, o.action, o.deal_type, o.starts, o.ends, o.sale_price, o.id AS deal_id
        FROM open o
       ORDER BY o.upc, o.action, CASE WHEN o.action = 'hang' THEN o.ends END DESC NULLS LAST, o.ends DESC
    )
    SELECT card.*, i.description, i.size, si.retail,
           COALESCE(l.zone_code, '?') AS zone_code, l.source AS loc_source, l.section, l.shelf
      FROM card
      LEFT JOIN items i          ON i.upc = card.upc
      LEFT JOIN store_items si   ON si.store_id = $1 AND si.upc = card.upc
      LEFT JOIN item_locations l ON l.store_id = $1 AND l.upc = card.upc`;
  const workArgs = s => [s.id, s.floor, s.today];

  r.get('/s/:store/work', wrap(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT zone_code, COUNT(*)::int AS open,
              COUNT(*) FILTER (WHERE action = 'pull')::int AS pulls,
              COUNT(*) FILTER (WHERE action = 'hang')::int AS hangs
         FROM (${OPEN_WORK}) q GROUP BY zone_code`, workArgs(req.store));
    const zones = await pool.query(
      `SELECT z.code, z.aisle, z.side, z.name, z.walk_order, z.qr_code,
              (SELECT MAX(at) FROM zone_signoffs so WHERE so.store_id = z.store_id AND so.zone_code = z.code
                 AND so.kind = 'tags' AND (so.at AT TIME ZONE $2)::date = $3) AS signed_today
         FROM zones z WHERE z.store_id = $1 AND z.active ORDER BY z.walk_order`,
      [req.store.id, req.store.timezone, req.store.today]);
    const by = Object.fromEntries(rows.map(x => [x.zone_code, x]));
    res.json({
      today: req.store.today,
      zones: zones.rows.map(z => ({ ...z, ...(by[z.code] || { open: 0, pulls: 0, hangs: 0 }) })),
      unplaced: by['?'] || { open: 0, pulls: 0, hangs: 0 }
    });
  }));

  r.get('/s/:store/work/:zone', wrap(async (req, res) => {
    const zone = str(req.params.zone, 10).toUpperCase();
    const { rows } = await pool.query(
      `SELECT * FROM (${OPEN_WORK}) q WHERE zone_code = $4
        ORDER BY (action = 'pull') DESC, section NULLS LAST, shelf NULLS LAST, description`,
      [...workArgs(req.store), zone]);
    res.json({ zone, cards: rows });
  }));

  r.post('/s/:store/work/done', wrap(async (req, res) => {
    const upc = upcOf(req.body.upc), action = str(req.body.action, 5), actor = str(req.body.actor, 60);
    const status = req.body.status === 'flagged' ? 'flagged' : 'done';
    const zone = str(req.body.zone, 10).toUpperCase() || null;
    const clientId = str(req.body.client_id, 80) || null;
    if (!upc || !['hang', 'pull'].includes(action) || !actor) return bad(res, 'upc, action, actor required');
    if (status === 'flagged' && !str(req.body.reason)) return bad(res, 'reason required when flagged');
    const s = req.store;
    const cond = action === 'pull'
      ? 'd.ends < $4 AND d.ends > $3'
      : 'd.starts <= $4 AND d.ends >= $4 AND d.starts > $3';
    const done = await pool.query(
      `INSERT INTO tag_work (store_id, deal_id, action, status, reason, verified, zone_code, actor, device, client_id)
       SELECT $1, d.id, $5, $6, $7, $8, $9, $10, $11, $12 FROM deals d
        WHERE d.store_id = $1 AND d.upc = $2 AND ${cond}
       ON CONFLICT (deal_id, action) DO NOTHING RETURNING deal_id`,
      [s.id, upc, s.floor, s.today, action, status, str(req.body.reason, 120), !!req.body.verified,
       zone, actor, str(req.body.device, 60), clientId]);
    let location = null;
    if (req.body.verified && zone && status === 'done') {
      location = await setLocation(pool, { storeId: s.id, upc, zone, source: 'scan', actor,
        device: str(req.body.device, 60), clientId: clientId ? clientId + ':loc' : null });
    }
    res.json({ ok: true, recorded: done.rowCount, location });
  }));

  r.post('/s/:store/signoff', wrap(async (req, res) => {
    const actor = str(req.body.actor, 60), qr = str(req.body.qr, 80), kind = str(req.body.kind, 10) || 'tags';
    if (!actor || !qr) return bad(res, 'actor and qr required');
    if (!['tags', 'confirm', 'sweep'].includes(kind)) return bad(res, 'bad kind');
    const z = await pool.query('SELECT code FROM zones WHERE store_id = $1 AND qr_code = $2 AND active', [req.store.id, qr]);
    if (!z.rowCount) return res.status(404).json({ error: 'that card is not an aisle card for this store' });
    const expect = str(req.body.zone, 10).toUpperCase();
    if (expect && expect !== z.rows[0].code) {
      return res.status(409).json({ error: 'wrong aisle card', scanned: z.rows[0].code, expected: expect });
    }
    const ins = await pool.query(
      `INSERT INTO zone_signoffs (store_id, zone_code, kind, actor, device, client_id)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (client_id) DO NOTHING RETURNING at`,
      [req.store.id, z.rows[0].code, kind, actor, str(req.body.device, 60), str(req.body.client_id, 80) || null]);
    res.json({ ok: true, zone: z.rows[0].code, at: ins.rows[0] ? ins.rows[0].at : null, duplicate: !ins.rowCount });
  }));

  // =====================================================================
  // Learning: rule changes proposed from corrections
  // =====================================================================
  r.get('/s/:store/suggestions', wrap(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT s.id, s.from_zone, s.to_zone, s.moved, s.agreed, s.sample, s.created_at, s.updated_at,
              r.pattern, r.match_type
         FROM rule_suggestions s JOIN zone_rules r ON r.id = s.rule_id
        WHERE s.store_id = $1 AND s.status = 'pending' ORDER BY s.moved DESC, s.updated_at DESC`,
      [req.store.id]);
    res.json({ suggestions: rows });
  }));

  r.post('/s/:store/suggestions/:id', wrap(async (req, res) => {
    const decision = str(req.body.decision, 10), actor = str(req.body.actor, 60);
    if (!['approve', 'reject'].includes(decision) || !actor) return bad(res, 'decision (approve|reject) and actor required');
    const out = await decideSuggestion(pool, { storeId: req.store.id, id: parseInt(req.params.id, 10), decision, actor });
    if (out.error) return res.status(out.status).json(out);
    res.json(out);
  }));

  // =====================================================================
  // Reporting
  // =====================================================================
  r.get('/s/:store/dashboard', wrap(async (req, res) => {
    const s = req.store;
    const [work, loc, flags, signs, sugg] = await Promise.all([
      pool.query(`SELECT COUNT(*) FILTER (WHERE action='pull')::int AS pulls,
                         COUNT(*) FILTER (WHERE action='hang')::int AS hangs FROM (${OPEN_WORK}) q`, workArgs(s)),
      pool.query(`WITH w AS (${WINDOW}), u AS (SELECT DISTINCT upc FROM w)
                  SELECT COUNT(*)::int AS total,
                         COUNT(*) FILTER (WHERE l.source IN ('scan','correction'))::int AS verified,
                         COUNT(*) FILTER (WHERE l.source = 'rule')::int AS guessed,
                         COUNT(*) FILTER (WHERE l.upc IS NULL)::int AS unplaced
                    FROM u LEFT JOIN item_locations l ON l.store_id = $1 AND l.upc = u.upc`, winArgs(s)),
      pool.query(`SELECT COUNT(*)::int AS n FROM tag_work WHERE store_id = $1 AND status = 'flagged'
                    AND (at AT TIME ZONE $2)::date = $3`, [s.id, s.timezone, s.today]),
      pool.query(`SELECT COUNT(DISTINCT zone_code)::int AS n FROM zone_signoffs WHERE store_id = $1
                    AND kind = 'tags' AND (at AT TIME ZONE $2)::date = $3`, [s.id, s.timezone, s.today]),
      pool.query(`SELECT COUNT(*)::int AS n FROM rule_suggestions WHERE store_id = $1 AND status = 'pending'`, [s.id]),
    ]);
    const l = loc.rows[0];
    res.json({
      store: s.code, today: s.today,
      open_pulls: work.rows[0].pulls, open_hangs: work.rows[0].hangs,
      flagged_today: flags.rows[0].n, zones_signed_today: signs.rows[0].n,
      locations: { ...l, confirmed_pct: l.total ? Math.round(l.verified / l.total * 100) : 0 },
      pending_suggestions: sugg.rows[0].n
    });
  }));

  r.get('/s/:store/report', wrap(async (req, res) => {
    const s = req.store;
    const { rows } = await pool.query(
      `WITH w AS (${WINDOW})
       SELECT w.upc, w.deal_type, w.starts, w.ends, w.sale_price, w.vendor, w.source AS deal_source,
              (w.ends - $3::date) AS days,
              i.description, i.size, i.pack, i.dept, si.retail,
              l.zone_code, l.source AS loc_source, z.aisle, z.side, z.name AS zone_name, z.walk_order,
              (SELECT t.status FROM tag_work t WHERE t.deal_id = w.id ORDER BY t.at DESC LIMIT 1) AS work_status
         FROM w
         LEFT JOIN items i          ON i.upc = w.upc
         LEFT JOIN store_items si   ON si.store_id = w.store_id AND si.upc = w.upc
         LEFT JOIN item_locations l ON l.store_id = w.store_id AND l.upc = w.upc
         LEFT JOIN zones z          ON z.store_id = w.store_id AND z.code = l.zone_code
        ORDER BY z.walk_order NULLS LAST, w.ends, i.description`, winArgs(s));
    const zones = await pool.query(
      'SELECT code, aisle, side, name, walk_order FROM zones WHERE store_id = $1 AND active ORDER BY walk_order', [s.id]);
    res.json({ store: { code: s.code, name: s.name, today: s.today, floor: s.floor }, zones: zones.rows, rows });
  }));

  // Admin: re-run every guess after rules are edited by hand.
  r.post('/s/:store/rules/apply', wrap(async (req, res) => {
    res.json({ ok: true, ...(await applyRules(pool, req.store.id)) });
  }));

  return r;
};
