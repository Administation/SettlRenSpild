// UC-56 Fuldmagter — ejer giver adgang til ægtefælle/vicevært/kollega.
const express = require('express');
const router = express.Router();
const { query, one, pool } = require('../db');

router.get('/', async (req, res, next) => {
  try {
    const { ejer_kunde_id, agent_kunde_id } = req.query;
    const where = []; const params = [];
    if (ejer_kunde_id)  { params.push(ejer_kunde_id);  where.push(`f.ejer_kunde_id  = $${params.length}`); }
    if (agent_kunde_id) { params.push(agent_kunde_id); where.push(`f.agent_kunde_id = $${params.length}`); }
    const sql = `
      SELECT f.*, ej.navn AS ejer_navn, ag.navn AS agent_navn
      FROM fuldmagter f
      JOIN kunder ej ON ej.id = f.ejer_kunde_id
      JOIN kunder ag ON ag.id = f.agent_kunde_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY f.oprettet DESC
    `;
    res.json(await query(sql, params));
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const { ejer_kunde_id, agent_kunde_id, rolle = 'fuld', gyldig_fra, gyldig_til, noter } = req.body;
    if (!ejer_kunde_id || !agent_kunde_id) return res.status(400).json({ error: 'ejer_kunde_id og agent_kunde_id påkrævet' });
    if (ejer_kunde_id === agent_kunde_id) return res.status(400).json({ error: 'Kunde kan ikke give sig selv fuldmagt' });
    const r = await pool.query(
      `INSERT INTO fuldmagter (ejer_kunde_id, agent_kunde_id, rolle, gyldig_fra, gyldig_til, noter)
       VALUES ($1,$2,$3,COALESCE($4, CURRENT_DATE),$5,$6) RETURNING *`,
      [ejer_kunde_id, agent_kunde_id, rolle, gyldig_fra || null, gyldig_til || null, noter || null]
    );
    await pool.query(
      `INSERT INTO audit_log (entitet, entitet_id, handling, bruger, detaljer)
       VALUES ('fuldmagt',$1,'oprettet',$2,$3::jsonb)`,
      [String(r.rows[0].id), req.body.bruger || 'Support', JSON.stringify({ ejer_kunde_id, agent_kunde_id, rolle })]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { next(e); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    await pool.query(`DELETE FROM fuldmagter WHERE id = $1`, [req.params.id]);
    await pool.query(
      `INSERT INTO audit_log (entitet, entitet_id, handling, bruger) VALUES ('fuldmagt',$1,'tilbagekaldt',$2)`,
      [req.params.id, req.body?.bruger || 'Support']
    );
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
