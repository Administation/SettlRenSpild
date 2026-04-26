// UC-16 Helligdage og deres effekt på tømningsruter.
const express = require('express');
const router = express.Router();
const { query, one, pool } = require('../db');

router.get('/', async (req, res, next) => {
  try {
    const { kommune_id, aar } = req.query;
    const where = [];
    const params = [];
    if (kommune_id) { params.push(kommune_id); where.push(`(kommune_id = $${params.length} OR kommune_id IS NULL)`); }
    if (aar) {
      params.push(`${aar}-01-01`);
      params.push(`${aar}-12-31`);
      where.push(`dato BETWEEN $${params.length-1} AND $${params.length}`);
    }
    const rows = await query(`
      SELECT * FROM helligdage
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY dato
    `, params);
    res.json(rows);
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const { kommune_id, dato, navn, forskyder_til, noter } = req.body;
    if (!dato || !navn) return res.status(400).json({ error: 'dato og navn påkrævet' });
    await pool.query(
      `INSERT INTO helligdage (kommune_id, dato, navn, forskyder_til, noter)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (kommune_id, dato) DO UPDATE SET
         navn = EXCLUDED.navn, forskyder_til = EXCLUDED.forskyder_til, noter = EXCLUDED.noter`,
      [kommune_id || null, dato, navn, forskyder_til || null, noter || null]
    );
    res.status(201).json({ ok: true });
  } catch (e) { next(e); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    await pool.query(`DELETE FROM helligdage WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Justér eksisterende tømningsplaner ud fra helligdage:
// hvis en planlagt tømning falder på helligdag, flyt til forskyder_til (ellers næste hverdag).
router.post('/justér-planer', async (req, res, next) => {
  try {
    const helligdage = await query(`SELECT dato, forskyder_til FROM helligdage WHERE dato >= CURRENT_DATE`);
    let flyttet = 0;
    for (const h of helligdage) {
      const datoStr = h.dato instanceof Date ? h.dato.toISOString().slice(0,10) : String(h.dato).slice(0,10);
      let nyDato = h.forskyder_til ? (h.forskyder_til instanceof Date ? h.forskyder_til.toISOString().slice(0,10) : String(h.forskyder_til).slice(0,10)) : null;
      if (!nyDato) {
        // Find næste hverdag.
        const d = new Date(datoStr);
        do { d.setDate(d.getDate() + 1); } while (d.getDay() === 0 || d.getDay() === 6);
        nyDato = d.toISOString().slice(0,10);
      }
      const r = await pool.query(
        `UPDATE tomningsplaner SET planlagt_dato = $1
         WHERE planlagt_dato = $2 AND status = 'planlagt'`,
        [nyDato, datoStr]
      );
      flyttet += r.rowCount;
    }
    res.json({ ok: true, flyttet });
  } catch (e) { next(e); }
});

module.exports = router;
