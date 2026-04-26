// UC-57 Samtykkestyring + kommunikationskanaler.
const express = require('express');
const router = express.Router();
const { query, one, pool } = require('../db');

const TYPER = ['fakturalevering','driftspaamindelse','marketing','sorteringsscore','gdpr'];
const KANALER = ['eboks','email','sms','app','papir'];

router.get('/typer', (req, res) => res.json({ typer: TYPER, kanaler: KANALER }));

router.get('/', async (req, res, next) => {
  try {
    const { kunde_id } = req.query;
    if (!kunde_id) return res.status(400).json({ error: 'kunde_id påkrævet' });
    const rows = await query(`SELECT * FROM samtykker WHERE kunde_id = $1 ORDER BY type, kanal`, [kunde_id]);
    res.json(rows);
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const { kunde_id, type, kanal, status = true } = req.body;
    if (!kunde_id || !type || !kanal) return res.status(400).json({ error: 'kunde_id, type og kanal påkrævet' });
    await pool.query(
      `INSERT INTO samtykker (kunde_id, type, kanal, status) VALUES ($1,$2,$3,$4)
       ON CONFLICT (kunde_id, type, kanal) DO UPDATE SET status = EXCLUDED.status, opdateret = now()`,
      [kunde_id, type, kanal, status]
    );
    await pool.query(
      `INSERT INTO audit_log (entitet, entitet_id, handling, bruger, detaljer)
       VALUES ('samtykke',$1,'opdateret',$2,$3::jsonb)`,
      [kunde_id, req.body.bruger || 'Kunde', JSON.stringify({ type, kanal, status })]
    );
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
