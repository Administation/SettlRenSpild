const express = require('express');
const router = express.Router();
const { query, one, pool } = require('../db');

function genPrisbladId() {
  return 'PB-' + Math.random().toString(36).slice(2, 8).toUpperCase();
}

router.get('/', async (req, res, next) => {
  try {
    const { kommune_id, service_type, status } = req.query;
    const where = [];
    const params = [];
    if (kommune_id)   { params.push(kommune_id);   where.push(`p.kommune_id   = $${params.length}`); }
    if (service_type) { params.push(service_type); where.push(`p.service_type = $${params.length}`); }
    if (status)       { params.push(status);       where.push(`p.status       = $${params.length}`); }
    const sql = `
      SELECT p.*, k.navn AS kommune_navn,
             (SELECT COUNT(*) FROM prisblad_linjer l WHERE l.prisblad_id = p.id) AS linjer
      FROM prisblade p JOIN kommuner k ON k.id = p.kommune_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY p.gyldig_fra DESC
    `;
    res.json(await query(sql, params));
  } catch (e) { next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const p = await one(`
      SELECT p.*, k.navn AS kommune_navn FROM prisblade p
      JOIN kommuner k ON k.id = p.kommune_id WHERE p.id = $1
    `, [req.params.id]);
    if (!p) return res.status(404).json({ error: 'Prisblad ikke fundet' });
    const linjer = await query(`SELECT * FROM prisblad_linjer WHERE prisblad_id = $1 ORDER BY type, noegle`, [req.params.id]);
    res.json({ ...p, linjer });
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const id = req.body.id || genPrisbladId();
    const { service_type='renovation', kommune_id, version, gyldig_fra, gyldig_til, status='kladde' } = req.body;
    if (!kommune_id || !version || !gyldig_fra) return res.status(400).json({ error: 'kommune_id, version og gyldig_fra påkrævet' });
    await pool.query(
      `INSERT INTO prisblade (id, service_type, kommune_id, version, gyldig_fra, gyldig_til, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, service_type, kommune_id, version, gyldig_fra, gyldig_til, status]
    );
    res.status(201).json(await one(`SELECT * FROM prisblade WHERE id = $1`, [id]));
  } catch (e) { next(e); }
});

router.post('/:id/linjer', async (req, res, next) => {
  try {
    const linjer = Array.isArray(req.body) ? req.body : [req.body];
    for (const l of linjer) {
      await pool.query(
        `INSERT INTO prisblad_linjer (prisblad_id, type, noegle, beskrivelse, enhedspris, enhed, moms_pct)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (prisblad_id, type, noegle) DO UPDATE SET
           beskrivelse = EXCLUDED.beskrivelse,
           enhedspris  = EXCLUDED.enhedspris,
           enhed       = EXCLUDED.enhed,
           moms_pct    = EXCLUDED.moms_pct`,
        [req.params.id, l.type, l.noegle, l.beskrivelse, l.enhedspris, l.enhed, l.moms_pct ?? 25]
      );
    }
    res.json(await query(`SELECT * FROM prisblad_linjer WHERE prisblad_id = $1 ORDER BY type, noegle`, [req.params.id]));
  } catch (e) { next(e); }
});

router.post('/:id/godkend', async (req, res, next) => {
  try {
    const { godkendt_af = 'System' } = req.body || {};
    // Sæt øvrige aktive prisblade for samme kommune+service til 'historisk'.
    const p = await one(`SELECT kommune_id, service_type FROM prisblade WHERE id = $1`, [req.params.id]);
    if (!p) return res.status(404).json({ error: 'Prisblad ikke fundet' });
    await pool.query(
      `UPDATE prisblade SET status = 'historisk' WHERE kommune_id = $1 AND service_type = $2 AND status = 'aktiv'`,
      [p.kommune_id, p.service_type]
    );
    await pool.query(
      `UPDATE prisblade SET status = 'aktiv', godkendt_af = $1, godkendt_dato = now() WHERE id = $2`,
      [godkendt_af, req.params.id]
    );
    await pool.query(
      `INSERT INTO audit_log (entitet, entitet_id, handling, bruger) VALUES ('prisblad',$1,'godkendt',$2)`,
      [req.params.id, godkendt_af]
    );
    res.json(await one(`SELECT * FROM prisblade WHERE id = $1`, [req.params.id]));
  } catch (e) { next(e); }
});

module.exports = router;
