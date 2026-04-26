// UC-37 Massevarslinger — 30-dages lovpligtig varsling om prisændring til alle berørte kunder.
// Også UC-38 (regulativændring) bruger samme grundstruktur.
const express = require('express');
const router = express.Router();
const { query, one, pool } = require('../db');

// Vi gemmer varslinger i audit_log med entitet='varsling' så vi ikke
// behøver et separat schema — datamodellen er fleksibel JSONB.

router.get('/', async (req, res, next) => {
  try {
    const rows = await query(`
      SELECT id, entitet_id, handling, bruger, detaljer, oprettet
      FROM audit_log
      WHERE entitet = 'varsling'
      ORDER BY oprettet DESC LIMIT 50
    `);
    res.json(rows);
  } catch (e) { next(e); }
});

// Simulér: hvor mange kunder rammes af en prisændring?
router.post('/simuler', async (req, res, next) => {
  try {
    const { kommune_id, service_type='renovation' } = req.body;
    if (!kommune_id) return res.status(400).json({ error: 'kommune_id påkrævet' });
    const kunder = await query(`
      SELECT DISTINCT ku.id, ku.navn, ku.email, ku.telefon, ku.faktura_kanal
      FROM kunder ku
      JOIN kontrakter k ON k.kunde_id = ku.id
      JOIN ejendomme e ON e.id = k.ejendom_id
      WHERE k.service_type = $1
        AND k.status = 'aktiv'
        AND e.kommune_id = $2
      ORDER BY ku.navn
    `, [service_type, kommune_id]);
    res.json({ antal: kunder.length, kunder });
  } catch (e) { next(e); }
});

// Send (mock): generér varslingsbreve og log per kunde.
// I v2 hooker vi e-Boks/e-mail-integration på.
router.post('/send', async (req, res, next) => {
  try {
    const { kommune_id, service_type='renovation', prisblad_id, ikrafttraedelse, godkendt_af='Manager' } = req.body;
    if (!kommune_id || !prisblad_id || !ikrafttraedelse) {
      return res.status(400).json({ error: 'kommune_id, prisblad_id og ikrafttraedelse påkrævet' });
    }
    const dage = (new Date(ikrafttraedelse) - new Date()) / 86400000;
    if (dage < 30) return res.status(400).json({ error: `Lovkrav: mindst 30 dages varsel. Du har angivet ${Math.round(dage)} dage.` });

    const kunder = await query(`
      SELECT DISTINCT ku.id, ku.navn, ku.email, ku.faktura_kanal
      FROM kunder ku
      JOIN kontrakter k ON k.kunde_id = ku.id
      JOIN ejendomme e ON e.id = k.ejendom_id
      WHERE k.service_type = $1 AND k.status = 'aktiv' AND e.kommune_id = $2
    `, [service_type, kommune_id]);

    const id = 'VARS-' + Math.random().toString(36).slice(2, 8).toUpperCase();
    await pool.query(
      `INSERT INTO audit_log (entitet, entitet_id, handling, bruger, detaljer)
       VALUES ('varsling',$1,'sendt',$2,$3::jsonb)`,
      [id, godkendt_af, JSON.stringify({
        kommune_id, service_type, prisblad_id, ikrafttraedelse,
        antal_kunder: kunder.length,
        kanaler: kunder.reduce((m, k) => ({ ...m, [k.faktura_kanal]: (m[k.faktura_kanal]||0)+1 }), {}),
      })]
    );
    res.json({ ok: true, id, antal_kunder: kunder.length, ikrafttraedelse, dage_varsel: Math.round(dage) });
  } catch (e) { next(e); }
});

module.exports = router;
