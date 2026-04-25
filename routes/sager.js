const express = require('express');
const router = express.Router();
const { query, one, pool } = require('../db');

function genSagId() {
  return 'SAG-' + Math.random().toString(36).slice(2, 8).toUpperCase();
}

router.get('/', async (req, res, next) => {
  try {
    const { domain, status, kunde_id } = req.query;
    const where = [];
    const params = [];
    if (domain)   { params.push(domain);   where.push(`s.domain   = $${params.length}`); }
    if (status)   { params.push(status);   where.push(`s.status   = $${params.length}`); }
    if (kunde_id) { params.push(kunde_id); where.push(`s.kunde_id = $${params.length}`); }
    const sql = `
      SELECT s.*, k.navn AS kunde_navn FROM sager s
      LEFT JOIN kunder k ON k.id = s.kunde_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY s.oprettet DESC LIMIT 200
    `;
    res.json(await query(sql, params));
  } catch (e) { next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const s = await one(`SELECT * FROM sager WHERE id = $1`, [req.params.id]);
    if (!s) return res.status(404).json({ error: 'Sag ikke fundet' });
    const aktiviteter = await query(`SELECT * FROM sag_aktiviteter WHERE sag_id = $1 ORDER BY oprettet`, [req.params.id]);
    res.json({ ...s, aktiviteter });
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const id = req.body.id || genSagId();
    const { domain='renovation', kategori, prioritet='normal', titel, beskrivelse, kunde_id, ejendom_id, kontrakt_id, ansvarlig, sla_frist } = req.body;
    if (!titel) return res.status(400).json({ error: 'titel påkrævet' });
    await pool.query(
      `INSERT INTO sager (id, domain, kategori, prioritet, titel, beskrivelse, kunde_id, ejendom_id, kontrakt_id, ansvarlig, sla_frist)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, domain, kategori, prioritet, titel, beskrivelse, kunde_id, ejendom_id, kontrakt_id, ansvarlig, sla_frist]
    );
    await pool.query(
      `INSERT INTO sag_aktiviteter (sag_id, type, tekst, bruger) VALUES ($1,'oprettet','Sag oprettet',$2)`,
      [id, ansvarlig || 'System']
    );
    res.status(201).json(await one(`SELECT * FROM sager WHERE id = $1`, [id]));
  } catch (e) { next(e); }
});

router.post('/:id/kommentar', async (req, res, next) => {
  try {
    const { tekst, bruger='Support' } = req.body;
    await pool.query(`INSERT INTO sag_aktiviteter (sag_id, type, tekst, bruger) VALUES ($1,'kommentar',$2,$3)`, [req.params.id, tekst, bruger]);
    res.json(await query(`SELECT * FROM sag_aktiviteter WHERE sag_id = $1 ORDER BY oprettet`, [req.params.id]));
  } catch (e) { next(e); }
});

router.put('/:id', async (req, res, next) => {
  try {
    const fields = ['status','prioritet','ansvarlig','kategori','titel','beskrivelse','sla_frist'];
    const sets = [];
    const params = [];
    for (const f of fields) {
      if (f in req.body) { params.push(req.body[f]); sets.push(`${f} = $${params.length}`); }
    }
    const lukker = req.body.status === 'lukket';
    if (lukker) sets.push(`lukket = now()`);
    if (!sets.length) return res.json(await one(`SELECT * FROM sager WHERE id = $1`, [req.params.id]));
    params.push(req.params.id);
    await pool.query(`UPDATE sager SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    if (req.body.status) {
      await pool.query(`INSERT INTO sag_aktiviteter (sag_id, type, tekst, bruger) VALUES ($1,'statusskift',$2,$3)`,
        [req.params.id, `Status ændret til ${req.body.status}`, req.body.bruger || 'System']);
    }
    res.json(await one(`SELECT * FROM sager WHERE id = $1`, [req.params.id]));
  } catch (e) { next(e); }
});

module.exports = router;
