// Settl RenSpild — Postgres-backet DB-modul.
// Eksporterer en pg Pool og en idempotent init() der opretter schema og seed.
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const connStr =
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  process.env.POSTGRES_PRISMA_URL;

if (!connStr) {
  console.error('[db] WARNING: DATABASE_URL / POSTGRES_URL ikke sat. DB-kald vil fejle.');
}

const pool = new Pool({
  connectionString: connStr,
  ssl:
    connStr && /localhost|127\.0\.0\.1/.test(connStr)
      ? false
      : { rejectUnauthorized: false },
  max: 5,
});

// Kort hjælpefunktion: kør en query og returnér rows.
async function query(sql, params = []) {
  const r = await pool.query(sql, params);
  return r.rows;
}

// Kør én query og returnér første row eller undefined.
async function one(sql, params = []) {
  const r = await pool.query(sql, params);
  return r.rows[0];
}

// Læs .sql-fil fra db/schema og kør den mod databasen.
async function runSchemaFile(name) {
  const file = path.join(__dirname, 'db', 'schema', name);
  const sql = fs.readFileSync(file, 'utf8');
  await pool.query(sql);
}

// Idempotent og memoiseret init: kører schema-filer og seed-data én gang per cold start.
let _initPromise = null;
async function init() {
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    await runSchemaFile('core.sql');
    await runSchemaFile('renovation.sql');
    const seed = require('./db/seed');
    await seed(pool);
    const richSeed = require('./db/rich-seed');
    await richSeed(pool);
  })().catch((e) => {
    _initPromise = null;
    throw e;
  });
  return _initPromise;
}

module.exports = { pool, query, one, init };
