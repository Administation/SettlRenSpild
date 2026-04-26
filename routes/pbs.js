// UC-30 PBS-opkrævning via NETS — generér opkrævningsfil til Betalingsservice.
// Forenklet format (NETS Section 41 light): én linje pr. faktura med
// PBS-nr/debitorgruppe/beløb/forfald. I produktion skal dette være
// rigtig ISO 20022 PAIN.008 eller NETS-specifikke feltformater.
const express = require('express');
const router = express.Router();
const { query, one, pool } = require('../db');

router.get('/preview', async (req, res, next) => {
  try {
    const { forfaldsdato_fra, forfaldsdato_til } = req.query;
    if (!forfaldsdato_fra || !forfaldsdato_til) return res.status(400).json({ error: 'forfaldsdato_fra og forfaldsdato_til påkrævet' });
    const rows = await query(`
      SELECT f.id, f.fakturanr, f.belob_incl, f.betalt_belob, f.forfaldsdato,
             k.id AS kunde_id, k.navn AS kunde_navn, k.pbs_pbsnr, k.pbs_debgr
      FROM fakturaer f JOIN kunder k ON k.id = f.kunde_id
      WHERE k.pbs_aktiv = TRUE
        AND f.status IN ('godkendt','sendt')
        AND f.forfaldsdato BETWEEN $1 AND $2
        AND (f.belob_incl - f.betalt_belob) > 0
      ORDER BY f.forfaldsdato, k.navn
    `, [forfaldsdato_fra, forfaldsdato_til]);
    const total = rows.reduce((s, r) => s + (Number(r.belob_incl) - Number(r.betalt_belob)), 0);
    res.json({ antal: rows.length, total: total.toFixed(2), rows });
  } catch (e) { next(e); }
});

router.get('/fil', async (req, res, next) => {
  try {
    const { forfaldsdato_fra, forfaldsdato_til } = req.query;
    if (!forfaldsdato_fra || !forfaldsdato_til) return res.status(400).send('forfaldsdato_fra og forfaldsdato_til påkrævet');
    const rows = await query(`
      SELECT f.id, f.fakturanr, f.belob_incl, f.betalt_belob, f.forfaldsdato,
             k.id AS kunde_id, k.navn AS kunde_navn, k.pbs_pbsnr, k.pbs_debgr
      FROM fakturaer f JOIN kunder k ON k.id = f.kunde_id
      WHERE k.pbs_aktiv = TRUE
        AND f.status IN ('godkendt','sendt')
        AND f.forfaldsdato BETWEEN $1 AND $2
        AND (f.belob_incl - f.betalt_belob) > 0
      ORDER BY f.forfaldsdato, k.navn
    `, [forfaldsdato_fra, forfaldsdato_til]);

    const isoDate = (v) => v instanceof Date ? v.toISOString().slice(0,10) : String(v).slice(0,10);
    const fileDate = new Date().toISOString().slice(0,10).replace(/-/g, '');
    const lines = [];
    lines.push(`HDR;NETS;PBS;${fileDate};SettlRenSpild;${rows.length}`);
    let total = 0;
    for (const r of rows) {
      const belob = Number(r.belob_incl) - Number(r.betalt_belob);
      total += belob;
      // Format: REC;PBSNR;DEBGR;FAKTURANR;BELØB_ØRE;FORFALD_YYYYMMDD;TEKST
      const beloebOere = Math.round(belob * 100);
      const forfald = isoDate(r.forfaldsdato).replace(/-/g, '');
      const tekst = `Renovation faktura ${r.fakturanr}`.slice(0, 35);
      lines.push(`REC;${r.pbs_pbsnr || ''};${r.pbs_debgr || ''};${r.fakturanr};${beloebOere};${forfald};${tekst}`);
    }
    lines.push(`TRL;${rows.length};${Math.round(total * 100)}`);

    // Audit-log for compliance.
    await pool.query(
      `INSERT INTO audit_log (entitet, entitet_id, handling, bruger, detaljer)
       VALUES ('pbs_fil', $1, 'genereret', $2, $3::jsonb)`,
      [`${forfaldsdato_fra}..${forfaldsdato_til}`, 'System',
       JSON.stringify({ antal: rows.length, total: total.toFixed(2) })]
    );

    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="pbs-${fileDate}.txt"`);
    res.send(lines.join('\n'));
  } catch (e) { next(e); }
});

// Mock NETS-retur: registrér betalinger fra en simuleret returfil.
router.post('/retur', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { betalinger = [] } = req.body;
    let registreret = 0;
    let afvist = 0;
    for (const b of betalinger) {
      if (b.status === 'betalt' && b.fakturanr) {
        const f = (await client.query(`SELECT * FROM fakturaer WHERE fakturanr = $1 FOR UPDATE`, [b.fakturanr])).rows[0];
        if (f) {
          await client.query(
            `INSERT INTO betalinger (faktura_id, belob, betalingsdato, metode, reference)
             VALUES ($1,$2,COALESCE($3, CURRENT_DATE),'pbs',$4)`,
            [f.id, b.belob, b.dato || null, `NETS-PBS retur ${b.reference || ''}`]
          );
          const nyBetalt = Number(f.betalt_belob) + Number(b.belob);
          const helt = nyBetalt >= Number(f.belob_incl) - 0.01;
          await client.query(
            `UPDATE fakturaer SET betalt_belob = $1, status = $2, betalt = CASE WHEN $3 THEN now() ELSE betalt END WHERE id = $4`,
            [nyBetalt.toFixed(2), helt ? 'betalt' : f.status, helt, f.id]
          );
          registreret++;
        }
      } else {
        afvist++;
      }
    }
    await client.query('COMMIT');
    res.json({ registreret, afvist });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    next(e);
  } finally { client.release(); }
});

module.exports = router;
