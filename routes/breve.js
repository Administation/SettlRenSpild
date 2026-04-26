// UC-63 Standardbreve & skabeloner — flettet med kundedata.
const express = require('express');
const router = express.Router();
const { query, one, pool } = require('../db');

// Default-skabeloner som seedes ved init hvis tomt.
const DEFAULTS = [
  { id: 'rykker_1', kategori: 'rykker', navn: 'Rykker 1 (betalingspåmindelse)',
    emne: 'Påmindelse om manglende betaling — faktura {{fakturanr}}',
    body: 'Kære {{kunde_navn}}\n\nVi kan se at faktura {{fakturanr}} på {{belob}} kr. med forfaldsdato {{forfaldsdato}} endnu ikke er betalt.\n\nBeløbet bedes betalt hurtigst muligt. Hvis du allerede har betalt, kan du se bort fra denne påmindelse.\n\nVenlig hilsen\nSettl RenSpild' },
  { id: 'rykker_2', kategori: 'rykker', navn: 'Rykker 2 (med gebyr)',
    emne: 'Sidste rykker — faktura {{fakturanr}}',
    body: 'Kære {{kunde_navn}}\n\nFaktura {{fakturanr}} på {{belob}} kr. er stadig ikke betalt.\n\nDer pålægges hermed et rykkergebyr på 100,00 kr. jf. renteloven.\n\nHvis betaling ikke er modtaget inden 14 dage, overgives sagen til SKAT Inddrivelse.\n\nVenlig hilsen\nSettl RenSpild' },
  { id: 'velkomst', kategori: 'velkomst', navn: 'Velkomstbrev til ny kunde',
    emne: 'Velkommen til renovationsordningen',
    body: 'Kære {{kunde_navn}}\n\nVelkommen som kunde hos os.\n\nDu er nu tilmeldt renovationsordningen på adressen {{adresse}}.\n\nDin afhentningskalender finder du på Min Side, eller du kan abonnere på den i din digitale kalender.\n\nVenlig hilsen\nSettl RenSpild' },
  { id: 'fakturatvist_godkendt', kategori: 'godkendelse', navn: 'Tvist godkendt — kreditnota udstedt',
    emne: 'Vi har behandlet din henvendelse',
    body: 'Kære {{kunde_navn}}\n\nVi har behandlet din henvendelse vedr. faktura {{fakturanr}} og er enige i din indsigelse.\n\nDer er udstedt en kreditnota på {{belob}} kr., som modregnes på din næste faktura.\n\nVenlig hilsen\nSettl RenSpild' },
  { id: 'fakturatvist_afslag', kategori: 'afslag', navn: 'Tvist afvist',
    emne: 'Behandling af din henvendelse',
    body: 'Kære {{kunde_navn}}\n\nVi har gennemgået din henvendelse vedr. faktura {{fakturanr}}, men kan ikke imødekomme indsigelsen.\n\nFakturaen står ved magt og bedes betalt inden forfald.\n\nDu kan klage til kommunens klagemyndighed hvis du fortsat er uenig.\n\nVenlig hilsen\nSettl RenSpild' },
  { id: 'prisvarsling', kategori: 'varsling', navn: 'Lovpligtig varsling om prisændring',
    emne: 'Varsling om ny renovationstakst pr. {{ikrafttraedelse}}',
    body: 'Kære {{kunde_navn}}\n\nKommunalbestyrelsen har vedtaget nye renovationstakster gældende fra {{ikrafttraedelse}}.\n\nFor din nuværende beholderkomposition betyder det en ny årsudgift på {{ny_pris}} kr.\n\nDu modtager dette brev senest 30 dage før ikrafttrædelsen jf. lovkrav.\n\nVenlig hilsen\nSettl RenSpild' },
];

async function seedSkabeloner() {
  for (const d of DEFAULTS) {
    await pool.query(
      `INSERT INTO brev_skabeloner (id, navn, emne, body, kategori) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO NOTHING`,
      [d.id, d.navn, d.emne, d.body, d.kategori]
    );
  }
}

router.get('/skabeloner', async (req, res, next) => {
  try {
    await seedSkabeloner();
    res.json(await query(`SELECT * FROM brev_skabeloner ORDER BY kategori, navn`));
  } catch (e) { next(e); }
});

router.post('/skabeloner', async (req, res, next) => {
  try {
    const { id, navn, emne, body, kategori } = req.body;
    if (!id || !navn || !emne || !body) return res.status(400).json({ error: 'id, navn, emne, body påkrævet' });
    await pool.query(
      `INSERT INTO brev_skabeloner (id, navn, emne, body, kategori) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO UPDATE SET navn = EXCLUDED.navn, emne = EXCLUDED.emne, body = EXCLUDED.body, kategori = EXCLUDED.kategori`,
      [id, navn, emne, body, kategori || null]
    );
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Flet skabelon med kunde-/faktura-data.
function flet(text, vars) {
  if (!text) return '';
  return text.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] != null ? String(vars[key]) : `{{${key}}}`);
}

async function buildVars(kunde_id, faktura_id) {
  const k = await one(`SELECT * FROM kunder WHERE id = $1`, [kunde_id]);
  const vars = {
    kunde_navn: k?.navn || '',
    cvr: k?.cvr || '',
    email: k?.email || '',
  };
  if (faktura_id) {
    const f = await one(`
      SELECT f.*, e.vejnavn, e.husnr, e.postnr, e.by FROM fakturaer f
      LEFT JOIN ejendomme e ON e.id = f.ejendom_id
      WHERE f.id = $1
    `, [faktura_id]);
    if (f) {
      vars.fakturanr = f.fakturanr;
      vars.belob = Number(f.belob_incl).toFixed(2);
      vars.forfaldsdato = (f.forfaldsdato instanceof Date ? f.forfaldsdato.toISOString().slice(0,10) : f.forfaldsdato);
      vars.adresse = `${f.vejnavn || ''} ${f.husnr || ''}, ${f.postnr || ''} ${f.by || ''}`.trim();
    }
  }
  return vars;
}

// Preview en skabelon med flettet data.
router.post('/preview', async (req, res, next) => {
  try {
    const { skabelon_id, kunde_id, faktura_id, ekstra_vars = {} } = req.body;
    const sk = await one(`SELECT * FROM brev_skabeloner WHERE id = $1`, [skabelon_id]);
    if (!sk) return res.status(404).json({ error: 'Skabelon ikke fundet' });
    const vars = { ...await buildVars(kunde_id, faktura_id), ...ekstra_vars };
    res.json({ emne: flet(sk.emne, vars), body: flet(sk.body, vars), vars });
  } catch (e) { next(e); }
});

// Send (mock) — gemmer i sendte_breve med flettet indhold.
router.post('/send', async (req, res, next) => {
  try {
    const { skabelon_id, kunde_id, faktura_id, sag_id, kanal = 'eboks', ekstra_vars = {}, bruger = 'Support' } = req.body;
    const sk = await one(`SELECT * FROM brev_skabeloner WHERE id = $1`, [skabelon_id]);
    if (!sk) return res.status(404).json({ error: 'Skabelon ikke fundet' });
    const vars = { ...await buildVars(kunde_id, faktura_id), ...ekstra_vars };
    const emne = flet(sk.emne, vars);
    const body = flet(sk.body, vars);
    const r = await pool.query(
      `INSERT INTO sendte_breve (skabelon_id, kunde_id, sag_id, emne, body, kanal, bruger)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [skabelon_id, kunde_id, sag_id || null, emne, body, kanal, bruger]
    );
    await pool.query(
      `INSERT INTO audit_log (entitet, entitet_id, handling, bruger, detaljer)
       VALUES ('brev',$1,'sendt',$2,$3::jsonb)`,
      [String(r.rows[0].id), bruger, JSON.stringify({ skabelon_id, kunde_id, kanal })]
    );
    res.status(201).json({ ok: true, id: r.rows[0].id, mock: { kanal, status: 'leveret', tidspunkt: new Date().toISOString() } });
  } catch (e) { next(e); }
});

router.get('/sendte', async (req, res, next) => {
  try {
    const { kunde_id } = req.query;
    const where = []; const params = [];
    if (kunde_id) { params.push(kunde_id); where.push(`b.kunde_id = $${params.length}`); }
    res.json(await query(`
      SELECT b.*, s.navn AS skabelon_navn, k.navn AS kunde_navn FROM sendte_breve b
      LEFT JOIN brev_skabeloner s ON s.id = b.skabelon_id
      LEFT JOIN kunder k ON k.id = b.kunde_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY b.sendt DESC LIMIT 100
    `, params));
  } catch (e) { next(e); }
});

module.exports = router;
