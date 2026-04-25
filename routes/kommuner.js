const express = require('express');
const router = express.Router();
const { query, one, pool } = require('../db');

router.get('/', async (req, res, next) => {
  try { res.json(await query(`SELECT * FROM kommuner ORDER BY navn`)); }
  catch (e) { next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const k = await one(`SELECT * FROM kommuner WHERE id = $1`, [req.params.id]);
    if (!k) return res.status(404).json({ error: 'Kommune ikke fundet' });
    res.json(k);
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const { id, navn, cvr, ean, email, telefon } = req.body;
    if (!id || !navn) return res.status(400).json({ error: 'id og navn påkrævet' });
    await pool.query(
      `INSERT INTO kommuner (id, navn, cvr, ean, email, telefon) VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, navn, cvr, ean, email, telefon]
    );
    res.status(201).json(await one(`SELECT * FROM kommuner WHERE id = $1`, [id]));
  } catch (e) { next(e); }
});

module.exports = router;
