// UC-43 Audit-trail — fuld søgbar log over kritiske ændringer.
const express = require('express');
const router = express.Router();
const { query, one } = require('../db');
const { parsePaging, paginatedQuery } = require('../lib/pagination');
const { pool } = require('../db');

router.get('/', async (req, res, next) => {
  try {
    const { entitet, handling, bruger, q } = req.query;
    const { limit, offset } = parsePaging(req.query, { limit: 100 });
    const where = [];
    const params = [];
    if (entitet)  { params.push(entitet);  where.push(`entitet  = $${params.length}`); }
    if (handling) { params.push(handling); where.push(`handling = $${params.length}`); }
    if (bruger)   { params.push(bruger);   where.push(`bruger   = $${params.length}`); }
    if (q) {
      params.push(`%${q}%`);
      where.push(`(entitet_id ILIKE $${params.length} OR detaljer::text ILIKE $${params.length})`);
    }
    const result = await paginatedQuery(pool, {
      selectSql: '*',
      fromSql: 'audit_log',
      whereSql: where.join(' AND '),
      params,
      orderBy: 'oprettet DESC',
      limit, offset,
    });
    res.json(result);
  } catch (e) { next(e); }
});

router.get('/distinct/:felt', async (req, res, next) => {
  try {
    const validFields = ['entitet','handling','bruger'];
    if (!validFields.includes(req.params.felt)) return res.status(400).json({ error: 'Ugyldigt felt' });
    const rows = await query(`
      SELECT ${req.params.felt} AS v, COUNT(*)::int AS n FROM audit_log
      WHERE ${req.params.felt} IS NOT NULL
      GROUP BY ${req.params.felt} ORDER BY n DESC LIMIT 50
    `);
    res.json(rows);
  } catch (e) { next(e); }
});

module.exports = router;
