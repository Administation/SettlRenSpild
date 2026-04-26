// UC-07 Afhentningskalender — PDF (HTML print) og iCal (RFC 5545) per kunde.
const express = require('express');
const router = express.Router();
const { query, one } = require('../db');

function isoDate(v) {
  if (!v) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}
function ical(v) { return isoDate(v).replace(/-/g, ''); }

async function loadKalender(kundeId) {
  const k = await one(`SELECT * FROM kunder WHERE id = $1`, [kundeId]);
  if (!k) return null;
  const kontrakter = await query(`
    SELECT k.id, e.vejnavn, e.husnr, e.postnr, e.by, e.kommune_id, ko.navn AS kommune_navn
    FROM kontrakter k
    LEFT JOIN ejendomme e ON e.id = k.ejendom_id
    LEFT JOIN kommuner ko ON ko.id = e.kommune_id
    WHERE k.kunde_id = $1 AND k.status IN ('aktiv','fritaget')
  `, [kundeId]);
  const planlagt = await query(`
    SELECT p.planlagt_dato, p.status, b.id AS beholder_id, b.volumen_l, b.frekvens,
           f.navn AS fraktion_navn, f.farve, k.id AS kontrakt_id,
           e.vejnavn, e.husnr, e.postnr, e.by
    FROM tomningsplaner p
    JOIN beholdere b ON b.id = p.beholder_id
    JOIN fraktioner f ON f.id = b.fraktion_id
    JOIN kontrakter k ON k.id = b.kontrakt_id
    LEFT JOIN ejendomme e ON e.id = k.ejendom_id
    WHERE k.kunde_id = $1
      AND p.planlagt_dato >= CURRENT_DATE
      AND p.planlagt_dato <= CURRENT_DATE + interval '12 months'
      AND p.status = 'planlagt'
    ORDER BY p.planlagt_dato, f.navn
  `, [kundeId]);
  return { kunde: k, kontrakter, planlagt };
}

// iCal RFC 5545 — kan importeres i Outlook, Apple Calendar, Google Calendar.
router.get('/:id/kalender.ics', async (req, res, next) => {
  try {
    const d = await loadKalender(req.params.id);
    if (!d) return res.status(404).send('Kunde ikke fundet');

    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Settl RenSpild//Renovation Calendar//DA',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      `X-WR-CALNAME:Renovation – ${d.kunde.navn}`,
      'X-WR-TIMEZONE:Europe/Copenhagen',
    ];
    for (const t of d.planlagt) {
      const adr = `${t.vejnavn || ''} ${t.husnr || ''}, ${t.postnr || ''} ${t.by || ''}`.trim();
      const uid = `${t.beholder_id}-${ical(t.planlagt_dato)}@settl-renspild`;
      lines.push(
        'BEGIN:VEVENT',
        `UID:${uid}`,
        `DTSTAMP:${ical(new Date().toISOString().slice(0,10))}T000000Z`,
        `DTSTART;VALUE=DATE:${ical(t.planlagt_dato)}`,
        `DTEND;VALUE=DATE:${ical(new Date(new Date(t.planlagt_dato).getTime() + 86400000).toISOString().slice(0,10))}`,
        `SUMMARY:🗑️ ${t.fraktion_navn} (${t.volumen_l}L)`,
        `DESCRIPTION:Tømning af ${t.fraktion_navn} – beholder ${t.beholder_id} – ${t.frekvens}`,
        `LOCATION:${adr}`,
        'BEGIN:VALARM',
        'TRIGGER:-PT12H',
        'ACTION:DISPLAY',
        `DESCRIPTION:Husk at sætte ${t.fraktion_navn.toLowerCase()} ud i morgen`,
        'END:VALARM',
        'END:VEVENT'
      );
    }
    lines.push('END:VCALENDAR');
    res.set('Content-Type', 'text/calendar; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="renovation-${req.params.id}.ics"`);
    res.send(lines.join('\r\n'));
  } catch (e) { next(e); }
});

// HTML print til PDF — pænt formateret kalender per måned.
router.get('/:id/kalender.html', async (req, res, next) => {
  try {
    const d = await loadKalender(req.params.id);
    if (!d) return res.status(404).send('Kunde ikke fundet');

    // Gruppér efter måned.
    const byMaaned = {};
    for (const t of d.planlagt) {
      const dt = new Date(t.planlagt_dato);
      const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
      (byMaaned[key] = byMaaned[key] || []).push(t);
    }
    const maanedNavne = ['Januar','Februar','Marts','April','Maj','Juni','Juli','August','September','Oktober','November','December'];

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html lang="da"><head><meta charset="UTF-8"><title>Afhentningskalender ${d.kunde.navn}</title>
<style>
  body{font-family:Helvetica,Arial,sans-serif;color:#111;padding:30px;max-width:800px;margin:auto;}
  h1{font-size:26px;color:#2563eb;margin-bottom:4px}
  .head{margin-bottom:20px;padding-bottom:14px;border-bottom:1px solid #e5e7eb}
  .head .meta{color:#6b7280;font-size:13px}
  h2{font-size:18px;margin-top:22px;margin-bottom:8px;color:#374151}
  table{width:100%;border-collapse:collapse;margin-bottom:14px}
  th,td{padding:7px 9px;border-bottom:1px solid #e5e7eb;font-size:13px;text-align:left}
  th{background:#f9fafb;color:#6b7280;font-weight:600;text-transform:uppercase;font-size:10px;letter-spacing:.5px}
  .dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px;vertical-align:middle}
  .footer{margin-top:30px;padding-top:14px;border-top:1px solid #e5e7eb;font-size:11px;color:#6b7280}
  @media print{body{padding:0}}
</style></head><body>
<div class="head">
  <h1>Afhentningskalender</h1>
  <div class="meta"><strong>${d.kunde.navn}</strong> · ${d.kunde.id}</div>
  ${d.kontrakter.map(k => `<div class="meta">${k.vejnavn || ''} ${k.husnr || ''}, ${k.postnr || ''} ${k.by || ''}${k.kommune_navn ? ' · ' + k.kommune_navn : ''}</div>`).join('')}
  <div class="meta" style="margin-top:8px">Periode: de næste 12 måneder · ${d.planlagt.length} planlagte tømninger</div>
</div>
${Object.keys(byMaaned).sort().map(key => {
  const [aar, m] = key.split('-');
  const items = byMaaned[key];
  return `
    <h2>${maanedNavne[Number(m)-1]} ${aar}</h2>
    <table>
      <thead><tr><th style="width:140px">Dato</th><th>Fraktion</th><th>Volumen</th></tr></thead>
      <tbody>${items.map(t => `<tr>
        <td><strong>${new Date(t.planlagt_dato).toLocaleDateString('da-DK', { weekday: 'short', day: 'numeric', month: 'long' })}</strong></td>
        <td><span class="dot" style="background:${t.farve||'#999'}"></span>${t.fraktion_navn}</td>
        <td>${t.volumen_l} L · ${t.frekvens}</td>
      </tr>`).join('')}</tbody>
    </table>`;
}).join('')}
<div class="footer">Genereret af Settl RenSpild · ${new Date().toLocaleDateString('da-DK')}<br>
Tilføj til din digitale kalender: <a href="/api/kunder/${d.kunde.id}/kalender.ics">renovation-${d.kunde.id}.ics</a></div>
</body></html>`);
  } catch (e) { next(e); }
});

module.exports = router;
