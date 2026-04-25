const express = require('express');
const router = express.Router();
const { query, one, pool } = require('../db');

function genBeholderId() {
  return 'BH-' + Math.random().toString(36).slice(2, 8).toUpperCase();
}

router.get('/', async (req, res, next) => {
  try {
    const { kontrakt_id, fraktion_id, status } = req.query;
    const where = [];
    const params = [];
    if (kontrakt_id) { params.push(kontrakt_id); where.push(`b.kontrakt_id = $${params.length}`); }
    if (fraktion_id) { params.push(fraktion_id); where.push(`b.fraktion_id = $${params.length}`); }
    if (status)      { params.push(status);      where.push(`b.status      = $${params.length}`); }
    const sql = `
      SELECT b.*, f.navn AS fraktion_navn, f.farve, ku.navn AS kunde_navn,
             e.vejnavn, e.husnr, e.postnr, e.by
      FROM beholdere b
      JOIN fraktioner f ON f.id = b.fraktion_id
      JOIN kontrakter k ON k.id = b.kontrakt_id
      JOIN kunder ku ON ku.id = k.kunde_id
      LEFT JOIN ejendomme e ON e.id = k.ejendom_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY b.oprettet DESC LIMIT 300
    `;
    res.json(await query(sql, params));
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const id = req.body.id || genBeholderId();
    const { kontrakt_id, fraktion_id, volumen_l, frekvens, rfid, status='aktiv', placering, faelles=false, fordelingsnoegle } = req.body;
    if (!kontrakt_id || !fraktion_id || !volumen_l || !frekvens) {
      return res.status(400).json({ error: 'kontrakt_id, fraktion_id, volumen_l og frekvens påkrævet' });
    }
    await pool.query(
      `INSERT INTO beholdere (id, kontrakt_id, fraktion_id, volumen_l, frekvens, rfid, status, placering, faelles, fordelingsnoegle)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, kontrakt_id, fraktion_id, volumen_l, frekvens, rfid, status, placering, faelles, fordelingsnoegle]
    );
    res.status(201).json(await one(`SELECT * FROM beholdere WHERE id = $1`, [id]));
  } catch (e) { next(e); }
});

router.put('/:id', async (req, res, next) => {
  try {
    const fields = ['fraktion_id','volumen_l','frekvens','rfid','status','placering','faelles','fordelingsnoegle'];
    const sets = [];
    const params = [];
    for (const f of fields) {
      if (f in req.body) { params.push(req.body[f]); sets.push(`${f} = $${params.length}`); }
    }
    if (!sets.length) return res.json(await one(`SELECT * FROM beholdere WHERE id = $1`, [req.params.id]));
    params.push(req.params.id);
    await pool.query(`UPDATE beholdere SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    res.json(await one(`SELECT * FROM beholdere WHERE id = $1`, [req.params.id]));
  } catch (e) { next(e); }
});

module.exports = router;
