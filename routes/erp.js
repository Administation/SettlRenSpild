// UC-36 ERP-eksport — bogføringsposteringer som CSV.
// Format: dato;bilag;konto;modkonto;debet;kredit;tekst;reference
// Kan importeres af ØS Indsigt, Navision, Dynamics 365, e.l.
const express = require('express');
const router = express.Router();
const { query, one, pool } = require('../db');

const KONTI = {
  debitor:    '15000', // Tilgodehavender hos kunder
  omsaetning: '10100', // Omsætning, renovation
  moms:       '57100', // Salgsmoms
  bank:       '58000', // Bank
  kreditnota: '10199', // Kreditnotaer (modkonto)
};

function isoDate(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

function csvEscape(s) {
  const v = (s == null ? '' : String(s));
  if (/[;"\r\n]/.test(v)) return '"' + v.replace(/"/g, '""') + '"';
  return v;
}

router.get('/preview', async (req, res, next) => {
  try {
    const { fra, til } = req.query;
    if (!fra || !til) return res.status(400).json({ error: 'fra og til påkrævet (YYYY-MM-DD)' });

    const fakturaer = await query(`
      SELECT id, fakturanr, fakturadato, kunde_id, belob_excl, moms, belob_incl
      FROM fakturaer
      WHERE fakturadato BETWEEN $1 AND $2 AND status NOT IN ('kladde')
      ORDER BY fakturadato, fakturanr
    `, [fra, til]);
    const betalinger = await query(`
      SELECT b.id, b.faktura_id, b.betalingsdato, b.belob, b.metode, f.fakturanr
      FROM betalinger b JOIN fakturaer f ON f.id = b.faktura_id
      WHERE b.betalingsdato BETWEEN $1 AND $2
      ORDER BY b.betalingsdato
    `, [fra, til]);
    const kreditnotaer = await query(`
      SELECT k.*, f.fakturanr, f.fakturadato FROM kreditnotaer k
      JOIN fakturaer f ON f.id = k.faktura_id
      WHERE k.oprettet BETWEEN $1 AND ($2::date + interval '1 day')
      ORDER BY k.oprettet
    `, [fra, til]);

    res.json({
      fra, til,
      fakturaer: fakturaer.length,
      betalinger: betalinger.length,
      kreditnotaer: kreditnotaer.length,
      total_debet: fakturaer.reduce((s, f) => s + Number(f.belob_incl), 0).toFixed(2),
      total_kredit: betalinger.reduce((s, b) => s + Number(b.belob), 0).toFixed(2),
      konti: KONTI,
    });
  } catch (e) { next(e); }
});

router.get('/eksport.csv', async (req, res, next) => {
  try {
    const { fra, til } = req.query;
    if (!fra || !til) return res.status(400).send('fra og til påkrævet (YYYY-MM-DD)');

    const fakturaer = await query(`
      SELECT * FROM fakturaer WHERE fakturadato BETWEEN $1 AND $2 AND status NOT IN ('kladde')
      ORDER BY fakturadato, fakturanr
    `, [fra, til]);
    const betalinger = await query(`
      SELECT b.*, f.fakturanr FROM betalinger b JOIN fakturaer f ON f.id = b.faktura_id
      WHERE b.betalingsdato BETWEEN $1 AND $2 ORDER BY b.betalingsdato
    `, [fra, til]);
    const kreditnotaer = await query(`
      SELECT k.*, f.fakturanr FROM kreditnotaer k JOIN fakturaer f ON f.id = k.faktura_id
      WHERE k.oprettet BETWEEN $1 AND ($2::date + interval '1 day') ORDER BY k.oprettet
    `, [fra, til]);

    const lines = ['dato;bilag;konto;modkonto;debet;kredit;tekst;reference;kunde_id'];

    // Fakturaer: D debitor / K omsætning + moms.
    for (const f of fakturaer) {
      const dato = isoDate(f.fakturadato);
      const ref = `Faktura ${f.fakturanr}`;
      // Debet debitor — full beløb incl.
      lines.push([dato, f.fakturanr, KONTI.debitor, '', Number(f.belob_incl).toFixed(2), '', `Faktura ${f.fakturanr}`, f.id, f.kunde_id].map(csvEscape).join(';'));
      // Kredit omsætning — beløb excl.
      lines.push([dato, f.fakturanr, '', KONTI.omsaetning, '', Number(f.belob_excl).toFixed(2), `Omsætning ${f.fakturanr}`, f.id, f.kunde_id].map(csvEscape).join(';'));
      // Kredit moms.
      lines.push([dato, f.fakturanr, '', KONTI.moms, '', Number(f.moms).toFixed(2), `Moms ${f.fakturanr}`, f.id, f.kunde_id].map(csvEscape).join(';'));
    }

    // Betalinger: D bank / K debitor.
    for (const b of betalinger) {
      const dato = isoDate(b.betalingsdato);
      const bilag = `BET-${b.id}`;
      lines.push([dato, bilag, KONTI.bank, '', Number(b.belob).toFixed(2), '', `Indbetaling ${b.fakturanr} (${b.metode || '?'})`, b.faktura_id, ''].map(csvEscape).join(';'));
      lines.push([dato, bilag, '', KONTI.debitor, '', Number(b.belob).toFixed(2), `Modpost ${b.fakturanr}`, b.faktura_id, ''].map(csvEscape).join(';'));
    }

    // Kreditnotaer: D kreditnota / K debitor.
    for (const k of kreditnotaer) {
      const dato = isoDate(k.oprettet);
      const bilag = k.id;
      lines.push([dato, bilag, KONTI.kreditnota, '', Number(k.belob).toFixed(2), '', `Kreditnota ${k.fakturanr}: ${k.aarsag || ''}`, k.faktura_id, ''].map(csvEscape).join(';'));
      lines.push([dato, bilag, '', KONTI.debitor, '', Number(k.belob).toFixed(2), `Modpost kreditnota ${k.fakturanr}`, k.faktura_id, ''].map(csvEscape).join(';'));
    }

    await pool.query(
      `INSERT INTO audit_log (entitet, entitet_id, handling, bruger, detaljer)
       VALUES ('erp_export', $1, 'genereret', $2, $3::jsonb)`,
      [`${fra}..${til}`, 'System', JSON.stringify({ fakturaer: fakturaer.length, betalinger: betalinger.length, kreditnotaer: kreditnotaer.length })]
    );

    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="erp-${fra}_${til}.csv"`);
    res.send(lines.join('\n'));
  } catch (e) { next(e); }
});

module.exports = router;
