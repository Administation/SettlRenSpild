// UC-66 Kommunal opkrævningsfil — gebyrgrundlag til ejendomsskattebillet.
// Når renovation opkræves via kommunens ejendomsskat (i stedet for direkte til kunde),
// genererer Settl en fil med BFE-nr, ejendomstype, fraktioner og årligt beløb.
const express = require('express');
const router = express.Router();
const { query, one, pool } = require('../db');

router.get('/preview', async (req, res, next) => {
  try {
    const { kommune_id, aar } = req.query;
    const aarParam = parseInt(aar, 10) || new Date().getFullYear();
    if (!kommune_id) return res.status(400).json({ error: 'kommune_id påkrævet' });

    const rows = await query(`
      SELECT e.id AS ejendom_id, e.bbr_id, e.bfe_nr, e.vejnavn, e.husnr, e.postnr, e.by, e.ejendomstype,
             ku.id AS kunde_id, ku.navn AS kunde_navn,
             k.id AS kontrakt_id,
             COALESCE(SUM(f.belob_incl) FILTER (WHERE EXTRACT(YEAR FROM f.fakturadato) = $2), 0)::numeric AS aarsbelob_incl,
             COUNT(b.id)::int AS antal_beholdere
      FROM kontrakter k
      JOIN ejendomme e ON e.id = k.ejendom_id
      JOIN kunder ku ON ku.id = k.kunde_id
      LEFT JOIN beholdere b ON b.kontrakt_id = k.id
      LEFT JOIN fakturaer f ON f.kontrakt_id = k.id AND f.status NOT IN ('kladde','krediteret')
      WHERE e.kommune_id = $1
        AND k.status IN ('aktiv','fritaget')
      GROUP BY e.id, e.bbr_id, e.bfe_nr, e.vejnavn, e.husnr, e.postnr, e.by, e.ejendomstype,
               ku.id, ku.navn, k.id
      ORDER BY e.postnr, e.vejnavn
    `, [kommune_id, aarParam]);

    const total = rows.reduce((s, r) => s + Number(r.aarsbelob_incl), 0);
    res.json({ kommune_id, aar: aarParam, antal: rows.length, total: total.toFixed(2), rows });
  } catch (e) { next(e); }
});

router.get('/fil', async (req, res, next) => {
  try {
    const { kommune_id, aar } = req.query;
    const aarParam = parseInt(aar, 10) || new Date().getFullYear();
    if (!kommune_id) return res.status(400).send('kommune_id påkrævet');

    const rows = await query(`
      SELECT e.bfe_nr, e.bbr_id, e.vejnavn, e.husnr, e.postnr, e.by, e.ejendomstype,
             ku.id AS kunde_id, ku.cvr,
             COALESCE(SUM(f.belob_incl) FILTER (WHERE EXTRACT(YEAR FROM f.fakturadato) = $2), 0)::numeric AS aarsbelob
      FROM kontrakter k
      JOIN ejendomme e ON e.id = k.ejendom_id
      JOIN kunder ku ON ku.id = k.kunde_id
      LEFT JOIN fakturaer f ON f.kontrakt_id = k.id AND f.status NOT IN ('kladde','krediteret')
      WHERE e.kommune_id = $1 AND k.status IN ('aktiv','fritaget')
      GROUP BY e.id, e.bfe_nr, e.bbr_id, e.vejnavn, e.husnr, e.postnr, e.by, e.ejendomstype, ku.id, ku.cvr
      HAVING COALESCE(SUM(f.belob_incl) FILTER (WHERE EXTRACT(YEAR FROM f.fakturadato) = $2), 0) > 0
      ORDER BY e.postnr, e.vejnavn
    `, [kommune_id, aarParam]);

    // Format: BFE_NR;BBR_ID;EJENDOMSTYPE;ADRESSE;POSTNR;BY;CVR;AARSBELOB_OERE
    const lines = ['# Settl Renovation — Kommunal opkrævningsfil'];
    lines.push(`# Kommune: ${kommune_id} · År: ${aarParam} · Antal: ${rows.length}`);
    lines.push('BFE_NR;BBR_ID;EJENDOMSTYPE;ADRESSE;POSTNR;BY;CVR;AARSBELOB_OERE');
    let total = 0;
    for (const r of rows) {
      const adr = `${r.vejnavn || ''} ${r.husnr || ''}`.trim();
      const oere = Math.round(Number(r.aarsbelob) * 100);
      total += oere;
      lines.push([r.bfe_nr || '', r.bbr_id || '', r.ejendomstype || '', adr, r.postnr || '', r.by || '', r.cvr || '', oere].join(';'));
    }
    lines.push(`# TOTAL_OERE: ${total}`);

    await pool.query(
      `INSERT INTO audit_log (entitet, entitet_id, handling, bruger, detaljer)
       VALUES ('kommunal_opkraevning',$1,'genereret',$2,$3::jsonb)`,
      [`${kommune_id}/${aarParam}`, 'System',
       JSON.stringify({ antal: rows.length, total_oere: total })]
    );

    const filename = `kommunal-opkravning-${kommune_id}-${aarParam}.txt`;
    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(lines.join('\n'));
  } catch (e) { next(e); }
});

module.exports = router;
