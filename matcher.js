'use strict';
// Placement engine. Given a store's ordered rules, decide which zone an item
// most likely lives in from its description and department. This is only the
// first guess; anything a person scans or corrects outranks it forever.

const cache = new Map(); // storeId -> { stamp, compiled }

function normalize(text) {
  return ' ' + String(text || '').toUpperCase().replace(/[^A-Z0-9&'\-%\/ ]/g, ' ') + ' ';
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compile(rules) {
  return rules
    .filter(r => r.active)
    .sort((a, b) => a.priority - b.priority || a.id - b.id)
    .map(r => ({
      id: r.id,
      type: r.match_type,
      pattern: String(r.pattern).toUpperCase(),
      zone: r.zone_code,
      re: r.match_type === 'keyword'
        ? new RegExp('(?<![A-Z0-9])' + escapeRe(String(r.pattern).toUpperCase()) + '(?![A-Z0-9])')
        : null
    }));
}

async function rulesFor(pool, storeId) {
  const stamp = await pool.query(
    'SELECT COALESCE(MAX(updated_at), NOW()) AS s, COUNT(*)::int AS n FROM zone_rules WHERE store_id = $1',
    [storeId]
  );
  const key = stamp.rows[0].s.toISOString() + ':' + stamp.rows[0].n;
  const hit = cache.get(storeId);
  if (hit && hit.stamp === key) return hit.compiled;
  const { rows } = await pool.query(
    'SELECT id, priority, match_type, pattern, zone_code, active FROM zone_rules WHERE store_id = $1',
    [storeId]
  );
  const compiled = compile(rows);
  cache.set(storeId, { stamp: key, compiled });
  return compiled;
}

// Returns { zone, ruleId, matched } or null when nothing applies.
function place(compiled, description, dept) {
  const d = String(dept || '').toUpperCase().trim();
  const text = normalize(description);
  // Pass 1: department rules and keywords, in priority order.
  for (const r of compiled) {
    if (r.type === 'dept' && d === r.pattern) return { zone: r.zone, ruleId: r.id, matched: 'dept:' + r.pattern };
    if (r.type === 'keyword' && r.re.test(text)) return { zone: r.zone, ruleId: r.id, matched: r.pattern };
  }
  // Pass 2: department fallbacks only when no keyword claimed the item.
  for (const r of compiled) {
    if (r.type === 'dept_fallback' && d === r.pattern) return { zone: r.zone, ruleId: r.id, matched: 'dept:' + r.pattern };
  }
  return null;
}

function forget(storeId) { cache.delete(storeId); }

module.exports = { rulesFor, place, forget, normalize };
