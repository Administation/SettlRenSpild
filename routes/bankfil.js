// UC-65 Bankfilimport (CAMT.054 light) og auto-match til fakturaer.
// Accepterer enten CSV (kolonner: dato;belob;tekst;reference) eller JSON-array.
const express = require('express');
const router = express.Router();
const { query, one, pool } = require('../db');

function parseCsv(text) {
  const out = [];
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return out;
  // Fjern header hvis den findes.
  const first = lines[0].toLowerCase();
  const start = (first.includes('dato') && first.includes('belob')) ? 1 : 0;
  for (let i = start; i < lines.length; i++) {
    const cols = lines[i].split(';').map(s => s.trim());
    if (cols.length < 2) continue;
    out.push({
      dato: cols[0],
      belob: parseFloat((cols[1] || '0').replace(',', '.')),
      tekst: cols[2] || '',
      reference: cols[3] || '',
    });
  }
  return out;
}

// Heuristisk match: prøv at finde fakturanr i tekst/reference, ellers kunde-id.
async function findFaktura(tx) {
  const haystack = `${tx.tekst} ${tx.reference}`.toLowerCase();
  // 1) Tjek for fakturanr (6-cifret).
  const fnrMatch = haystack.match(/\b(\d{6,7})\b/);
  if (fnrMatch) {
    const f = await one(`SELECT * FROM fakturaer WHERE fakturanr = $1`, [Number(fnrMatch[1])]);
    if (f) return { faktura: f, match: 'fakturanr' };
  }
  // 2) Tjek for kunde-id (KU-XXXXXX).
  const kuMatch = haystack.match(/KU-[A-Z0-9]{6}/i);
  if (kuMatch) {
    const f = await one(`
      SELECT * FROM fakturaer
      WHERE kunde_id = $1 AND status NOT IN ('betalt','krediteret') AND ABS(belob_incl - betalt_belob - $2) < 0.01
      ORDER BY forfaldsdato LIMIT 1
    `, [kuMatch[0].toUpperCase(), tx.belob]);
    if (f) return { faktura: f, match: 'kunde_id+belob' };
  }
  // 3) Find faktura med præcis matching beløb og åben status.
  const f = await one(`
    SELECT * FROM fakturaer
    WHERE status NOT IN ('betalt','krediteret','kladde')
      AND ABS(belob_incl - betalt_belob - $1) < 0.01
    ORDER BY forfaldsdato LIMIT 1
  `, [tx.belob]);
  if (f) return { faktura: f, match: 'belob_unique' };
  return null;
}

router.post('/preview', async (req, res, next) => {
  try {
    const tx = req.body?.csv ? parseCsv(req.body.csv) : (req.body?.transaktioner || []);
    if (!tx.length) return res.status(400).json({ error: 'Ingen transaktioner. Send {csv: "..."} eller {transaktioner: [...]}' });
    const result = [];
    for (const t of tx) {
      const m = await findFaktura(t);
      result.push({ tx: t, match: m ? { faktura_id: m.faktura.id, fakturanr: m.faktura.fakturanr, kunde_id: m.faktura.kunde_id, hvordan: m.match } : null });
    }
    const matchet = result.filter(r => r.match).length;
    res.json({ antal: tx.length, matchet, ikke_matchet: tx.length - matchet, transaktioner: result });
  } catch (e) { next(e); }
});

router.post('/import', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tx = req.body?.csv ? parseCsv(req.body.csv) : (req.body?.transaktioner || []);
    const bruger = req.body?.bruger || 'Økonomi';
    const registreret = []; const fejlkoe = [];
    for (const t of tx) {
      const m = await findFaktura(t);
      if (!m) { fejlkoe.push({ tx: t, fejl: 'Ingen match — kræver manuel allokering' }); continue; }
      const f = (await client.query(`SELECT * FROM fakturaer WHERE id = $1 FOR UPDATE`, [m.faktura.id])).rows[0];
      await client.query(
        `INSERT INTO betalinger (faktura_id, belob, betalingsdato, metode, reference)
         VALUES ($1,$2,COALESCE($3, CURRENT_DATE),'bank',$4)`,
        [f.id, t.belob, t.dato, `${t.tekst} ${t.reference}`.trim().slice(0, 200)]
      );
      const nyBetalt = Number(f.betalt_belob) + Number(t.belob);
      const helt = nyBetalt >= Number(f.belob_incl) - 0.01;
      await client.query(
        `UPDATE fakturaer SET betalt_belob = $1, status = $2, betalt = CASE WHEN $3 THEN now() ELSE betalt END WHERE id = $4`,
        [nyBetalt.toFixed(2), helt ? 'betalt' : f.status, helt, f.id]
      );
      registreret.push({ faktura_id: f.id, fakturanr: f.fakturanr, belob: t.belob, hvordan: m.match });
    }
    await client.query(
      `INSERT INTO audit_log (entitet, entitet_id, handling, bruger, detaljer)
       VALUES ('bankfil','import','behandlet',$1,$2::jsonb)`,
      [bruger, JSON.stringify({ antal: tx.length, registreret: registreret.length, fejlkoe: fejlkoe.length })]
    );
    await client.query('COMMIT');
    res.json({ antal: tx.length, registreret, fejlkoe });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    next(e);
  } finally { client.release(); }
});

module.exports = router;
