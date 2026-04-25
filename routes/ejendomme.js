const express = require('express');
const router = express.Router();
const { query, one, pool } = require('../db');

function genEjendomId() {
  return 'EJ-' + Math.random().toString(36).slice(2, 8).toUpperCase();
}

// Mocked BBR / DAWA opslag — i v1 er det bare et hardcoded svar.
// I v2 udskiftes med kald til Datafordeleren / dawa.aws.dk.
router.get('/bbr-lookup', (req, res) => {
  const { vejnavn = '', husnr = '', postnr = '' } = req.query;
  res.json({
    bbr_id: 'BBR-' + Math.random().toString(36).slice(2, 8).toUpperCase(),
    bfe_nr: String(Math.floor(1000000 + Math.random() * 9000000)),
    vejnavn, husnr, postnr,
    by: postnr === '7500' ? 'Holstebro' : postnr === '7400' ? 'Herning' : 'Ukendt',
    ejendomstype: 'Helårsbeboelse',
    matrikel: '1a, Holstebro By',
    kilde: 'mock',
  });
});

router.get('/', async (req, res, next) => {
  try {
    const { kommune_id, q } = req.query;
    const where = [];
    const params = [];
    if (kommune_id) { params.push(kommune_id); where.push(`kommune_id = $${params.length}`); }
    if (q) {
      params.push(`%${q}%`);
      where.push(`(vejnavn ILIKE $${params.length} OR postnr ILIKE $${params.length} OR by ILIKE $${params.length})`);
    }
    const sql = `SELECT * FROM ejendomme ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY postnr, vejnavn LIMIT 200`;
    res.json(await query(sql, params));
  } catch (e) { next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const e = await one(`SELECT * FROM ejendomme WHERE id = $1`, [req.params.id]);
    if (!e) return res.status(404).json({ error: 'Ejendom ikke fundet' });
    const kontrakter = await query(`
      SELECT k.*, ku.navn AS kunde_navn
      FROM kontrakter k JOIN kunder ku ON ku.id = k.kunde_id
      WHERE k.ejendom_id = $1
    `, [req.params.id]);
    res.json({ ...e, kontrakter });
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const id = req.body.id || genEjendomId();
    const { bbr_id, bfe_nr, vejnavn, husnr, etage, doer, postnr, by, kommune_id, ejendomstype, matrikel } = req.body;
    if (!vejnavn || !postnr || !by) return res.status(400).json({ error: 'vejnavn, postnr og by påkrævet' });
    await pool.query(
      `INSERT INTO ejendomme (id, bbr_id, bfe_nr, vejnavn, husnr, etage, doer, postnr, by, kommune_id, ejendomstype, matrikel)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, bbr_id, bfe_nr, vejnavn, husnr, etage, doer, postnr, by, kommune_id, ejendomstype, matrikel]
    );
    res.status(201).json(await one(`SELECT * FROM ejendomme WHERE id = $1`, [id]));
  } catch (e) { next(e); }
});

module.exports = router;
