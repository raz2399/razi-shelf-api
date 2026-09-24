'use strict';
// Razi-Nova Shelf API server.
// On every start it brings the database up to date by itself:
//   001 schema       - always applied, safe to repeat
//   002 seed store   - only when the database has no stores yet
//   003 store tools  - always applied, safe to repeat
const fs = require('fs');
const path = require('path');
const express = require('express');
const { Pool } = require('pg');
const shelf = require('./shelf');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false }
});

async function migrate() {
  const run = f => pool.query(fs.readFileSync(path.join(__dirname, 'db', f), 'utf8'));
  await run('001_schema.sql');
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM stores');
  if (rows[0].n === 0) { await run('002_seed_lindsay.sql'); console.log('seeded first store'); }
  await run('003_new_store.sql');
  await run('004_upc_and_bulk.sql');
  const v = await pool.query('SELECT MAX(version) AS v FROM schema_version');
  console.log('database ready, schema v' + v.rows[0].v);
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  if (!process.env.SHELF_API_TOKEN) console.warn('WARNING: SHELF_API_TOKEN not set - API is open to anyone');
  await migrate();
  const app = express();
  app.get('/health', (req, res) => res.json({ ok: true }));
  app.use('/api/shelf/v1', shelf({ pool }));
  const port = process.env.PORT || 8080;
  app.listen(port, () => console.log('shelf api listening on :' + port));
}

main().catch(e => { console.error('startup failed:', e.message); process.exit(1); });
