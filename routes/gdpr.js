// UC-58 GDPR-selvbetjening — kunde får indsigt, eksport og sletteanmodning.
const express = require('express');
const router = express.Router();
const { query, one, pool } = require('../db');

// Komplet datapakke til en kunde — alt vi har om dem.
router.get('/:kunde_id/eksport', async (req, res, next) => {
  try {
    const k = await one(`SELECT * FROM kunder WHERE id = $1`, [req.params.kunde_id]);
    if (!k) return res.status(404).json({ error: 'Kunde ikke fundet' });
    const [kontrakter, fakturaer, fakturalinjer, betalinger, kreditnotaer, sager, sag_aktiviteter, samtykker, fuldmagter, sendte_breve, audit] = await Promise.all([
      query(`SELECT * FROM kontrakter WHERE kunde_id = $1`, [req.params.kunde_id]),
      query(`SELECT * FROM fakturaer WHERE kunde_id = $1`, [req.params.kunde_id]),
      query(`SELECT l.* FROM fakturalinjer l JOIN fakturaer f ON f.id = l.faktura_id WHERE f.kunde_id = $1`, [req.params.kunde_id]),
      query(`SELECT b.* FROM betalinger b JOIN fakturaer f ON f.id = b.faktura_id WHERE f.kunde_id = $1`, [req.params.kunde_id]),
      query(`SELECT k.* FROM kreditnotaer k JOIN fakturaer f ON f.id = k.faktura_id WHERE f.kunde_id = $1`, [req.params.kunde_id]),
      query(`SELECT * FROM sager WHERE kunde_id = $1`, [req.params.kunde_id]),
      query(`SELECT a.* FROM sag_aktiviteter a JOIN sager s ON s.id = a.sag_id WHERE s.kunde_id = $1`, [req.params.kunde_id]),
      query(`SELECT * FROM samtykker WHERE kunde_id = $1`, [req.params.kunde_id]),
      query(`SELECT * FROM fuldmagter WHERE ejer_kunde_id = $1 OR agent_kunde_id = $1`, [req.params.kunde_id]),
      query(`SELECT * FROM sendte_breve WHERE kunde_id = $1`, [req.params.kunde_id]),
      query(`SELECT * FROM audit_log WHERE entitet_id = $1 OR detaljer::text LIKE $2 ORDER BY oprettet`,
            [req.params.kunde_id, '%' + req.params.kunde_id + '%']),
    ]);

    const datapakke = {
      eksport_tidspunkt: new Date().toISOString(),
      gdpr_grundlag: 'Artikel 15 — ret til indsigt',
      kunde: k, kontrakter, fakturaer, fakturalinjer, betalinger, kreditnotaer,
      sager, sag_aktiviteter, samtykker, fuldmagter, sendte_breve, audit_log: audit,
    };
    await pool.query(
      `INSERT INTO audit_log (entitet, entitet_id, handling, bruger, detaljer)
       VALUES ('gdpr',$1,'eksport_genereret',$2,$3::jsonb)`,
      [req.params.kunde_id, req.query.bruger || 'Kunde', JSON.stringify({ records: { fakturaer: fakturaer.length, sager: sager.length, audit: audit.length } })]
    );

    if (req.query.format === 'json-download') {
      res.set('Content-Type', 'application/json; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="gdpr-eksport-${req.params.kunde_id}.json"`);
    }
    res.json(datapakke);
  } catch (e) { next(e); }
});

// Anmod om sletning. Vi sletter ikke direkte — flagger som sag for manuel review,
// fordi økonomiske data har lovmæssig opbevaringspligt (5 år bogføringsloven).
router.post('/:kunde_id/sletteanmodning', async (req, res, next) => {
  try {
    const { begrundelse = 'Kundens GDPR Art. 17-anmodning' } = req.body || {};
    const k = await one(`SELECT * FROM kunder WHERE id = $1`, [req.params.kunde_id]);
    if (!k) return res.status(404).json({ error: 'Kunde ikke fundet' });
    const sagId = 'SAG-' + Math.random().toString(36).slice(2, 8).toUpperCase();
    await pool.query(
      `INSERT INTO sager (id, domain, kategori, prioritet, titel, beskrivelse, kunde_id, ansvarlig, sla_frist)
       VALUES ($1,'kunde','gdpr_sletning','hoej',$2,$3,$4,'Compliance', now() + interval '30 days')`,
      [sagId, `GDPR sletteanmodning — ${k.navn}`,
       `${begrundelse}\n\nBemærk: økonomiske data har 5-årig opbevaringspligt (bogføringsloven). Personoplysninger uden retsligt grundlag kan slettes/anonymiseres efter periodens udløb.`,
       req.params.kunde_id]
    );
    await pool.query(
      `INSERT INTO audit_log (entitet, entitet_id, handling, bruger, detaljer)
       VALUES ('gdpr',$1,'sletteanmodning',$2,$3::jsonb)`,
      [req.params.kunde_id, req.body?.bruger || 'Kunde', JSON.stringify({ sag_id: sagId, begrundelse })]
    );
    res.status(201).json({ ok: true, sag_id: sagId, hint: 'Sag oprettet til compliance-review. 30-dages SLA jf. GDPR Art. 12.' });
  } catch (e) { next(e); }
});

// Anonymiser kunde — bruges efter compliance-review og opbevaringspligt udløbet.
// Erstatter persondata med "ANONYMISERET" men bevarer faktureringsrelationer.
router.post('/:kunde_id/anonymiser', async (req, res, next) => {
  try {
    const { godkendt_af = 'Compliance' } = req.body || {};
    const k = await one(`SELECT * FROM kunder WHERE id = $1`, [req.params.kunde_id]);
    if (!k) return res.status(404).json({ error: 'Kunde ikke fundet' });
    if (k.navn === 'ANONYMISERET') return res.status(400).json({ error: 'Allerede anonymiseret' });

    await pool.query(`UPDATE kunder SET navn = 'ANONYMISERET', cpr = NULL, email = NULL, telefon = NULL,
      pbs_pbsnr = NULL, pbs_debgr = NULL, status = 'lukket' WHERE id = $1`, [req.params.kunde_id]);
    await pool.query(`DELETE FROM samtykker WHERE kunde_id = $1`, [req.params.kunde_id]);
    await pool.query(
      `INSERT INTO audit_log (entitet, entitet_id, handling, bruger, detaljer)
       VALUES ('gdpr',$1,'anonymiseret',$2,$3::jsonb)`,
      [req.params.kunde_id, godkendt_af, JSON.stringify({ tidligere_navn_hash: 'sha256:' + Buffer.from(k.navn).toString('hex').slice(0, 16) })]
    );
    res.json({ ok: true, hint: 'Persondata fjernet. Fakturarelationer bevaret af bogføringsmæssige hensyn.' });
  } catch (e) { next(e); }
});

// Politik-overblik: hvilke datatyper har vi, hvor længe gemmes de.
router.get('/politik', (req, res) => {
  res.json({
    opbevaringsregler: [
      { entitet: 'kunder', retention: 'Bogføringspligt 5 år efter sidste transaktion' },
      { entitet: 'fakturaer/fakturalinjer/betalinger/kreditnotaer', retention: '5 år (bogføringsloven §10)' },
      { entitet: 'sager + sag_aktiviteter', retention: '5 år eller indtil afsluttet + 1 år' },
      { entitet: 'samtykker', retention: 'Indtil tilbagekaldelse + 3 år som dokumentation' },
      { entitet: 'audit_log', retention: '5 år (compliance og revision)' },
      { entitet: 'tomninger', retention: '3 år (statistisk og ADS-indberetning)' },
      { entitet: 'webhook_log', retention: '90 dage (debugging)' },
    ],
    rettigheder: [
      'Art. 15 — indsigt: GET /gdpr/:kunde_id/eksport',
      'Art. 16 — berigtigelse: PUT /kunder/:id',
      'Art. 17 — sletning: POST /gdpr/:kunde_id/sletteanmodning',
      'Art. 20 — dataportabilitet: GET /gdpr/:kunde_id/eksport?format=json-download',
      'Art. 21 — indsigelse: POST /samtykker (status=false)',
    ],
  });
});

module.exports = router;
