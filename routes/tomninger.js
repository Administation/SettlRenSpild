const express = require('express');
const router = express.Router();
const { query, one, pool } = require('../db');

function genTomningId() {
  return 'TM-' + Math.random().toString(36).slice(2, 8).toUpperCase();
}

router.get('/', async (req, res, next) => {
  try {
    const { beholder_id, kontrakt_id, fra, til, faktureret } = req.query;
    const where = [];
    const params = [];
    if (beholder_id) { params.push(beholder_id); where.push(`t.beholder_id = $${params.length}`); }
    if (kontrakt_id) { params.push(kontrakt_id); where.push(`b.kontrakt_id = $${params.length}`); }
    if (fra)         { params.push(fra);         where.push(`t.tomning_dato >= $${params.length}`); }
    if (til)         { params.push(til);         where.push(`t.tomning_dato <= $${params.length}`); }
    if (faktureret !== undefined) {
      params.push(faktureret === 'true');
      where.push(`t.faktureret = $${params.length}`);
    }
    const sql = `
      SELECT t.*, b.fraktion_id, b.volumen_l, b.frekvens, b.kontrakt_id,
             f.navn AS fraktion_navn, f.farve,
             ku.navn AS kunde_navn
      FROM tomninger t
      JOIN beholdere b ON b.id = t.beholder_id
      JOIN fraktioner f ON f.id = b.fraktion_id
      JOIN kontrakter ko ON ko.id = b.kontrakt_id
      JOIN kunder ku ON ku.id = ko.kunde_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY t.tomning_dato DESC LIMIT 200
    `;
    res.json(await query(sql, params));
  } catch (e) { next(e); }
});

// Manuel registrering eller webhook fra driftssystem.
router.post('/', async (req, res, next) => {
  try {
    const id = req.body.id || genTomningId();
    const {
      beholder_id, plan_id, tomning_dato, tomning_tid, vaegt_kg, vaegt_estimeret,
      undtagelseskode, chauffoer, rute, gps_lat, gps_lon, foto_url, kilde='manuel'
    } = req.body;
    if (!beholder_id || !tomning_dato) return res.status(400).json({ error: 'beholder_id og tomning_dato påkrævet' });

    // Hvis vægt ikke oplyst — estimér via fraktion-densitet × volumen.
    let vaegt = vaegt_kg;
    let estimeret = vaegt_estimeret;
    if (vaegt == null) {
      const r = await one(`
        SELECT b.volumen_l, f.default_densitet FROM beholdere b
        JOIN fraktioner f ON f.id = b.fraktion_id WHERE b.id = $1
      `, [beholder_id]);
      if (r) {
        vaegt = (Number(r.volumen_l) * Number(r.default_densitet || 0.1)).toFixed(2);
        estimeret = true;
      }
    }
    await pool.query(
      `INSERT INTO tomninger (id, beholder_id, plan_id, tomning_dato, tomning_tid, vaegt_kg, vaegt_estimeret,
         undtagelseskode, chauffoer, rute, gps_lat, gps_lon, foto_url, kilde)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [id, beholder_id, plan_id, tomning_dato, tomning_tid, vaegt, estimeret ?? true,
       undtagelseskode, chauffoer, rute, gps_lat, gps_lon, foto_url, kilde]
    );
    if (plan_id) await pool.query(`UPDATE tomningsplaner SET status = 'gennemfoert' WHERE id = $1`, [plan_id]);
    res.status(201).json(await one(`SELECT * FROM tomninger WHERE id = $1`, [id]));
  } catch (e) { next(e); }
});

// Bestil ekstra tømning — opretter en planlagt tømning + sag, så support kan
// følge op og faktureringen får en linje på næste afregning.
router.post('/ekstra', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { beholder_id, dato, begrundelse, bruger='Support' } = req.body;
    if (!beholder_id || !dato) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'beholder_id og dato påkrævet' });
    }
    const beh = (await client.query(`
      SELECT b.*, k.id AS kontrakt_id, k.kunde_id, k.ejendom_id,
             ku.navn AS kunde_navn, f.navn AS fraktion_navn
      FROM beholdere b
      JOIN kontrakter k ON k.id = b.kontrakt_id
      JOIN kunder ku ON ku.id = k.kunde_id
      JOIN fraktioner f ON f.id = b.fraktion_id
      WHERE b.id = $1
    `, [beholder_id])).rows[0];
    if (!beh) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Beholder ikke fundet' }); }

    // 1) Læg en tømningsplan-entry så ruten ved den skal komme.
    const planRes = await client.query(
      `INSERT INTO tomningsplaner (beholder_id, planlagt_dato, status, rute)
       VALUES ($1,$2,'planlagt','ekstra') RETURNING id`,
      [beholder_id, dato]
    );

    // 2) Opret en sag så aktiviteten er sporbar og support kan følge op.
    const sagId = 'SAG-' + Math.random().toString(36).slice(2, 8).toUpperCase();
    await client.query(
      `INSERT INTO sager (id, domain, kategori, prioritet, titel, beskrivelse, kunde_id, ejendom_id, kontrakt_id, ansvarlig, sla_frist)
       VALUES ($1,'renovation','ekstra_tomning','normal',$2,$3,$4,$5,$6,$7, now() + interval '3 days')`,
      [sagId,
       `Ekstra tømning ${beh.fraktion_navn} ${beh.volumen_l}L`,
       begrundelse || 'Bestilt af kunde',
       beh.kunde_id, beh.ejendom_id, beh.kontrakt_id, bruger]
    );
    await client.query(
      `INSERT INTO sag_aktiviteter (sag_id, type, tekst, bruger)
       VALUES ($1,'oprettet',$2,$3)`,
      [sagId, `Ekstra tømning planlagt til ${dato} på beholder ${beholder_id}. Pris faktureres på næste afregning.`, bruger]
    );

    await client.query('COMMIT');
    res.status(201).json({
      ok: true,
      sag_id: sagId,
      plan_id: planRes.rows[0].id,
      beholder: { id: beholder_id, fraktion: beh.fraktion_navn, volumen: beh.volumen_l },
      planlagt_dato: dato,
    });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    next(e);
  } finally {
    client.release();
  }
});

// Generér tømningsplan for de næste N uger ud fra beholder-frekvens.
router.post('/generer-plan', async (req, res, next) => {
  try {
    const { uger = 12 } = req.body || {};
    const beholdere = await query(`SELECT id, frekvens FROM beholdere WHERE status = 'aktiv'`);
    let oprettet = 0;
    const today = new Date();
    for (const b of beholdere) {
      let dage;
      if (b.frekvens === '7d') dage = 7;
      else if (b.frekvens === '14d') dage = 14;
      else if (b.frekvens === '28d') dage = 28;
      else continue;
      for (let d = dage; d <= uger * 7; d += dage) {
        const dt = new Date(today.getTime() + d * 86400000).toISOString().slice(0, 10);
        const r = await pool.query(
          `INSERT INTO tomningsplaner (beholder_id, planlagt_dato) VALUES ($1,$2)
           ON CONFLICT DO NOTHING`,
          [b.id, dt]
        );
        if (r.rowCount) oprettet++;
      }
    }
    res.json({ oprettet });
  } catch (e) { next(e); }
});

router.get('/plan', async (req, res, next) => {
  try {
    const { fra, til } = req.query;
    const where = [];
    const params = [];
    if (fra) { params.push(fra); where.push(`p.planlagt_dato >= $${params.length}`); }
    if (til) { params.push(til); where.push(`p.planlagt_dato <= $${params.length}`); }
    const sql = `
      SELECT p.*, b.kontrakt_id, b.volumen_l, b.frekvens, f.navn AS fraktion_navn, f.farve,
             e.vejnavn, e.husnr, e.postnr, e.by, ku.navn AS kunde_navn
      FROM tomningsplaner p
      JOIN beholdere b ON b.id = p.beholder_id
      JOIN fraktioner f ON f.id = b.fraktion_id
      JOIN kontrakter k ON k.id = b.kontrakt_id
      JOIN kunder ku ON ku.id = k.kunde_id
      LEFT JOIN ejendomme e ON e.id = k.ejendom_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY p.planlagt_dato LIMIT 500
    `;
    res.json(await query(sql, params));
  } catch (e) { next(e); }
});

module.exports = router;
