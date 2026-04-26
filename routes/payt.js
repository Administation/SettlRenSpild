// UC-53 Pay-as-you-throw — vægtbaseret afregning.
// Afregningsmodel sættes på prisbladet (kolonne afregningsmodel = 'volumen' | 'vægt').
// Når et prisblad er 'vægt'-baseret, beregnes tomning-linjer som kr/kg × faktisk vægt
// (med minimumsgebyr-fallback hvis vægten er under tærskel).
const express = require('express');
const router = express.Router();
const { query, one, pool } = require('../db');

// Vis pay-as-you-throw-konfiguration for et prisblad.
router.get('/prisblade/:id/config', async (req, res, next) => {
  try {
    const p = await one(`SELECT * FROM prisblade WHERE id = $1`, [req.params.id]);
    if (!p) return res.status(404).json({ error: 'Prisblad ikke fundet' });
    const linjer = await query(`SELECT * FROM prisblad_linjer WHERE prisblad_id = $1 AND type = 'tomning_kg'`, [req.params.id]);
    res.json({ prisblad: p, kg_priser: linjer });
  } catch (e) { next(e); }
});

// Skift prisblad til pay-as-you-throw og oprettet kr/kg-priser pr. fraktion.
router.post('/prisblade/:id/aktiver-payt', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { kg_priser = [], minimumsgebyr_per_tomning = 25, bruger='Manager' } = req.body;
    // kg_priser: [{ fraktion_id, kr_per_kg }]
    if (!Array.isArray(kg_priser) || !kg_priser.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'kg_priser-array påkrævet med mindst én fraktion' });
    }
    await client.query(`UPDATE prisblade SET afregningsmodel = 'vægt' WHERE id = $1`, [req.params.id]);
    for (const p of kg_priser) {
      await client.query(
        `INSERT INTO prisblad_linjer (prisblad_id, type, noegle, beskrivelse, enhedspris, enhed, moms_pct)
         VALUES ($1,'tomning_kg',$2,$3,$4,'kg',25)
         ON CONFLICT (prisblad_id, type, noegle) DO UPDATE SET enhedspris = EXCLUDED.enhedspris`,
        [req.params.id, p.fraktion_id, `Pay-as-you-throw ${p.fraktion_id} (kr/kg)`, p.kr_per_kg]
      );
    }
    await client.query(
      `INSERT INTO prisblad_linjer (prisblad_id, type, noegle, beskrivelse, enhedspris, enhed, moms_pct)
       VALUES ($1,'minimumsgebyr','tomning',$2,$3,'tømning',25)
       ON CONFLICT (prisblad_id, type, noegle) DO UPDATE SET enhedspris = EXCLUDED.enhedspris`,
      [req.params.id, 'Minimumsgebyr pr. tømning', minimumsgebyr_per_tomning]
    );
    await client.query(
      `INSERT INTO audit_log (entitet, entitet_id, handling, bruger, detaljer)
       VALUES ('prisblad',$1,'payt_aktiveret',$2,$3::jsonb)`,
      [req.params.id, bruger, JSON.stringify({ kg_priser, minimumsgebyr_per_tomning })]
    );
    await client.query('COMMIT');
    res.json({ ok: true, hint: 'Næste fakturakørsel bruger vægtbaseret afregning. Tømninger uden vægt-data falder tilbage til volumen-pris.' });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    next(e);
  } finally { client.release(); }
});

// Simulering: hvad ville en kontrakt koste hvis den var pay-as-you-throw?
router.post('/simulér', async (req, res, next) => {
  try {
    const { kontrakt_id, periode_fra, periode_til, kr_per_kg = {} } = req.body;
    if (!kontrakt_id || !periode_fra || !periode_til) return res.status(400).json({ error: 'kontrakt_id, periode_fra og periode_til påkrævet' });
    const tomninger = await query(`
      SELECT t.*, b.fraktion_id, b.volumen_l, f.navn AS fraktion_navn
      FROM tomninger t
      JOIN beholdere b ON b.id = t.beholder_id
      JOIN fraktioner f ON f.id = b.fraktion_id
      WHERE b.kontrakt_id = $1
        AND t.tomning_dato BETWEEN $2 AND $3
        AND (t.undtagelseskode IS NULL OR t.undtagelseskode = 'overfyldt')
    `, [kontrakt_id, periode_fra, periode_til]);

    const linjer = [];
    let total = 0;
    const byFraktion = {};
    for (const t of tomninger) {
      const pris = Number(kr_per_kg[t.fraktion_id] || 2.50); // default 2,50 kr/kg
      const kg = Number(t.vaegt_kg || 0);
      const belob = kg * pris;
      total += belob;
      const f = byFraktion[t.fraktion_id] = byFraktion[t.fraktion_id] || { fraktion_navn: t.fraktion_navn, kg: 0, belob: 0, antal: 0, kr_per_kg: pris };
      f.kg += kg; f.belob += belob; f.antal += 1;
    }
    res.json({
      kontrakt_id, periode: { fra: periode_fra, til: periode_til },
      antal_tomninger: tomninger.length,
      pr_fraktion: byFraktion,
      total_belob_excl: total.toFixed(2),
    });
  } catch (e) { next(e); }
});

module.exports = router;
