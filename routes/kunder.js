const express = require('express');
const router = express.Router();
const { query, one, pool } = require('../db');
const { parsePaging, paginatedQuery } = require('../lib/pagination');

function genKundeId() {
  return 'KU-' + Math.random().toString(36).slice(2, 8).toUpperCase();
}

router.get('/', async (req, res, next) => {
  try {
    const { q, status, type } = req.query;
    const { limit, offset } = parsePaging(req.query, { limit: 50 });
    const where = [];
    const params = [];

    if (q) {
      // Trigram-søgning på navn/email + præfiks-match på id/cvr/cpr.
      // pg_trgm gør %foo%-søgning hurtig på store tabeller.
      params.push(q);
      params.push(`${q.toLowerCase()}%`);
      where.push(`(
        navn  ILIKE '%' || $${params.length - 1} || '%'
        OR email ILIKE '%' || $${params.length - 1} || '%'
        OR LOWER(id)  LIKE $${params.length}
        OR cvr LIKE $${params.length}
        OR cpr LIKE $${params.length}
      )`);
    }
    if (status) { params.push(status); where.push(`status = $${params.length}`); }
    if (type)   { params.push(type);   where.push(`type   = $${params.length}`); }

    const result = await paginatedQuery(pool, {
      selectSql: '*',
      fromSql: 'kunder',
      whereSql: where.join(' AND '),
      params,
      orderBy: q ? `similarity(navn, $1) DESC, oprettet DESC` : 'oprettet DESC',
      limit,
      offset,
    });
    res.json(result);
  } catch (e) { next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const k = await one(`SELECT * FROM kunder WHERE id = $1`, [req.params.id]);
    if (!k) return res.status(404).json({ error: 'Kunde ikke fundet' });
    const kontrakter = await query(`
      SELECT k.*, e.vejnavn, e.husnr, e.postnr, e.by
      FROM kontrakter k
      LEFT JOIN ejendomme e ON e.id = k.ejendom_id
      WHERE k.kunde_id = $1
      ORDER BY k.oprettet DESC
    `, [req.params.id]);
    const fakturaer = await query(`SELECT * FROM fakturaer WHERE kunde_id = $1 ORDER BY fakturadato DESC LIMIT 20`, [req.params.id]);
    const sager = await query(`SELECT * FROM sager WHERE kunde_id = $1 ORDER BY oprettet DESC LIMIT 20`, [req.params.id]);
    res.json({ ...k, kontrakter, fakturaer, sager });
  } catch (e) { next(e); }
});

// Kunde 360 — alt en supporter har brug for når kunden ringer ind.
// Optimeret til ét HTTP-kald: stamdata, kontrakter, beholdere, seneste tømninger,
// næste planlagte tømninger, fakturaer, betalinger, sager, og aggregerede alerts.
router.get('/:id/360', async (req, res, next) => {
  try {
    const id = req.params.id;
    const k = await one(`SELECT * FROM kunder WHERE id = $1`, [id]);
    if (!k) return res.status(404).json({ error: 'Kunde ikke fundet' });

    const [kontrakter, beholdere, tomningerHist, tomningerPlan, fakturaer, betalinger, sager, aktivitetSager] = await Promise.all([
      query(`
        SELECT k.*, e.vejnavn, e.husnr, e.etage, e.doer, e.postnr, e.by, e.kommune_id, e.ejendomstype, e.bbr_id,
               ko.navn AS kommune_navn
        FROM kontrakter k
        LEFT JOIN ejendomme e ON e.id = k.ejendom_id
        LEFT JOIN kommuner ko ON ko.id = e.kommune_id
        WHERE k.kunde_id = $1
        ORDER BY k.status='aktiv' DESC, k.oprettet DESC
      `, [id]),
      query(`
        SELECT b.*, f.navn AS fraktion_navn, f.farve, k.id AS kontrakt_id
        FROM beholdere b
        JOIN fraktioner f ON f.id = b.fraktion_id
        JOIN kontrakter k ON k.id = b.kontrakt_id
        WHERE k.kunde_id = $1
        ORDER BY f.navn, b.volumen_l
      `, [id]),
      query(`
        SELECT t.*, b.fraktion_id, b.volumen_l, b.frekvens, b.kontrakt_id, f.navn AS fraktion_navn, f.farve,
               e.vejnavn, e.husnr, e.postnr, e.by
        FROM tomninger t
        JOIN beholdere b ON b.id = t.beholder_id
        JOIN fraktioner f ON f.id = b.fraktion_id
        JOIN kontrakter k ON k.id = b.kontrakt_id
        LEFT JOIN ejendomme e ON e.id = k.ejendom_id
        WHERE k.kunde_id = $1
        ORDER BY t.tomning_dato DESC, t.oprettet DESC
        LIMIT 30
      `, [id]),
      query(`
        SELECT p.*, b.fraktion_id, b.volumen_l, b.frekvens, b.kontrakt_id, f.navn AS fraktion_navn, f.farve
        FROM tomningsplaner p
        JOIN beholdere b ON b.id = p.beholder_id
        JOIN fraktioner f ON f.id = b.fraktion_id
        JOIN kontrakter k ON k.id = b.kontrakt_id
        WHERE k.kunde_id = $1
          AND p.status = 'planlagt'
          AND p.planlagt_dato >= CURRENT_DATE
        ORDER BY p.planlagt_dato
        LIMIT 20
      `, [id]),
      query(`
        SELECT f.*, ko.navn AS kommune_navn,
               (f.belob_incl - f.betalt_belob)::numeric AS resterer
        FROM fakturaer f
        LEFT JOIN kommuner ko ON ko.id = f.kommune_id
        WHERE f.kunde_id = $1
        ORDER BY f.fakturadato DESC LIMIT 30
      `, [id]),
      query(`
        SELECT b.*, f.fakturanr
        FROM betalinger b
        JOIN fakturaer f ON f.id = b.faktura_id
        WHERE f.kunde_id = $1
        ORDER BY b.betalingsdato DESC LIMIT 30
      `, [id]),
      query(`
        SELECT s.*,
          CASE
            WHEN s.status = 'lukket' THEN 'closed'
            WHEN s.sla_frist IS NULL THEN 'none'
            WHEN s.sla_frist < now() THEN 'overdue'
            WHEN s.sla_frist < now() + interval '24 hours' THEN 'soon'
            ELSE 'ok'
          END AS sla_status
        FROM sager s
        WHERE s.kunde_id = $1
        ORDER BY (s.status = 'lukket'), s.oprettet DESC LIMIT 30
      `, [id]),
      query(`
        SELECT a.*, s.titel AS sag_titel
        FROM sag_aktiviteter a
        JOIN sager s ON s.id = a.sag_id
        WHERE s.kunde_id = $1
        ORDER BY a.oprettet DESC LIMIT 50
      `, [id]),
    ]);

    // ── Alerts: aggregér risici og åbne ting til topbar-bjælker ──
    const aabneSager = sager.filter(s => s.status !== 'lukket').length;
    const akutSager = sager.filter(s => s.status !== 'lukket' && s.prioritet === 'akut').length;
    const slaOverdue = sager.filter(s => s.sla_status === 'overdue').length;
    const restance = fakturaer
      .filter(f => ['sendt','forfalden','rykker','inddrivelse'].includes(f.status) && new Date(f.forfaldsdato) < new Date())
      .reduce((s, f) => s + Number(f.resterer), 0);
    const restanceCount = fakturaer.filter(f => ['sendt','forfalden','rykker','inddrivelse'].includes(f.status) && new Date(f.forfaldsdato) < new Date()).length;
    const ufaktureredeTomninger = tomningerHist.filter(t => !t.faktureret).length;
    const undtagelser = tomningerHist.filter(t => t.undtagelseskode && t.undtagelseskode !== 'overfyldt').slice(0, 5);

    // ── Sidste/næste tømning pr. beholder ──
    const beholderStatus = beholdere.map(b => {
      const sidste = tomningerHist.find(t => t.beholder_id === b.id);
      const naeste = tomningerPlan.find(p => p.beholder_id === b.id);
      return {
        ...b,
        sidste_tomning: sidste ? {
          dato: sidste.tomning_dato,
          vaegt_kg: sidste.vaegt_kg,
          undtagelseskode: sidste.undtagelseskode,
        } : null,
        naeste_planlagt: naeste ? naeste.planlagt_dato : null,
      };
    });

    // ── Kombineret aktivitets-tidslinje ──
    const aktivitet = [
      ...aktivitetSager.map(a => ({ tid: a.oprettet, type: 'sag', tekst: `${a.type}: ${a.tekst || a.sag_titel}`, ref: a.sag_id, bruger: a.bruger })),
      ...tomningerHist.slice(0, 10).map(t => ({
        tid: t.tomning_dato,
        type: 'tomning',
        tekst: `Tømning ${t.fraktion_navn} ${t.volumen_l}L${t.undtagelseskode ? ' — ' + t.undtagelseskode : ''}${t.vaegt_kg ? ' · ' + Number(t.vaegt_kg).toFixed(1) + ' kg' : ''}`,
        ref: t.id,
      })),
      ...fakturaer.slice(0, 10).map(f => ({
        tid: f.fakturadato, type: 'faktura',
        tekst: `Faktura ${f.fakturanr} oprettet (${Number(f.belob_incl).toFixed(2)} kr.) · ${f.status}`,
        ref: f.id,
      })),
      ...betalinger.slice(0, 10).map(b => ({
        tid: b.betalingsdato, type: 'betaling',
        tekst: `Indbetaling ${Number(b.belob).toFixed(2)} kr. via ${b.metode || 'ukendt'} → faktura ${b.fakturanr}`,
        ref: b.faktura_id,
      })),
    ].sort((a, b) => new Date(b.tid) - new Date(a.tid)).slice(0, 40);

    res.json({
      kunde: k,
      kontrakter,
      beholdere: beholderStatus,
      tomninger: { historik: tomningerHist, planlagt: tomningerPlan },
      fakturaer,
      betalinger,
      sager,
      aktivitet,
      alerts: {
        aabne_sager: aabneSager,
        akut_sager: akutSager,
        sla_overdue: slaOverdue,
        restance_belob: restance,
        restance_count: restanceCount,
        ufakturerede_tomninger: ufaktureredeTomninger,
        seneste_undtagelser: undtagelser,
      },
    });
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const id = req.body.id || genKundeId();
    const { type='privat', navn, cpr, cvr, ean, email, telefon, faktura_kanal='eboks', pbs_aktiv=false, pbs_pbsnr, pbs_debgr, status='aktiv' } = req.body;
    if (!navn) return res.status(400).json({ error: 'navn påkrævet' });
    await pool.query(
      `INSERT INTO kunder (id, type, navn, cpr, cvr, ean, email, telefon, faktura_kanal, pbs_aktiv, pbs_pbsnr, pbs_debgr, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [id, type, navn, cpr, cvr, ean, email, telefon, faktura_kanal, pbs_aktiv, pbs_pbsnr, pbs_debgr, status]
    );
    res.status(201).json(await one(`SELECT * FROM kunder WHERE id = $1`, [id]));
  } catch (e) { next(e); }
});

router.put('/:id', async (req, res, next) => {
  try {
    const fields = ['type','navn','cpr','cvr','ean','email','telefon','faktura_kanal','pbs_aktiv','pbs_pbsnr','pbs_debgr','status'];
    const sets = [];
    const params = [];
    for (const f of fields) {
      if (f in req.body) { params.push(req.body[f]); sets.push(`${f} = $${params.length}`); }
    }
    if (!sets.length) return res.json(await one(`SELECT * FROM kunder WHERE id = $1`, [req.params.id]));
    params.push(req.params.id);
    await pool.query(`UPDATE kunder SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    res.json(await one(`SELECT * FROM kunder WHERE id = $1`, [req.params.id]));
  } catch (e) { next(e); }
});

module.exports = router;
