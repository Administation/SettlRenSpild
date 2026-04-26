// UC-27 Zerv selvbetjenings-API.
// I produktion ville Zerv-portalen kalde disse endpoints på vegne af en logget-ind kunde.
// Auth via Bearer-token (Zerv genererer en kunde-specifik token).
// I v1 er auth simplificeret: bearer-token = kunde_id (ren mock).
const express = require('express');
const router = express.Router();
const { query, one, pool } = require('../db');

// Middleware der ekstraherer kunde_id fra Bearer-token.
function zervAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return res.status(401).json({ error: 'Authorization Bearer-token kræves' });
  // Mock: token er kunde-id direkte. I prod: JWT eller signed token.
  req.kundeId = token;
  next();
}

router.use(zervAuth);

// GET /api/zerv/min-konto — alt en kunde må se om sig selv via portalen.
router.get('/min-konto', async (req, res, next) => {
  try {
    const k = await one(`SELECT id, type, navn, email, telefon, faktura_kanal, pbs_aktiv FROM kunder WHERE id = $1`, [req.kundeId]);
    if (!k) return res.status(404).json({ error: 'Kunde ikke fundet' });
    const kontrakter = await query(`
      SELECT k.id, k.service_type, k.status, k.start_dato,
             e.vejnavn, e.husnr, e.postnr, e.by, ko.navn AS kommune_navn
      FROM kontrakter k
      LEFT JOIN ejendomme e ON e.id = k.ejendom_id
      LEFT JOIN kommuner ko ON ko.id = e.kommune_id
      WHERE k.kunde_id = $1
    `, [req.kundeId]);
    const beholdere = await query(`
      SELECT b.id, b.volumen_l, b.frekvens, b.status, f.navn AS fraktion_navn, f.farve
      FROM beholdere b JOIN kontrakter k ON k.id = b.kontrakt_id
      JOIN fraktioner f ON f.id = b.fraktion_id
      WHERE k.kunde_id = $1
    `, [req.kundeId]);
    const fakturaer = await query(`
      SELECT id, fakturanr, fakturadato, forfaldsdato, belob_incl, betalt_belob, status
      FROM fakturaer WHERE kunde_id = $1 ORDER BY fakturadato DESC LIMIT 20
    `, [req.kundeId]);
    res.json({ kunde: k, kontrakter, beholdere, fakturaer });
  } catch (e) { next(e); }
});

// GET /api/zerv/kalender — kommende tømninger for kunden.
router.get('/kalender', async (req, res, next) => {
  try {
    const tomninger = await query(`
      SELECT p.planlagt_dato, b.volumen_l, b.frekvens, f.navn AS fraktion_navn, f.farve
      FROM tomningsplaner p
      JOIN beholdere b ON b.id = p.beholder_id
      JOIN fraktioner f ON f.id = b.fraktion_id
      JOIN kontrakter k ON k.id = b.kontrakt_id
      WHERE k.kunde_id = $1
        AND p.planlagt_dato >= CURRENT_DATE
        AND p.status = 'planlagt'
      ORDER BY p.planlagt_dato LIMIT 50
    `, [req.kundeId]);
    res.json(tomninger);
  } catch (e) { next(e); }
});

// POST /api/zerv/reklamation — kunden indberetter en reklamation selv.
router.post('/reklamation', async (req, res, next) => {
  try {
    const { kategori = 'manglende_tomning', titel, beskrivelse } = req.body;
    if (!titel) return res.status(400).json({ error: 'titel påkrævet' });
    const sagId = 'SAG-' + Math.random().toString(36).slice(2, 8).toUpperCase();
    await pool.query(
      `INSERT INTO sager (id, domain, kategori, prioritet, titel, beskrivelse, kunde_id, ansvarlig, sla_frist)
       VALUES ($1,'renovation',$2,'normal',$3,$4,$5,'Zerv', now() + interval '5 days')`,
      [sagId, kategori, titel, beskrivelse || '(indberettet via Zerv)', req.kundeId]
    );
    await pool.query(
      `INSERT INTO sag_aktiviteter (sag_id, type, tekst, bruger)
       VALUES ($1,'oprettet','Reklamation indberettet via selvbetjening','Zerv')`,
      [sagId]
    );
    res.status(201).json({ ok: true, sag_id: sagId });
  } catch (e) { next(e); }
});

// POST /api/zerv/ekstra-tomning — kunden bestiller selv.
router.post('/ekstra-tomning', async (req, res, next) => {
  try {
    const { beholder_id, dato, begrundelse = 'Bestilt via Zerv' } = req.body;
    // Verificér at beholderen tilhører denne kunde.
    const ok = await one(`
      SELECT 1 FROM beholdere b JOIN kontrakter k ON k.id = b.kontrakt_id
      WHERE b.id = $1 AND k.kunde_id = $2
    `, [beholder_id, req.kundeId]);
    if (!ok) return res.status(403).json({ error: 'Beholder tilhører ikke denne kunde' });

    // Genbrug ekstra-tomning logik.
    const fetch = require('http');
    const beh = await one(`
      SELECT b.*, k.id AS kontrakt_id, k.kunde_id, k.ejendom_id, ku.navn AS kunde_navn, f.navn AS fraktion_navn
      FROM beholdere b JOIN kontrakter k ON k.id = b.kontrakt_id
      JOIN kunder ku ON ku.id = k.kunde_id
      JOIN fraktioner f ON f.id = b.fraktion_id
      WHERE b.id = $1
    `, [beholder_id]);
    const planRes = await pool.query(
      `INSERT INTO tomningsplaner (beholder_id, planlagt_dato, status, rute) VALUES ($1,$2,'planlagt','ekstra') RETURNING id`,
      [beholder_id, dato]
    );
    const sagId = 'SAG-' + Math.random().toString(36).slice(2, 8).toUpperCase();
    await pool.query(
      `INSERT INTO sager (id, domain, kategori, prioritet, titel, beskrivelse, kunde_id, ejendom_id, kontrakt_id, ansvarlig, sla_frist)
       VALUES ($1,'renovation','ekstra_tomning','normal',$2,$3,$4,$5,$6,'Zerv', now() + interval '3 days')`,
      [sagId, `Ekstra tømning ${beh.fraktion_navn} ${beh.volumen_l}L (Zerv)`,
       begrundelse, beh.kunde_id, beh.ejendom_id, beh.kontrakt_id]
    );
    res.status(201).json({ ok: true, sag_id: sagId, plan_id: planRes.rows[0].id });
  } catch (e) { next(e); }
});

// POST /api/zerv/storskrald — kunden booker selv.
router.post('/storskrald', async (req, res, next) => {
  try {
    const { type, maengde_m3, beskrivelse, tidsvindue_fra } = req.body;
    if (!type || !tidsvindue_fra) return res.status(400).json({ error: 'type og tidsvindue_fra påkrævet' });
    const sagId = 'SAG-' + Math.random().toString(36).slice(2, 8).toUpperCase();
    await pool.query(
      `INSERT INTO sager (id, domain, kategori, prioritet, titel, beskrivelse, kunde_id, ansvarlig, sla_frist)
       VALUES ($1,'renovation','storskrald','normal',$2,$3,$4,'Zerv', $5)`,
      [sagId, `Storskrald: ${type} (Zerv)`,
       `Tidsvindue: ${tidsvindue_fra}\nMængde: ${maengde_m3 || '?'} m³\n${beskrivelse || ''}`,
       req.kundeId, tidsvindue_fra]
    );
    res.status(201).json({ ok: true, sag_id: sagId });
  } catch (e) { next(e); }
});

// GET /api/zerv/kalender.ics — kunden henter sin kalender.
router.get('/kalender.ics', (req, res) => {
  res.redirect(`/api/kunder/${req.kundeId}/kalender.ics`);
});

module.exports = router;
