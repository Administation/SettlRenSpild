// UC-28 Fakturakørsel — periodisk massefakturering med simulation og godkendelse.
const express = require('express');
const router = express.Router();
const { query, one, pool } = require('../db');

// Simulation: list alle aktive kontrakter der har ufakturerede tømninger
// i perioden, og estimér totalbeløb.
router.post('/simuler', async (req, res, next) => {
  try {
    const { periode_fra, periode_til, kommune_id } = req.body;
    if (!periode_fra || !periode_til) return res.status(400).json({ error: 'periode_fra og periode_til påkrævet' });
    const params = [periode_fra, periode_til];
    let kommuneFilter = '';
    if (kommune_id) { params.push(kommune_id); kommuneFilter = `AND e.kommune_id = $${params.length}`; }

    const kontrakter = await query(`
      SELECT k.id AS kontrakt_id, k.service_type, k.kunde_id, ku.navn AS kunde_navn,
             e.kommune_id, ko.navn AS kommune_navn,
             COUNT(t.id)::int AS ufakturerede_tomninger
      FROM kontrakter k
      JOIN kunder ku ON ku.id = k.kunde_id
      LEFT JOIN ejendomme e ON e.id = k.ejendom_id
      LEFT JOIN kommuner ko ON ko.id = e.kommune_id
      LEFT JOIN beholdere b ON b.kontrakt_id = k.id
      LEFT JOIN tomninger t ON t.beholder_id = b.id
        AND t.faktureret = FALSE
        AND t.tomning_dato BETWEEN $1 AND $2
      WHERE k.status IN ('aktiv','fritaget')
        ${kommuneFilter}
      GROUP BY k.id, k.service_type, k.kunde_id, ku.navn, e.kommune_id, ko.navn
      HAVING COUNT(t.id) > 0
      ORDER BY ku.navn
    `, params);
    res.json({
      periode_fra, periode_til,
      antal_kontrakter: kontrakter.length,
      total_tomninger: kontrakter.reduce((s, k) => s + Number(k.ufakturerede_tomninger), 0),
      kontrakter,
    });
  } catch (e) { next(e); }
});

// Godkend og kør: generér fakturaer for alle kontrakter med ufakturerede tømninger.
// Uses /api/fakturaer/generer logikken via direkte fetch — i v2 refaktorer
// vi beregnLinjer ud i lib/billing.js så den kan kaldes direkte uden HTTP.
const fakturaerRouter = require('./fakturaer');

router.post('/koer', async (req, res, next) => {
  try {
    const { periode_fra, periode_til, kommune_id, godkendt_af='Afregningsansvarlig' } = req.body;
    if (!periode_fra || !periode_til) return res.status(400).json({ error: 'periode_fra og periode_til påkrævet' });

    // Genbrug simuleringen til at finde berørte kontrakter.
    const params = [periode_fra, periode_til];
    let kommuneFilter = '';
    if (kommune_id) { params.push(kommune_id); kommuneFilter = `AND e.kommune_id = $${params.length}`; }
    const kontrakter = await query(`
      SELECT DISTINCT k.id
      FROM kontrakter k
      LEFT JOIN ejendomme e ON e.id = k.ejendom_id
      JOIN beholdere b ON b.kontrakt_id = k.id
      JOIN tomninger t ON t.beholder_id = b.id
      WHERE k.status IN ('aktiv','fritaget')
        AND t.faktureret = FALSE
        AND t.tomning_dato BETWEEN $1 AND $2
        ${kommuneFilter}
    `, params);

    const oprettet = [];
    const fejlet = [];
    // Genererer fakturaer en ad gangen for at undgå at én fejl ødelægger hele batchen.
    // Bruger HTTP-loopback til /api/fakturaer/generer.
    const baseUrl = req.protocol + '://' + req.get('host');
    for (const k of kontrakter) {
      try {
        const r = await fetch(baseUrl + '/api/fakturaer/generer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kontrakt_id: k.id, periode_fra, periode_til }),
        });
        const data = await r.json();
        if (r.ok) oprettet.push({ kontrakt_id: k.id, faktura_id: data.id, belob_incl: data.belob_incl });
        else fejlet.push({ kontrakt_id: k.id, fejl: data.error || 'ukendt' });
      } catch (e) { fejlet.push({ kontrakt_id: k.id, fejl: e.message }); }
    }

    const total = oprettet.reduce((s, x) => s + Number(x.belob_incl || 0), 0);
    await pool.query(
      `INSERT INTO audit_log (entitet, entitet_id, handling, bruger, detaljer)
       VALUES ('fakturakorsel', $1, 'koert', $2, $3::jsonb)`,
      [`${periode_fra}..${periode_til}`, godkendt_af,
       JSON.stringify({ oprettet_count: oprettet.length, fejlet_count: fejlet.length, total })]
    );
    res.json({ oprettet: oprettet.length, fejlet: fejlet.length, total, fejl: fejlet });
  } catch (e) { next(e); }
});

module.exports = router;
