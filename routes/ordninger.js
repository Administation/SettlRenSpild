// UC-49 Sorteringsguide  ·  UC-51 Farligt affald  ·  UC-52 Haveaffald sæson.
// Indholds-leverance til Zerv-portalen + bestillingsflow for særordninger.
const express = require('express');
const router = express.Router();
const { query, one, pool } = require('../db');

// UC-49 Sorteringsguide — søgbart "hvor skal X hen". Statisk indhold + søg.
const GUIDE = [
  { sogeord: ['mælkekarton','juicekarton','karton','mælk','æggebakke'],     fraktion: 'papir',       svar: 'Mælke- og juicekartoner: skyl let, fold sammen, kom i papir/karton.' },
  { sogeord: ['pizzabakke','beskidt karton','mad i karton'],                fraktion: 'rest',        svar: 'Pizzabakker med madrester: i restaffald (ikke karton).' },
  { sogeord: ['pizzakasse rene','rent karton'],                             fraktion: 'papir',       svar: 'Rene pizzakasser uden mad: i papir/karton.' },
  { sogeord: ['glas','syltetøjsglas','vinflaske'],                          fraktion: 'glas',        svar: 'Glasemballage: tøm, men skal ikke skylles. Låg af metal sorteres for sig.' },
  { sogeord: ['drikkedåse','konservesdåse','metaldåse','aluminium'],        fraktion: 'metal',       svar: 'Metalemballage: i metal-fraktionen.' },
  { sogeord: ['plastikflaske','shampoo','plastemballage'],                  fraktion: 'plast',       svar: 'Plast-emballage: tøm, fjern lukkemekanismer hvis muligt.' },
  { sogeord: ['kaffegrums','madrester','frugt','grøntsager','suppe'],       fraktion: 'mad',         svar: 'Madaffald: i biopose. Husk at lukke posen.' },
  { sogeord: ['bleer','kattegrus','støvsugerpose'],                         fraktion: 'rest',        svar: 'Bleer, kattegrus og støvsugerposer: i restaffald.' },
  { sogeord: ['batterier','batteri','aaa','aa'],                            fraktion: 'farligt',     svar: 'Batterier: aldrig i restaffald. Aflever på genbrugsplads eller i pose oven på beholderen.' },
  { sogeord: ['maling','rensemiddel','kemikalier','spraydåse'],             fraktion: 'farligt',     svar: 'Farligt affald: aldrig i alm. beholdere. Aflever på genbrugsplads.' },
  { sogeord: ['lyspære','elspare','led-pære','lysstofrør'],                 fraktion: 'farligt',     svar: 'Lyspærer er farligt affald. Aflever på genbrugsplads.' },
  { sogeord: ['gren','blade','græsafklip','haveaffald'],                    fraktion: 'have',        svar: 'Haveaffald: i havebeholder eller på genbrugsplads.' },
  { sogeord: ['sofa','møbler','seng','reol'],                               fraktion: 'storskrald',  svar: 'Møbler: bestil storskraldsafhentning eller aflever på genbrugsplads.' },
  { sogeord: ['vaskemaskine','køleskab','komfur','hårde hvidevarer'],       fraktion: 'storskrald',  svar: 'Hårde hvidevarer: bestil storskraldsafhentning. Køleskab/fryser tages særligt.' },
  { sogeord: ['elektronik','tv','computer','telefon','printer'],            fraktion: 'farligt',     svar: 'Elektronik er farligt affald. Aflever på genbrugsplads eller i miljøboks.' },
  { sogeord: ['tøj','sko','tekstil'],                                       fraktion: 'tekstil',     svar: 'Brugbart tøj: i tekstilcontainer eller velgørenhed. Slidt tøj: rest.' },
  { sogeord: ['vinduesglas','spejl','keramik'],                             fraktion: 'rest',        svar: 'Vinduesglas, spejl og keramik er IKKE glas-fraktion — det skal i restaffald eller på genbrugsplads.' },
];

router.get('/sortering/sog', (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  if (q.length < 2) return res.json([]);
  const results = GUIDE.filter(g => g.sogeord.some(o => o.includes(q) || q.includes(o.split(' ')[0])));
  res.json(results.slice(0, 10));
});

router.get('/sortering/alle', (req, res) => res.json(GUIDE));

// UC-51 Farligt affald — bestillingsflow med sikkerhedsinstruktion.
const SIKKERHED_FARLIGT = [
  'Aflever altid i den oprindelige emballage hvis muligt.',
  'Bland aldrig forskellige typer farligt affald.',
  'Skriv tydeligt indhold på utætte beholdere.',
  'Læg batterier i en plastpose ovenpå beholderen.',
  'Lyspærer pakkes så de ikke kan gå i stykker.',
];

router.post('/farligt-affald', async (req, res, next) => {
  try {
    const { kunde_id, kontrakt_id, type_beskrivelse, mængde_anslået_kg, ønsket_dato, bruger='Support' } = req.body;
    if (!kunde_id || !type_beskrivelse) return res.status(400).json({ error: 'kunde_id og type_beskrivelse påkrævet' });
    const sagId = 'SAG-' + Math.random().toString(36).slice(2, 8).toUpperCase();
    const sla = ønsket_dato || new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    await pool.query(
      `INSERT INTO sager (id, domain, kategori, prioritet, titel, beskrivelse, kunde_id, kontrakt_id, ansvarlig, sla_frist)
       VALUES ($1,'renovation','farligt_affald','hoej',$2,$3,$4,$5,$6, $7::timestamptz)`,
      [sagId, `Farligt affald: ${type_beskrivelse}`,
       `${type_beskrivelse}\n\nAnslået mængde: ${mængde_anslået_kg || '?'} kg\nØnsket dato: ${sla}\n\nSikkerhedsinstruktioner sendt til kunden.`,
       kunde_id, kontrakt_id || null, bruger, sla]
    );
    res.status(201).json({ ok: true, sag_id: sagId, sikkerhedsinstruktion: SIKKERHED_FARLIGT });
  } catch (e) { next(e); }
});

router.get('/farligt-affald/sikkerhed', (req, res) => res.json(SIKKERHED_FARLIGT));

// UC-52 Haveaffald sæsonabonnement — opret som kontrakt-abonnement.
router.post('/haveaffald/abonnement', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { kunde_id, ejendom_id, saeson_fra, saeson_til, frekvens = '14d', bruger='Support' } = req.body;
    if (!kunde_id || !ejendom_id || !saeson_fra || !saeson_til) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'kunde_id, ejendom_id, saeson_fra og saeson_til påkrævet' });
    }
    // Opret eller find eksisterende kontrakt på ejendommen.
    const koId = 'KO-HAVE-' + Math.random().toString(36).slice(2, 6).toUpperCase();
    await client.query(
      `INSERT INTO kontrakter (id, service_type, kunde_id, ejendom_id, start_dato, status, abonnement_type, saeson_fra, saeson_til, noter)
       VALUES ($1,'renovation',$2,$3,$4,'aktiv','haveaffald_saeson',$4,$5,$6)`,
      [koId, kunde_id, ejendom_id, saeson_fra, saeson_til, `Haveaffaldsabonnement ${saeson_fra} – ${saeson_til}, ${frekvens}`]
    );
    // Tilføj havebeholder.
    const behId = 'BH-HAVE-' + Math.random().toString(36).slice(2, 6).toUpperCase();
    await client.query(
      `INSERT INTO beholdere (id, kontrakt_id, fraktion_id, volumen_l, frekvens, status)
       VALUES ($1,$2,'have',240,$3,'aktiv')`,
      [behId, koId, frekvens]
    );
    await client.query(
      `INSERT INTO audit_log (entitet, entitet_id, handling, bruger, detaljer)
       VALUES ('kontrakt',$1,'haveabonnement_oprettet',$2,$3::jsonb)`,
      [koId, bruger, JSON.stringify({ kunde_id, saeson_fra, saeson_til, frekvens })]
    );
    await client.query('COMMIT');
    res.status(201).json({ ok: true, kontrakt_id: koId, beholder_id: behId });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    next(e);
  } finally { client.release(); }
});

// Liste haveaffald-abonnementer for året.
router.get('/haveaffald/abonnementer', async (req, res, next) => {
  try {
    const aar = parseInt(req.query.aar, 10) || new Date().getFullYear();
    const rows = await query(`
      SELECT k.*, ku.navn AS kunde_navn, e.vejnavn, e.husnr, e.postnr, e.by
      FROM kontrakter k
      JOIN kunder ku ON ku.id = k.kunde_id
      LEFT JOIN ejendomme e ON e.id = k.ejendom_id
      WHERE k.abonnement_type = 'haveaffald_saeson'
        AND EXTRACT(YEAR FROM k.saeson_fra) = $1
      ORDER BY k.saeson_fra
    `, [aar]);
    res.json(rows);
  } catch (e) { next(e); }
});

module.exports = router;
