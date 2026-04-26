// UC-35 Årsopgørelse — samlet oversigt for året pr. kunde.
const express = require('express');
const router = express.Router();
const { query, one } = require('../db');

function dkk(v) {
  return new Intl.NumberFormat('da-DK', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(v || 0));
}

async function loadAarsdata(kundeId, aar) {
  const k = await one(`SELECT * FROM kunder WHERE id = $1`, [kundeId]);
  if (!k) return null;
  const fra = `${aar}-01-01`;
  const til = `${aar}-12-31`;

  const fakturaer = await query(`
    SELECT * FROM fakturaer
    WHERE kunde_id = $1
      AND fakturadato BETWEEN $2 AND $3
      AND status NOT IN ('kladde')
    ORDER BY fakturadato
  `, [kundeId, fra, til]);

  const fakturaIds = fakturaer.map(f => f.id);
  const linjer = fakturaIds.length
    ? await query(`SELECT l.*, f.fakturanr FROM fakturalinjer l JOIN fakturaer f ON f.id = l.faktura_id WHERE l.faktura_id = ANY($1::text[])`, [fakturaIds])
    : [];
  const kreditnotaer = fakturaIds.length
    ? await query(`SELECT * FROM kreditnotaer WHERE faktura_id = ANY($1::text[])`, [fakturaIds])
    : [];
  const betalinger = fakturaIds.length
    ? await query(`SELECT * FROM betalinger WHERE faktura_id = ANY($1::text[])`, [fakturaIds])
    : [];

  // Aggreger pr. type (grundgebyr/tomning/tillaeg).
  const byType = {};
  for (const l of linjer) {
    const t = l.type || 'andet';
    byType[t] = byType[t] || { antal: 0, belob_excl: 0, moms: 0, belob_incl: 0 };
    byType[t].antal += Number(l.antal);
    byType[t].belob_excl += Number(l.belob_excl);
    byType[t].moms += Number(l.moms);
    byType[t].belob_incl += Number(l.belob_incl);
  }

  const totals = {
    fakturaer_antal: fakturaer.length,
    belob_excl: fakturaer.reduce((s, f) => s + Number(f.belob_excl), 0),
    moms: fakturaer.reduce((s, f) => s + Number(f.moms), 0),
    belob_incl: fakturaer.reduce((s, f) => s + Number(f.belob_incl), 0),
    betalt: betalinger.reduce((s, b) => s + Number(b.belob), 0),
    krediteret: kreditnotaer.reduce((s, k) => s + Number(k.belob), 0),
  };

  return { kunde: k, aar, fakturaer, linjer, kreditnotaer, betalinger, byType, totals };
}

router.get('/:id', async (req, res, next) => {
  try {
    const aar = parseInt(req.query.aar, 10) || new Date().getFullYear();
    const d = await loadAarsdata(req.params.id, aar);
    if (!d) return res.status(404).json({ error: 'Kunde ikke fundet' });
    res.json(d);
  } catch (e) { next(e); }
});

// HTML print til e-Boks/e-mail levering.
router.get('/:id/html', async (req, res, next) => {
  try {
    const aar = parseInt(req.query.aar, 10) || new Date().getFullYear();
    const d = await loadAarsdata(req.params.id, aar);
    if (!d) return res.status(404).send('Kunde ikke fundet');

    const typeLabel = (t) => ({
      grundgebyr: 'Grundgebyr', tomning: 'Tømninger',
      tillaeg: 'Tillægsydelser', forbrug: 'Forbrug', kreditering: 'Kreditering'
    })[t] || t;

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html lang="da"><head><meta charset="UTF-8"><title>Årsopgørelse ${aar} – ${d.kunde.navn}</title>
<style>
  body{font-family:Helvetica,Arial,sans-serif;color:#111;padding:30px;max-width:800px;margin:auto;}
  h1{font-size:28px;color:#2563eb;margin-bottom:4px}
  .head{margin-bottom:24px;padding-bottom:14px;border-bottom:1px solid #e5e7eb}
  .head .meta{color:#6b7280;font-size:13px}
  h2{font-size:16px;margin-top:22px;margin-bottom:10px;color:#374151}
  table{width:100%;border-collapse:collapse;margin-bottom:14px}
  th,td{padding:8px 10px;border-bottom:1px solid #e5e7eb;font-size:13px;text-align:left}
  th{background:#f9fafb;color:#6b7280;font-weight:600;text-transform:uppercase;font-size:10px;letter-spacing:.5px}
  td.num,th.num{text-align:right}
  .totals{margin:20px 0 0 auto;width:380px;font-size:13px}
  .totals tr td{padding:6px 10px;border:none}
  .totals .grand{font-size:16px;font-weight:700;border-top:2px solid #111}
  .footer{margin-top:30px;padding-top:14px;border-top:1px solid #e5e7eb;font-size:11px;color:#6b7280}
  @media print{body{padding:0}}
</style></head><body>
<div class="head">
  <h1>Årsopgørelse ${aar}</h1>
  <div class="meta"><strong>${d.kunde.navn}</strong> · ${d.kunde.id}${d.kunde.cvr ? ' · CVR ' + d.kunde.cvr : ''}</div>
  <div class="meta">${d.fakturaer.length} fakturaer udstedt i året</div>
</div>

<h2>Forbrug og afregning per type</h2>
<table>
  <thead><tr><th>Type</th><th class="num">Antal</th><th class="num">Beløb excl.</th><th class="num">Moms</th><th class="num">Beløb incl.</th></tr></thead>
  <tbody>${Object.entries(d.byType).map(([t, v]) => `<tr>
    <td>${typeLabel(t)}</td>
    <td class="num">${Number(v.antal).toLocaleString('da-DK', { maximumFractionDigits: 2 })}</td>
    <td class="num">${dkk(v.belob_excl)} kr.</td>
    <td class="num">${dkk(v.moms)} kr.</td>
    <td class="num"><strong>${dkk(v.belob_incl)} kr.</strong></td>
  </tr>`).join('')}</tbody>
</table>

<h2>Fakturaer udstedt i ${aar}</h2>
<table>
  <thead><tr><th>Nr.</th><th>Dato</th><th>Periode</th><th class="num">Beløb incl.</th><th>Status</th></tr></thead>
  <tbody>${d.fakturaer.map(f => `<tr>
    <td>${f.fakturanr}</td>
    <td>${f.fakturadato instanceof Date ? f.fakturadato.toISOString().slice(0,10) : f.fakturadato}</td>
    <td>${(f.periode_fra instanceof Date ? f.periode_fra.toISOString().slice(0,10) : f.periode_fra)} – ${(f.periode_til instanceof Date ? f.periode_til.toISOString().slice(0,10) : f.periode_til)}</td>
    <td class="num">${dkk(f.belob_incl)} kr.</td>
    <td>${f.status}</td>
  </tr>`).join('')}</tbody>
</table>

<table class="totals">
  <tr><td>Faktureret excl. moms</td><td class="num">${dkk(d.totals.belob_excl)} kr.</td></tr>
  <tr><td>Moms (25%)</td><td class="num">${dkk(d.totals.moms)} kr.</td></tr>
  <tr><td>Faktureret i alt</td><td class="num">${dkk(d.totals.belob_incl)} kr.</td></tr>
  ${d.totals.krediteret ? `<tr><td>Krediteret</td><td class="num">- ${dkk(d.totals.krediteret)} kr.</td></tr>` : ''}
  <tr><td>Indbetalt</td><td class="num">- ${dkk(d.totals.betalt)} kr.</td></tr>
  <tr class="grand"><td>Saldo (positiv = restance)</td><td class="num">${dkk(d.totals.belob_incl - d.totals.betalt - d.totals.krediteret)} kr.</td></tr>
</table>

<div class="footer">Årsopgørelse genereret af Settl RenSpild · ${new Date().toLocaleDateString('da-DK')}<br>
Bemærk: Erhvervskunder kan bruge denne opgørelse som dokumentation ved skatteindberetning.</div>
</body></html>`);
  } catch (e) { next(e); }
});

// Bulk-eksport til alle aktive kunder (for januar-cron).
router.post('/koer-bulk', async (req, res, next) => {
  try {
    const aar = parseInt(req.body?.aar, 10) || new Date().getFullYear() - 1;
    const kunder = await query(`
      SELECT DISTINCT ku.id FROM kunder ku
      JOIN kontrakter k ON k.kunde_id = ku.id
      WHERE k.status IN ('aktiv','fritaget','opsagt')
    `);
    res.json({
      ok: true, aar,
      antal: kunder.length,
      mock: 'I produktion ville dette generere PDF/HTML pr. kunde og distribuere via e-Boks/e-mail',
      links: kunder.slice(0, 10).map(k => `/api/aarsopgoerelse/${k.id}/html?aar=${aar}`),
    });
  } catch (e) { next(e); }
});

module.exports = router;
