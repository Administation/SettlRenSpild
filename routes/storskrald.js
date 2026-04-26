// UC-20 Storskraldsbestilling — møbler, hvidevarer, byggeaffald m.v.
// Implementeret som en sag-flow med kategori='storskrald' + tidsvindue + mængde.
const express = require('express');
const router = express.Router();
const { query, one, pool } = require('../db');

const STORSKRALD_TYPER = [
  { id: 'mobler',       navn: 'Møbler' },
  { id: 'hvidevarer',   navn: 'Hårde hvidevarer' },
  { id: 'elektronik',   navn: 'Elektronik' },
  { id: 'byggeaffald',  navn: 'Byggeaffald' },
  { id: 'haveaffald',   navn: 'Haveaffald (sæsonbestemt)' },
  { id: 'farligt',      navn: 'Farligt affald' },
];

router.get('/typer', (req, res) => res.json(STORSKRALD_TYPER));

router.post('/', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { kunde_id, kontrakt_id, type, maengde_m3, beskrivelse, tidsvindue_fra, tidsvindue_til, bruger='Support' } = req.body;
    if (!kunde_id || !type || !tidsvindue_fra) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'kunde_id, type og tidsvindue_fra påkrævet' });
    }
    const typeNavn = (STORSKRALD_TYPER.find(t => t.id === type) || {}).navn || type;
    const ku = (await client.query(`SELECT navn FROM kunder WHERE id = $1`, [kunde_id])).rows[0];
    if (!ku) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Kunde ikke fundet' }); }

    const sagId = 'SAG-' + Math.random().toString(36).slice(2, 8).toUpperCase();
    await client.query(
      `INSERT INTO sager (id, domain, kategori, prioritet, titel, beskrivelse, kunde_id, kontrakt_id, ansvarlig, sla_frist)
       VALUES ($1,'renovation','storskrald','normal',$2,$3,$4,$5,$6, $7::timestamptz)`,
      [sagId,
       `Storskrald: ${typeNavn}${maengde_m3 ? ' (' + maengde_m3 + ' m³)' : ''}`,
       `Tidsvindue: ${tidsvindue_fra}${tidsvindue_til ? ' – ' + tidsvindue_til : ''}\nType: ${typeNavn}\n${beskrivelse || ''}`,
       kunde_id, kontrakt_id || null, bruger,
       tidsvindue_til || tidsvindue_fra]
    );
    await client.query(
      `INSERT INTO sag_aktiviteter (sag_id, type, tekst, bruger)
       VALUES ($1,'oprettet','Storskraldsbestilling — afventer driftssystem-bekræftelse',$2)`,
      [sagId, bruger]
    );
    await client.query(
      `INSERT INTO audit_log (entitet, entitet_id, handling, bruger, detaljer)
       VALUES ('storskrald',$1,'bestilt',$2,$3::jsonb)`,
      [sagId, bruger, JSON.stringify({ kunde_id, type, typeNavn, maengde_m3, tidsvindue_fra, tidsvindue_til })]
    );
    await client.query('COMMIT');
    res.status(201).json({ ok: true, sag_id: sagId, type: typeNavn, mock: 'Bestilling sendt til driftssystem' });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    next(e);
  } finally { client.release(); }
});

router.get('/', async (req, res, next) => {
  try {
    const rows = await query(`
      SELECT s.*, k.navn AS kunde_navn
      FROM sager s LEFT JOIN kunder k ON k.id = s.kunde_id
      WHERE s.kategori = 'storskrald'
      ORDER BY s.oprettet DESC LIMIT 100
    `);
    res.json(rows);
  } catch (e) { next(e); }
});

module.exports = router;
