// UC-26 Betalingsaftaler — afdragsordninger for kunder i restance.
// Ved aktiv aftale pauses rykker-flowet automatisk.
const express = require('express');
const router = express.Router();
const { query, one, pool } = require('../db');

function genId() {
  return 'BA-' + Math.random().toString(36).slice(2, 8).toUpperCase();
}

router.get('/', async (req, res, next) => {
  try {
    const { kunde_id, faktura_id, status } = req.query;
    const where = [];
    const params = [];
    if (kunde_id)   { params.push(kunde_id);   where.push(`b.kunde_id = $${params.length}`); }
    if (faktura_id) { params.push(faktura_id); where.push(`b.faktura_id = $${params.length}`); }
    if (status)     { params.push(status);     where.push(`b.status = $${params.length}`); }
    const rows = await query(`
      SELECT b.*, k.navn AS kunde_navn, f.fakturanr
      FROM betalingsaftaler b
      JOIN kunder k ON k.id = b.kunde_id
      JOIN fakturaer f ON f.id = b.faktura_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY b.oprettet DESC LIMIT 200
    `, params);
    res.json(rows);
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { faktura_id, antal_rater = 3, foerste_dato, bruger='Support' } = req.body;
    if (!faktura_id) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'faktura_id påkrævet' }); }

    const f = (await client.query(`SELECT * FROM fakturaer WHERE id = $1`, [faktura_id])).rows[0];
    if (!f) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Faktura ikke fundet' }); }

    const restbelob = Number(f.belob_incl) - Number(f.betalt_belob);
    if (restbelob <= 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Faktura er allerede betalt' }); }

    const ratebeloeb = Math.round((restbelob / antal_rater) * 100) / 100;
    const start = new Date(foerste_dato || new Date(Date.now() + 14*86400000).toISOString().slice(0,10));
    const rater = [];
    let restAfBeloeb = restbelob;
    for (let i = 0; i < antal_rater; i++) {
      const belob = i === antal_rater - 1 ? restAfBeloeb : ratebeloeb;
      restAfBeloeb = Math.round((restAfBeloeb - belob) * 100) / 100;
      const dato = new Date(start);
      dato.setMonth(dato.getMonth() + i);
      rater.push({ nr: i + 1, dato: dato.toISOString().slice(0,10), belob: belob.toFixed(2), status: 'afventer' });
    }

    const id = genId();
    await client.query(
      `INSERT INTO betalingsaftaler (id, faktura_id, kunde_id, total_belob, antal_rater, rater, oprettet_af)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
      [id, faktura_id, f.kunde_id, restbelob.toFixed(2), antal_rater, JSON.stringify(rater), bruger]
    );

    // Pause rykker: flyt status til 'godkendt' (fra rykker/forfalden).
    if (['rykker','forfalden'].includes(f.status)) {
      await client.query(`UPDATE fakturaer SET status = 'godkendt' WHERE id = $1`, [faktura_id]);
    }

    await client.query(
      `INSERT INTO audit_log (entitet, entitet_id, handling, bruger, detaljer)
       VALUES ('betalingsaftale',$1,'oprettet',$2,$3::jsonb)`,
      [id, bruger, JSON.stringify({ faktura_id, antal_rater, total_belob: restbelob.toFixed(2) })]
    );

    await client.query('COMMIT');
    res.status(201).json(await one(`SELECT * FROM betalingsaftaler WHERE id = $1`, [id]));
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    next(e);
  } finally { client.release(); }
});

// Registrér en ratebetaling — opdaterer rater-array + opretter en betaling på fakturaen.
router.post('/:id/rate-betalt', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rate_nr, betalingsdato, bruger='Økonomi' } = req.body;
    const a = (await client.query(`SELECT * FROM betalingsaftaler WHERE id = $1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!a) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Aftale ikke fundet' }); }
    const rater = a.rater;
    const r = rater.find(x => x.nr === Number(rate_nr));
    if (!r) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Rate ikke fundet' }); }
    r.status = 'betalt';
    r.betalingsdato = betalingsdato || new Date().toISOString().slice(0,10);

    // Bogfør på fakturaen.
    await client.query(
      `INSERT INTO betalinger (faktura_id, belob, betalingsdato, metode, reference)
       VALUES ($1,$2,$3,'betalingsaftale',$4)`,
      [a.faktura_id, r.belob, r.betalingsdato, `${a.id} rate ${r.nr}`]
    );
    const f = (await client.query(`SELECT * FROM fakturaer WHERE id = $1 FOR UPDATE`, [a.faktura_id])).rows[0];
    const nyBetalt = Number(f.betalt_belob) + Number(r.belob);
    const helt = nyBetalt >= Number(f.belob_incl) - 0.01;
    await client.query(
      `UPDATE fakturaer SET betalt_belob = $1, status = $2, betalt = CASE WHEN $3 THEN now() ELSE betalt END WHERE id = $4`,
      [nyBetalt.toFixed(2), helt ? 'betalt' : f.status, helt, a.faktura_id]
    );

    // Hvis alle rater er betalt → aftale gennemført.
    const allBetalt = rater.every(x => x.status === 'betalt');
    await client.query(
      `UPDATE betalingsaftaler SET rater = $1::jsonb, status = $2 WHERE id = $3`,
      [JSON.stringify(rater), allBetalt ? 'gennemfoert' : 'aktiv', req.params.id]
    );

    await client.query('COMMIT');
    res.json({ ok: true, alle_rater_betalt: allBetalt });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    next(e);
  } finally { client.release(); }
});

module.exports = router;
