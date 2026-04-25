const express = require('express');
const router = express.Router();
const { query, one, pool } = require('../db');
const { parsePaging, paginatedQuery } = require('../lib/pagination');

function genKontraktId() {
  return 'KO-' + Math.random().toString(36).slice(2, 8).toUpperCase();
}

router.get('/', async (req, res, next) => {
  try {
    const { kunde_id, ejendom_id, service_type, status, q } = req.query;
    const { limit, offset } = parsePaging(req.query, { limit: 50 });
    const where = [];
    const params = [];
    if (kunde_id)    { params.push(kunde_id);    where.push(`k.kunde_id     = $${params.length}`); }
    if (ejendom_id)  { params.push(ejendom_id);  where.push(`k.ejendom_id   = $${params.length}`); }
    if (service_type){ params.push(service_type);where.push(`k.service_type = $${params.length}`); }
    if (status)      { params.push(status);      where.push(`k.status       = $${params.length}`); }
    if (q) {
      params.push(`%${q}%`);
      where.push(`(ku.navn ILIKE $${params.length} OR k.id ILIKE $${params.length} OR e.vejnavn ILIKE $${params.length} OR e.by ILIKE $${params.length})`);
    }
    const result = await paginatedQuery(pool, {
      selectSql: 'k.*, ku.navn AS kunde_navn, e.vejnavn, e.husnr, e.postnr, e.by',
      fromSql: 'kontrakter k JOIN kunder ku ON ku.id = k.kunde_id LEFT JOIN ejendomme e ON e.id = k.ejendom_id',
      whereSql: where.join(' AND '),
      params,
      orderBy: 'k.oprettet DESC',
      limit,
      offset,
    });
    res.json(result);
  } catch (e) { next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const k = await one(`
      SELECT k.*, ku.navn AS kunde_navn, e.vejnavn, e.husnr, e.postnr, e.by, e.kommune_id
      FROM kontrakter k
      JOIN kunder ku ON ku.id = k.kunde_id
      LEFT JOIN ejendomme e ON e.id = k.ejendom_id
      WHERE k.id = $1
    `, [req.params.id]);
    if (!k) return res.status(404).json({ error: 'Kontrakt ikke fundet' });
    let beholdere = [];
    if (k.service_type === 'renovation') {
      beholdere = await query(`
        SELECT b.*, f.navn AS fraktion_navn, f.farve
        FROM beholdere b JOIN fraktioner f ON f.id = b.fraktion_id
        WHERE b.kontrakt_id = $1
      `, [req.params.id]);
    }
    res.json({ ...k, beholdere });
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const id = req.body.id || genKontraktId();
    const { service_type='renovation', kunde_id, ejendom_id, start_dato, slut_dato, status='aktiv', fritaget_aarsag, noter } = req.body;
    if (!kunde_id || !ejendom_id || !start_dato) return res.status(400).json({ error: 'kunde_id, ejendom_id og start_dato påkrævet' });
    await pool.query(
      `INSERT INTO kontrakter (id, service_type, kunde_id, ejendom_id, start_dato, slut_dato, status, fritaget_aarsag, noter)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, service_type, kunde_id, ejendom_id, start_dato, slut_dato, status, fritaget_aarsag, noter]
    );
    res.status(201).json(await one(`SELECT * FROM kontrakter WHERE id = $1`, [id]));
  } catch (e) { next(e); }
});

router.put('/:id', async (req, res, next) => {
  try {
    const fields = ['status','slut_dato','fritaget_aarsag','noter'];
    const sets = [];
    const params = [];
    for (const f of fields) {
      if (f in req.body) { params.push(req.body[f]); sets.push(`${f} = $${params.length}`); }
    }
    if (!sets.length) return res.json(await one(`SELECT * FROM kontrakter WHERE id = $1`, [req.params.id]));
    params.push(req.params.id);
    await pool.query(`UPDATE kontrakter SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    res.json(await one(`SELECT * FROM kontrakter WHERE id = $1`, [req.params.id]));
  } catch (e) { next(e); }
});

module.exports = router;
