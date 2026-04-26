// UC-32 Rykker & restance — overblik og batch-handling for forfaldne fakturaer.
const express = require('express');
const router = express.Router();
const { query, one, pool } = require('../db');

router.get('/', async (req, res, next) => {
  try {
    // Aldersopdelt restance.
    const stats = await one(`
      SELECT
        COUNT(*) FILTER (WHERE forfaldsdato < CURRENT_DATE - 30 AND status NOT IN ('betalt','krediteret'))::int AS over_30,
        COUNT(*) FILTER (WHERE forfaldsdato BETWEEN CURRENT_DATE - 30 AND CURRENT_DATE AND status NOT IN ('betalt','krediteret'))::int AS under_30,
        COALESCE(SUM(belob_incl - betalt_belob) FILTER (WHERE forfaldsdato < CURRENT_DATE AND status NOT IN ('betalt','krediteret')),0)::numeric AS total_belob,
        COUNT(*) FILTER (WHERE status = 'rykker')::int AS rykker_sendt,
        COUNT(*) FILTER (WHERE status = 'inddrivelse')::int AS inddrivelse
      FROM fakturaer
    `);
    const fakturaer = await query(`
      SELECT f.id, f.fakturanr, f.fakturadato, f.forfaldsdato, f.status, f.belob_incl, f.betalt_belob,
             (f.belob_incl - f.betalt_belob)::numeric AS resterer,
             (CURRENT_DATE - f.forfaldsdato)::int AS dage_efter_forfald,
             k.navn AS kunde_navn, k.id AS kunde_id, k.faktura_kanal
      FROM fakturaer f
      JOIN kunder k ON k.id = f.kunde_id
      WHERE f.forfaldsdato < CURRENT_DATE
        AND f.status NOT IN ('betalt','krediteret','kladde')
      ORDER BY f.forfaldsdato
      LIMIT 200
    `);
    res.json({ stats, fakturaer });
  } catch (e) { next(e); }
});

// UC-33 Overgivelse til SKAT (mock).
router.post('/skat-inddrivelse/:faktura_id', async (req, res, next) => {
  try {
    const { godkendt_af='Økonomiansvarlig' } = req.body || {};
    await pool.query(`UPDATE fakturaer SET status = 'inddrivelse' WHERE id = $1`, [req.params.faktura_id]);
    await pool.query(
      `INSERT INTO audit_log (entitet, entitet_id, handling, bruger, detaljer)
       VALUES ('faktura',$1,'skat_inddrivelse',$2,$3::jsonb)`,
      [req.params.faktura_id, godkendt_af,
       JSON.stringify({ mock: { fordringsfil_genereret: true, skat_reference: 'SKAT-' + Date.now() } })]
    );
    res.json({ ok: true, mock: 'Fordringsfil genereret og indsendt til SKAT Inddrivelse' });
  } catch (e) { next(e); }
});

module.exports = router;
