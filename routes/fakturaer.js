const express = require('express');
const router = express.Router();
const { query, one, pool } = require('../db');
const { parsePaging, paginatedQuery } = require('../lib/pagination');
const { buildInvoiceXml } = require('../lib/oioubl');

function genFakturaId() {
  return 'FA-' + Math.random().toString(36).slice(2, 8).toUpperCase();
}

function dkk(v) {
  return new Intl.NumberFormat('da-DK', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(v || 0));
}

router.get('/', async (req, res, next) => {
  try {
    const { kunde_id, status, service_type, q } = req.query;
    const { limit, offset } = parsePaging(req.query, { limit: 50 });
    const where = [];
    const params = [];
    if (kunde_id)     { params.push(kunde_id);     where.push(`f.kunde_id     = $${params.length}`); }
    if (service_type) { params.push(service_type); where.push(`f.service_type = $${params.length}`); }
    if (status) {
      if (status === 'restance') {
        where.push(`f.status IN ('sendt','forfalden','rykker','inddrivelse') AND f.forfaldsdato < CURRENT_DATE`);
      } else {
        const list = status.split(',').map(s => s.trim()).filter(Boolean);
        params.push(list);
        where.push(`f.status = ANY($${params.length}::text[])`);
      }
    }
    if (q) {
      params.push(`%${q}%`);
      where.push(`(k.navn ILIKE $${params.length} OR f.id ILIKE $${params.length} OR CAST(f.fakturanr AS TEXT) ILIKE $${params.length})`);
    }
    const result = await paginatedQuery(pool, {
      selectSql: 'f.*, k.navn AS kunde_navn',
      fromSql: 'fakturaer f JOIN kunder k ON k.id = f.kunde_id',
      whereSql: where.join(' AND '),
      params,
      orderBy: 'f.fakturadato DESC',
      limit,
      offset,
    });
    res.json(result);
  } catch (e) { next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const f = await one(`
      SELECT f.*, k.navn AS kunde_navn, k.cvr, k.cpr, k.email, k.telefon, k.faktura_kanal AS kunde_kanal,
             e.vejnavn, e.husnr, e.postnr, e.by, ko.navn AS kommune_navn
      FROM fakturaer f
      JOIN kunder k ON k.id = f.kunde_id
      LEFT JOIN ejendomme e ON e.id = f.ejendom_id
      LEFT JOIN kommuner ko ON ko.id = f.kommune_id
      WHERE f.id = $1
    `, [req.params.id]);
    if (!f) return res.status(404).json({ error: 'Faktura ikke fundet' });
    const linjer = await query(`SELECT * FROM fakturalinjer WHERE faktura_id = $1 ORDER BY id`, [req.params.id]);
    const betalinger = await query(`SELECT * FROM betalinger WHERE faktura_id = $1 ORDER BY betalingsdato`, [req.params.id]);
    res.json({ ...f, linjer, betalinger });
  } catch (e) { next(e); }
});

// Beregn fakturalinjer for en kontrakt over en given periode.
// Returnér IKKE persisteret data — bruges til simulation før godkendelse.
async function beregnLinjer(kontrakt, prisblad, periode_fra, periode_til) {
  const linjer = await query(`SELECT * FROM prisblad_linjer WHERE prisblad_id = $1`, [prisblad.id]);
  const out = [];

  // 1) Grundgebyr — pr. kontrakt for perioden.
  const grund = linjer.find(l => l.type === 'grundgebyr');
  if (grund) {
    const dage = (new Date(periode_til) - new Date(periode_fra)) / 86400000 + 1;
    const aarFraktion = dage / 365;
    const belob_excl = Number(grund.enhedspris) * aarFraktion;
    out.push({
      beskrivelse: `Grundgebyr (${dage.toFixed(0)} dage)`,
      type: 'grundgebyr',
      antal: aarFraktion.toFixed(4),
      enhed: 'år',
      enhedspris: grund.enhedspris,
      belob_excl: belob_excl.toFixed(2),
      moms_pct: grund.moms_pct,
    });
  }

  // 2) Tømninger — for renovation: tæl alle ufakturerede tømninger på beholdere i kontrakten.
  if (kontrakt.service_type === 'renovation') {
    const tomninger = await query(`
      SELECT t.*, b.fraktion_id, b.volumen_l, b.frekvens, f.navn AS fraktion_navn
      FROM tomninger t
      JOIN beholdere b ON b.id = t.beholder_id
      JOIN fraktioner f ON f.id = b.fraktion_id
      WHERE b.kontrakt_id = $1
        AND t.faktureret = FALSE
        AND t.tomning_dato BETWEEN $2 AND $3
        AND (t.undtagelseskode IS NULL OR t.undtagelseskode = 'overfyldt')
      ORDER BY t.tomning_dato
    `, [kontrakt.id, periode_fra, periode_til]);

    // Gruppér efter (fraktion, volumen, frekvens) → matcher prisblad-nøgle.
    const grupper = new Map();
    for (const t of tomninger) {
      const noegle = `${t.fraktion_id}-${t.volumen_l}l-${t.frekvens}`;
      const g = grupper.get(noegle) || { noegle, fraktion_navn: t.fraktion_navn, volumen_l: t.volumen_l, frekvens: t.frekvens, antal: 0, ids: [] };
      g.antal += 1;
      g.ids.push(t.id);
      grupper.set(noegle, g);
    }
    for (const g of grupper.values()) {
      const pris = linjer.find(l => l.type === 'tomning' && l.noegle === g.noegle);
      const enhedspris = pris ? Number(pris.enhedspris) : 0;
      out.push({
        beskrivelse: `Tømning ${g.fraktion_navn.toLowerCase()} ${g.volumen_l}L (${g.frekvens})`,
        type: 'tomning',
        ref_ids: g.ids,
        antal: g.antal,
        enhed: 'tømning',
        enhedspris,
        belob_excl: (enhedspris * g.antal).toFixed(2),
        moms_pct: pris ? pris.moms_pct : 25,
        match: !!pris,
      });
    }
  }

  // 3) Spildevand — placeholder for senere.
  // if (kontrakt.service_type === 'spildevand') { /* aflaesning baseret beregning */ }

  return out;
}

// Find aktivt prisblad for kontrakten på et givet tidspunkt.
async function findAktivtPrisblad(kontrakt, dato) {
  const ejendom = await one(`SELECT kommune_id FROM ejendomme WHERE id = $1`, [kontrakt.ejendom_id]);
  if (!ejendom?.kommune_id) return null;
  return await one(`
    SELECT * FROM prisblade
    WHERE service_type = $1 AND kommune_id = $2 AND status = 'aktiv'
      AND gyldig_fra <= $3::date AND (gyldig_til IS NULL OR gyldig_til >= $3::date)
    ORDER BY gyldig_fra DESC LIMIT 1
  `, [kontrakt.service_type, ejendom.kommune_id, dato]);
}

// SIMULATION — udfør ikke nogen DB-skrivning, returnér linjer + totaler.
router.post('/simuler', async (req, res, next) => {
  try {
    const { kontrakt_id, periode_fra, periode_til } = req.body;
    if (!kontrakt_id || !periode_fra || !periode_til) return res.status(400).json({ error: 'kontrakt_id, periode_fra, periode_til påkrævet' });
    const kontrakt = await one(`SELECT * FROM kontrakter WHERE id = $1`, [kontrakt_id]);
    if (!kontrakt) return res.status(404).json({ error: 'Kontrakt ikke fundet' });
    const prisblad = await findAktivtPrisblad(kontrakt, periode_til);
    if (!prisblad) return res.status(400).json({ error: 'Intet aktivt prisblad fundet for kontraktens kommune' });
    const linjer = await beregnLinjer(kontrakt, prisblad, periode_fra, periode_til);
    let belob_excl = 0, moms = 0, belob_incl = 0;
    for (const l of linjer) {
      const e = Number(l.belob_excl);
      const m = e * Number(l.moms_pct) / 100;
      belob_excl += e;
      moms += m;
      belob_incl += e + m;
    }
    res.json({
      kontrakt,
      prisblad: { id: prisblad.id, version: prisblad.version },
      periode: { fra: periode_fra, til: periode_til },
      linjer,
      total: { belob_excl: belob_excl.toFixed(2), moms: moms.toFixed(2), belob_incl: belob_incl.toFixed(2) },
    });
  } catch (e) { next(e); }
});

// GENERER — opret faktura + linjer i DB. Marker tomninger som fakturerede.
router.post('/generer', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { kontrakt_id, periode_fra, periode_til, fakturadato, forfaldsdato } = req.body;
    if (!kontrakt_id || !periode_fra || !periode_til) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'kontrakt_id, periode_fra, periode_til påkrævet' });
    }
    const kontrakt = (await client.query(`SELECT * FROM kontrakter WHERE id = $1`, [kontrakt_id])).rows[0];
    if (!kontrakt) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Kontrakt ikke fundet' }); }
    const ejendom = (await client.query(`SELECT * FROM ejendomme WHERE id = $1`, [kontrakt.ejendom_id])).rows[0];
    const kunde = (await client.query(`SELECT * FROM kunder WHERE id = $1`, [kontrakt.kunde_id])).rows[0];

    // Find prisblad og beregn linjer (genbrug logik fra simuler).
    const prisbladRow = await one(`
      SELECT * FROM prisblade
      WHERE service_type = $1 AND kommune_id = $2 AND status = 'aktiv'
        AND gyldig_fra <= $3::date AND (gyldig_til IS NULL OR gyldig_til >= $3::date)
      ORDER BY gyldig_fra DESC LIMIT 1
    `, [kontrakt.service_type, ejendom.kommune_id, periode_til]);
    if (!prisbladRow) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Intet aktivt prisblad' }); }
    const linjer = await beregnLinjer(kontrakt, prisbladRow, periode_fra, periode_til);

    let belob_excl = 0, moms = 0;
    for (const l of linjer) {
      const e = Number(l.belob_excl);
      belob_excl += e;
      moms += e * Number(l.moms_pct) / 100;
    }
    const belob_incl = belob_excl + moms;

    const id = genFakturaId();
    const fnr = (await client.query(`SELECT nextval('fakturanr_seq') AS n`)).rows[0].n;
    const fdato = fakturadato || new Date().toISOString().slice(0, 10);
    const forfald = forfaldsdato || new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);

    await client.query(
      `INSERT INTO fakturaer (id, fakturanr, service_type, kunde_id, ejendom_id, kontrakt_id, kommune_id,
        periode_fra, periode_til, fakturadato, forfaldsdato, status, belob_excl, moms, belob_incl, faktura_kanal)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'kladde',$12,$13,$14,$15)`,
      [id, fnr, kontrakt.service_type, kunde.id, ejendom?.id, kontrakt.id, ejendom?.kommune_id,
       periode_fra, periode_til, fdato, forfald, belob_excl.toFixed(2), moms.toFixed(2), belob_incl.toFixed(2), kunde.faktura_kanal]
    );

    for (const l of linjer) {
      const e = Number(l.belob_excl);
      const m = e * Number(l.moms_pct) / 100;
      const r = await client.query(
        `INSERT INTO fakturalinjer (faktura_id, beskrivelse, type, antal, enhed, enhedspris, belob_excl, moms_pct, moms, belob_incl)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [id, l.beskrivelse, l.type, l.antal, l.enhed, l.enhedspris, e.toFixed(2), l.moms_pct, m.toFixed(2), (e + m).toFixed(2)]
      );
      const linjeId = r.rows[0].id;
      // Marker tomninger som fakturerede.
      if (l.type === 'tomning' && Array.isArray(l.ref_ids) && l.ref_ids.length) {
        await client.query(
          `UPDATE tomninger SET faktureret = TRUE, faktura_linje_id = $1 WHERE id = ANY($2::text[])`,
          [linjeId, l.ref_ids]
        );
      }
    }

    await client.query(
      `INSERT INTO audit_log (entitet, entitet_id, handling, bruger, detaljer)
       VALUES ('faktura', $1, 'oprettet', 'System', $2::jsonb)`,
      [id, JSON.stringify({ fakturanr: fnr, periode_fra, periode_til })]
    );

    await client.query('COMMIT');
    const faktura = await one(`SELECT * FROM fakturaer WHERE id = $1`, [id]);
    const fLinjer = await query(`SELECT * FROM fakturalinjer WHERE faktura_id = $1`, [id]);
    res.status(201).json({ ...faktura, linjer: fLinjer });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    next(e);
  } finally {
    client.release();
  }
});

// UC-29 Opret kreditnota — modposterer en faktura helt eller delvist.
router.post('/:id/kreditnota', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { belob, aarsag, bruger='Support' } = req.body;
    if (!belob) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'belob påkrævet' }); }
    const f = (await client.query(`SELECT * FROM fakturaer WHERE id = $1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!f) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Faktura ikke fundet' }); }
    const knId = 'KN-' + Math.random().toString(36).slice(2, 8).toUpperCase();
    await client.query(
      `INSERT INTO kreditnotaer (id, faktura_id, belob, aarsag, oprettet_af)
       VALUES ($1,$2,$3,$4,$5)`,
      [knId, req.params.id, belob, aarsag, bruger]
    );
    // Hel kreditering: marker fakturaen som krediteret.
    if (Number(belob) >= Number(f.belob_incl) - 0.01) {
      await client.query(`UPDATE fakturaer SET status = 'krediteret' WHERE id = $1`, [req.params.id]);
    }
    await client.query(
      `INSERT INTO audit_log (entitet, entitet_id, handling, bruger, detaljer)
       VALUES ('faktura',$1,'krediteret',$2,$3::jsonb)`,
      [req.params.id, bruger, JSON.stringify({ kreditnota_id: knId, belob, aarsag })]
    );
    await client.query('COMMIT');
    res.status(201).json({ ok: true, id: knId, belob, aarsag });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    next(e);
  } finally { client.release(); }
});

// UC-32 Manuel rykker — sender én rykker (1 eller 2) på en forfalden faktura.
router.post('/:id/rykker', async (req, res, next) => {
  try {
    const f = await one(`SELECT * FROM fakturaer WHERE id = $1`, [req.params.id]);
    if (!f) return res.status(404).json({ error: 'Faktura ikke fundet' });
    const niveau = req.body?.niveau || (f.status === 'rykker' ? 2 : 1);
    const gebyr = niveau === 2 ? 100 : 0; // Renteloven: max 100 kr per rykker.
    const nyStatus = niveau === 2 ? 'rykker' : 'rykker';
    await pool.query(`UPDATE fakturaer SET status = $1 WHERE id = $2`, [nyStatus, req.params.id]);
    await pool.query(
      `INSERT INTO audit_log (entitet, entitet_id, handling, bruger, detaljer)
       VALUES ('faktura',$1,'rykker',$2,$3::jsonb)`,
      [req.params.id, req.body?.bruger || 'System', JSON.stringify({ niveau, gebyr, mock_kanal: f.faktura_kanal })]
    );
    res.json({ ok: true, niveau, gebyr, mock: { afsendt_via: f.faktura_kanal, tidspunkt: new Date().toISOString() } });
  } catch (e) { next(e); }
});

router.post('/:id/godkend', async (req, res, next) => {
  try {
    await pool.query(`UPDATE fakturaer SET status = 'godkendt' WHERE id = $1 AND status = 'kladde'`, [req.params.id]);
    await pool.query(
      `INSERT INTO audit_log (entitet, entitet_id, handling, bruger) VALUES ('faktura',$1,'godkendt',$2)`,
      [req.params.id, req.body?.bruger || 'System']
    );
    res.json(await one(`SELECT * FROM fakturaer WHERE id = $1`, [req.params.id]));
  } catch (e) { next(e); }
});

router.post('/:id/send', async (req, res, next) => {
  try {
    // Mock-afsendelse: simulér succesfuldt kald til e-Boks / Nemhandel afhængig af kanal.
    const f = await one(`SELECT * FROM fakturaer WHERE id = $1`, [req.params.id]);
    if (!f) return res.status(404).json({ error: 'Faktura ikke fundet' });
    const kanal = f.faktura_kanal;
    const mockResponse = { kanal, leveret: true, tidspunkt: new Date().toISOString() };
    await pool.query(`UPDATE fakturaer SET status = 'sendt', sendt = now() WHERE id = $1`, [req.params.id]);
    await pool.query(
      `INSERT INTO audit_log (entitet, entitet_id, handling, bruger, detaljer)
       VALUES ('faktura',$1,'sendt','System',$2::jsonb)`,
      [req.params.id, JSON.stringify(mockResponse)]
    );
    res.json({ ...await one(`SELECT * FROM fakturaer WHERE id = $1`, [req.params.id]), mock: mockResponse });
  } catch (e) { next(e); }
});

// OIOUBL 2.02 XML — bruges af Nemhandel/AccessPoint til erhvervsfakturering.
router.get('/:id/oioubl', async (req, res, next) => {
  try {
    const f = await one(`
      SELECT f.*, k.navn AS kunde_navn, k.cvr, k.ean, k.email AS kunde_email, k.telefon AS kunde_telefon,
             e.vejnavn, e.husnr, e.postnr, e.by,
             ko.navn AS kommune_navn, ko.cvr AS kommune_cvr, ko.ean AS kommune_ean,
             ko.email AS kommune_email, ko.telefon AS kommune_telefon
      FROM fakturaer f
      JOIN kunder k ON k.id = f.kunde_id
      LEFT JOIN ejendomme e ON e.id = f.ejendom_id
      LEFT JOIN kommuner ko ON ko.id = f.kommune_id
      WHERE f.id = $1
    `, [req.params.id]);
    if (!f) return res.status(404).json({ error: 'Faktura ikke fundet' });
    const linjer = await query(`SELECT * FROM fakturalinjer WHERE faktura_id = $1 ORDER BY id`, [req.params.id]);

    const xml = buildInvoiceXml({
      invoice: {
        id: f.id,
        fakturanr: f.fakturanr,
        fakturadato: f.fakturadato,
        forfaldsdato: f.forfaldsdato,
        periode_fra: f.periode_fra,
        periode_til: f.periode_til,
        valuta: 'DKK',
        isCreditNote: f.status === 'krediteret',
      },
      supplier: {
        navn: f.kommune_navn || 'Kommune',
        cvr: f.kommune_cvr,
        ean: f.kommune_ean,
        email: f.kommune_email,
        telefon: f.kommune_telefon,
        adresse: { vej: 'Kommunens adresse', postnr: '', by: f.kommune_navn },
      },
      customer: {
        navn: f.kunde_navn,
        cvr: f.cvr,
        ean: f.ean,
        email: f.kunde_email,
        telefon: f.kunde_telefon,
        adresse: { vej: f.vejnavn, husnr: f.husnr, postnr: f.postnr, by: f.by },
      },
      linjer: linjer.map(l => ({
        beskrivelse: l.beskrivelse,
        antal: l.antal,
        enhed: l.enhed,
        enhedspris: l.enhedspris,
        belob_excl: l.belob_excl,
        moms_pct: l.moms_pct,
      })),
      total: { belob_excl: f.belob_excl, moms: f.moms, belob_incl: f.belob_incl },
    });

    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="oioubl-${f.fakturanr || f.id}.xml"`);
    res.send(xml);
  } catch (e) { next(e); }
});

// HTML-print af faktura — returnér en standalone HTML der kan printes til PDF.
router.get('/:id/html', async (req, res, next) => {
  try {
    const f = await one(`
      SELECT f.*, k.navn AS kunde_navn, k.cvr, k.cpr, k.email, k.telefon,
             e.vejnavn, e.husnr, e.postnr, e.by, ko.navn AS kommune_navn, ko.cvr AS kommune_cvr
      FROM fakturaer f
      JOIN kunder k ON k.id = f.kunde_id
      LEFT JOIN ejendomme e ON e.id = f.ejendom_id
      LEFT JOIN kommuner ko ON ko.id = f.kommune_id
      WHERE f.id = $1
    `, [req.params.id]);
    if (!f) return res.status(404).send('Faktura ikke fundet');
    const linjer = await query(`SELECT * FROM fakturalinjer WHERE faktura_id = $1 ORDER BY id`, [req.params.id]);

    const adr = [f.vejnavn, f.husnr].filter(Boolean).join(' ');
    const linjerHtml = linjer.map(l => `
      <tr>
        <td>${l.beskrivelse}</td>
        <td style="text-align:right">${Number(l.antal).toLocaleString('da-DK', { maximumFractionDigits: 2 })} ${l.enhed || ''}</td>
        <td style="text-align:right">${dkk(l.enhedspris)}</td>
        <td style="text-align:right">${dkk(l.belob_excl)}</td>
      </tr>`).join('');

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html lang="da"><head><meta charset="UTF-8"><title>Faktura ${f.fakturanr}</title>
<style>
  body { font-family: 'Helvetica', Arial, sans-serif; color: #111; padding: 40px; max-width: 800px; margin: auto; }
  h1 { font-size: 28px; margin: 0 0 4px; color: #2563eb; }
  .meta { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin: 30px 0; }
  .box h3 { font-size: 11px; color: #6b7280; text-transform: uppercase; letter-spacing: .5px; margin: 0 0 6px; }
  table { width: 100%; border-collapse: collapse; margin-top: 20px; }
  th, td { padding: 10px 8px; border-bottom: 1px solid #e5e7eb; font-size: 13px; }
  th { background: #f9fafb; text-align: left; font-weight: 600; color: #374151; }
  .totals { margin-top: 16px; margin-left: auto; width: 320px; font-size: 13px; }
  .totals tr td { padding: 6px 8px; border: none; }
  .totals .grand { font-size: 16px; font-weight: 700; border-top: 2px solid #111; }
  .footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid #e5e7eb; font-size: 11px; color: #6b7280; }
  @media print { body { padding: 0; } }
</style></head>
<body>
  <h1>Faktura</h1>
  <div style="color:#6b7280">Fakturanr. ${f.fakturanr || '—'} · ${f.service_type === 'renovation' ? 'Renovation' : 'Spildevand'}</div>
  <div class="meta">
    <div class="box">
      <h3>Til</h3>
      <div><strong>${f.kunde_navn}</strong></div>
      <div>${adr || ''}</div>
      <div>${f.postnr || ''} ${f.by || ''}</div>
      ${f.cvr ? `<div>CVR: ${f.cvr}</div>` : ''}
      ${f.email ? `<div>${f.email}</div>` : ''}
    </div>
    <div class="box">
      <h3>Fra</h3>
      <div><strong>${f.kommune_navn || 'Kommune'}</strong></div>
      ${f.kommune_cvr ? `<div>CVR: ${f.kommune_cvr}</div>` : ''}
      <div style="margin-top:12px"><strong>Fakturadato:</strong> ${f.fakturadato}</div>
      <div><strong>Forfald:</strong> ${f.forfaldsdato}</div>
      <div><strong>Periode:</strong> ${f.periode_fra} – ${f.periode_til}</div>
    </div>
  </div>
  <table>
    <thead><tr><th>Beskrivelse</th><th style="text-align:right">Antal</th><th style="text-align:right">Enhedspris</th><th style="text-align:right">Beløb (excl)</th></tr></thead>
    <tbody>${linjerHtml}</tbody>
  </table>
  <table class="totals">
    <tr><td>Subtotal</td><td style="text-align:right">${dkk(f.belob_excl)} kr.</td></tr>
    <tr><td>Moms (25%)</td><td style="text-align:right">${dkk(f.moms)} kr.</td></tr>
    <tr class="grand"><td>I alt</td><td style="text-align:right">${dkk(f.belob_incl)} kr.</td></tr>
  </table>
  <div class="footer">Genereret af Settl RenSpild · status: ${f.status}</div>
</body></html>`);
  } catch (e) { next(e); }
});

module.exports = router;
