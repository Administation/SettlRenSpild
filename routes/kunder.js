const express = require('express');
const router = express.Router();
const { query, one, pool } = require('../db');

// Generér kort kundenummer (KU-xxxxxx).
function genKundeId() {
  return 'KU-' + Math.random().toString(36).slice(2, 8).toUpperCase();
}

router.get('/', async (req, res, next) => {
  try {
    const { q, status, type } = req.query;
    const where = [];
    const params = [];
    if (q) { params.push(`%${q}%`); where.push(`(navn ILIKE $${params.length} OR id ILIKE $${params.length} OR cvr ILIKE $${params.length} OR cpr ILIKE $${params.length})`); }
    if (status) { params.push(status); where.push(`status = $${params.length}`); }
    if (type)   { params.push(type);   where.push(`type   = $${params.length}`); }
    const sql = `SELECT * FROM kunder ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY oprettet DESC LIMIT 200`;
    res.json(await query(sql, params));
  } catch (e) { next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const k = await one(`SELECT * FROM kunder WHERE id = $1`, [req.params.id]);
    if (!k) return res.status(404).json({ error: 'Kunde ikke fundet' });
    const kontrakter = await query(`
      SELECT k.*, e.vejnavn, e.husnr, e.postnr, e.by
      FROM kontrakter k
      LEFT JOIN ejendomme e ON e.id = k.ejendom_id
      WHERE k.kunde_id = $1
      ORDER BY k.oprettet DESC
    `, [req.params.id]);
    const fakturaer = await query(`SELECT * FROM fakturaer WHERE kunde_id = $1 ORDER BY fakturadato DESC LIMIT 20`, [req.params.id]);
    const sager = await query(`SELECT * FROM sager WHERE kunde_id = $1 ORDER BY oprettet DESC LIMIT 20`, [req.params.id]);
    res.json({ ...k, kontrakter, fakturaer, sager });
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const id = req.body.id || genKundeId();
    const { type='privat', navn, cpr, cvr, ean, email, telefon, faktura_kanal='eboks', pbs_aktiv=false, pbs_pbsnr, pbs_debgr, status='aktiv' } = req.body;
    if (!navn) return res.status(400).json({ error: 'navn påkrævet' });
    await pool.query(
      `INSERT INTO kunder (id, type, navn, cpr, cvr, ean, email, telefon, faktura_kanal, pbs_aktiv, pbs_pbsnr, pbs_debgr, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [id, type, navn, cpr, cvr, ean, email, telefon, faktura_kanal, pbs_aktiv, pbs_pbsnr, pbs_debgr, status]
    );
    res.status(201).json(await one(`SELECT * FROM kunder WHERE id = $1`, [id]));
  } catch (e) { next(e); }
});

router.put('/:id', async (req, res, next) => {
  try {
    const fields = ['type','navn','cpr','cvr','ean','email','telefon','faktura_kanal','pbs_aktiv','pbs_pbsnr','pbs_debgr','status'];
    const sets = [];
    const params = [];
    for (const f of fields) {
      if (f in req.body) { params.push(req.body[f]); sets.push(`${f} = $${params.length}`); }
    }
    if (!sets.length) return res.json(await one(`SELECT * FROM kunder WHERE id = $1`, [req.params.id]));
    params.push(req.params.id);
    await pool.query(`UPDATE kunder SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    res.json(await one(`SELECT * FROM kunder WHERE id = $1`, [req.params.id]));
  } catch (e) { next(e); }
});

module.exports = router;
