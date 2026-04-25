const express = require('express');
const router = express.Router();
const { query, one, pool } = require('../db');

router.get('/', async (req, res, next) => {
  try {
    const { faktura_id } = req.query;
    if (faktura_id) {
      return res.json(await query(`SELECT * FROM betalinger WHERE faktura_id = $1 ORDER BY betalingsdato`, [faktura_id]));
    }
    res.json(await query(`SELECT * FROM betalinger ORDER BY betalingsdato DESC LIMIT 200`));
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { faktura_id, belob, betalingsdato, metode, reference } = req.body;
    if (!faktura_id || !belob) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'faktura_id og belob påkrævet' }); }
    const f = (await client.query(`SELECT * FROM fakturaer WHERE id = $1 FOR UPDATE`, [faktura_id])).rows[0];
    if (!f) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Faktura ikke fundet' }); }
    const r = await client.query(
      `INSERT INTO betalinger (faktura_id, belob, betalingsdato, metode, reference)
       VALUES ($1,$2,COALESCE($3, CURRENT_DATE),$4,$5) RETURNING *`,
      [faktura_id, belob, betalingsdato, metode, reference]
    );
    const nyBetalt = Number(f.betalt_belob) + Number(belob);
    const helt = nyBetalt >= Number(f.belob_incl) - 0.01;
    await client.query(
      `UPDATE fakturaer SET betalt_belob = $1, status = $2, betalt = CASE WHEN $3 THEN now() ELSE betalt END WHERE id = $4`,
      [nyBetalt.toFixed(2), helt ? 'betalt' : f.status, helt, faktura_id]
    );
    await client.query('COMMIT');
    res.status(201).json(r.rows[0]);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    next(e);
  } finally {
    client.release();
  }
});

module.exports = router;
