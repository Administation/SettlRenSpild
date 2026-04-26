// UC-55 Boligadministrator-portal — én admin-kunde har adgang til mange ejendomme,
// kan se samlet fakturaoversigt, fordelingsnøgler pr. lejemål, og bestille ydelser
// på tværs af administrationens portefølje.
const express = require('express');
const router = express.Router();
const { query, one, pool } = require('../db');

// Knyt en kunde som administrator af én eller flere ejendomme.
router.post('/relationer', async (req, res, next) => {
  try {
    const { admin_kunde_id, ejendom_id, rolle = 'administrator' } = req.body;
    if (!admin_kunde_id || !ejendom_id) return res.status(400).json({ error: 'admin_kunde_id og ejendom_id påkrævet' });
    await pool.query(
      `INSERT INTO boligadm_relationer (admin_kunde_id, ejendom_id, rolle) VALUES ($1,$2,$3)
       ON CONFLICT (admin_kunde_id, ejendom_id) DO UPDATE SET rolle = EXCLUDED.rolle`,
      [admin_kunde_id, ejendom_id, rolle]
    );
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete('/relationer/:admin/:ejendom', async (req, res, next) => {
  try {
    await pool.query(`DELETE FROM boligadm_relationer WHERE admin_kunde_id = $1 AND ejendom_id = $2`,
      [req.params.admin, req.params.ejendom]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Portal-overblik for en boligadministrator: alle ejendomme + samlet økonomi.
router.get('/:admin_id/portefoelje', async (req, res, next) => {
  try {
    const admin = await one(`SELECT * FROM kunder WHERE id = $1`, [req.params.admin_id]);
    if (!admin) return res.status(404).json({ error: 'Administrator-kunde ikke fundet' });

    const ejendomme = await query(`
      SELECT e.*, ko.navn AS kommune_navn, br.rolle,
             (SELECT COUNT(*)::int FROM kontrakter k WHERE k.ejendom_id = e.id AND k.status = 'aktiv') AS aktive_kontrakter,
             (SELECT COUNT(*)::int FROM kontrakter k JOIN beholdere b ON b.kontrakt_id = k.id WHERE k.ejendom_id = e.id) AS beholdere
      FROM boligadm_relationer br
      JOIN ejendomme e ON e.id = br.ejendom_id
      LEFT JOIN kommuner ko ON ko.id = e.kommune_id
      WHERE br.admin_kunde_id = $1
      ORDER BY e.postnr, e.vejnavn
    `, [req.params.admin_id]);

    const ejendomIds = ejendomme.map(e => e.id);
    if (!ejendomIds.length) return res.json({ admin, ejendomme: [], samlet: {}, fakturaer: [] });

    // Find alle fakturaer for disse ejendommes kontrakter (årets):
    const aar = parseInt(req.query.aar, 10) || new Date().getFullYear();
    const fakturaer = await query(`
      SELECT f.*, k.navn AS kunde_navn, e.vejnavn, e.husnr, e.postnr, e.by,
             (f.belob_incl - f.betalt_belob)::numeric AS resterer
      FROM fakturaer f
      JOIN kunder k ON k.id = f.kunde_id
      LEFT JOIN ejendomme e ON e.id = f.ejendom_id
      WHERE f.ejendom_id = ANY($1::text[])
        AND EXTRACT(YEAR FROM f.fakturadato) = $2
      ORDER BY f.fakturadato DESC
    `, [ejendomIds, aar]);

    const samlet = {
      ejendomme: ejendomme.length,
      kontrakter_aktive: ejendomme.reduce((s, e) => s + Number(e.aktive_kontrakter), 0),
      fakturaer_aar: fakturaer.length,
      total_belob: fakturaer.reduce((s, f) => s + Number(f.belob_incl), 0),
      restance: fakturaer.reduce((s, f) => s + Number(f.resterer), 0),
    };
    res.json({ admin, ejendomme, fakturaer, samlet, aar });
  } catch (e) { next(e); }
});

// Find administratorer for én ejendom (omvendt opslag).
router.get('/ejendom/:ejendom_id', async (req, res, next) => {
  try {
    const rows = await query(`
      SELECT br.*, k.navn AS admin_navn, k.email, k.telefon
      FROM boligadm_relationer br
      JOIN kunder k ON k.id = br.admin_kunde_id
      WHERE br.ejendom_id = $1
    `, [req.params.ejendom_id]);
    res.json(rows);
  } catch (e) { next(e); }
});

module.exports = router;
