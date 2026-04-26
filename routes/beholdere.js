const express = require('express');
const router = express.Router();
const { query, one, pool } = require('../db');

function genBeholderId() {
  return 'BH-' + Math.random().toString(36).slice(2, 8).toUpperCase();
}

router.get('/', async (req, res, next) => {
  try {
    const { kontrakt_id, fraktion_id, status } = req.query;
    const where = [];
    const params = [];
    if (kontrakt_id) { params.push(kontrakt_id); where.push(`b.kontrakt_id = $${params.length}`); }
    if (fraktion_id) { params.push(fraktion_id); where.push(`b.fraktion_id = $${params.length}`); }
    if (status)      { params.push(status);      where.push(`b.status      = $${params.length}`); }
    const sql = `
      SELECT b.*, f.navn AS fraktion_navn, f.farve, ku.navn AS kunde_navn,
             e.vejnavn, e.husnr, e.postnr, e.by
      FROM beholdere b
      JOIN fraktioner f ON f.id = b.fraktion_id
      JOIN kontrakter k ON k.id = b.kontrakt_id
      JOIN kunder ku ON ku.id = k.kunde_id
      LEFT JOIN ejendomme e ON e.id = k.ejendom_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY b.oprettet DESC LIMIT 300
    `;
    res.json(await query(sql, params));
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const id = req.body.id || genBeholderId();
    const { kontrakt_id, fraktion_id, volumen_l, frekvens, rfid, status='aktiv', placering, faelles=false, fordelingsnoegle } = req.body;
    if (!kontrakt_id || !fraktion_id || !volumen_l || !frekvens) {
      return res.status(400).json({ error: 'kontrakt_id, fraktion_id, volumen_l og frekvens påkrævet' });
    }
    await pool.query(
      `INSERT INTO beholdere (id, kontrakt_id, fraktion_id, volumen_l, frekvens, rfid, status, placering, faelles, fordelingsnoegle)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, kontrakt_id, fraktion_id, volumen_l, frekvens, rfid, status, placering, faelles, fordelingsnoegle]
    );
    res.status(201).json(await one(`SELECT * FROM beholdere WHERE id = $1`, [id]));
  } catch (e) { next(e); }
});

router.put('/:id', async (req, res, next) => {
  try {
    const fields = ['fraktion_id','volumen_l','frekvens','rfid','status','placering','faelles','fordelingsnoegle'];
    const sets = [];
    const params = [];
    for (const f of fields) {
      if (f in req.body) { params.push(req.body[f]); sets.push(`${f} = $${params.length}`); }
    }
    if (!sets.length) return res.json(await one(`SELECT * FROM beholdere WHERE id = $1`, [req.params.id]));
    params.push(req.params.id);
    await pool.query(`UPDATE beholdere SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    res.json(await one(`SELECT * FROM beholdere WHERE id = $1`, [req.params.id]));
  } catch (e) { next(e); }
});

// UC-13 Beholderbytte — afhent gammel + lever ny. Opretter sag og opdaterer registret.
router.post('/:id/bytte', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { ny_volumen_l, ny_fraktion_id, ny_frekvens, aarsag, bruger='Support' } = req.body;
    const beh = (await client.query(`
      SELECT b.*, k.kunde_id, k.ejendom_id, ku.navn AS kunde_navn, f.navn AS fraktion_navn
      FROM beholdere b
      JOIN kontrakter k ON k.id = b.kontrakt_id
      JOIN kunder ku ON ku.id = k.kunde_id
      JOIN fraktioner f ON f.id = b.fraktion_id
      WHERE b.id = $1
    `, [req.params.id])).rows[0];
    if (!beh) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Beholder ikke fundet' }); }

    // Opdatér beholderen direkte (i prod ville vi vente på driftssystem-bekræftelse).
    const sets = []; const params = [];
    if (ny_volumen_l)   { params.push(ny_volumen_l);   sets.push(`volumen_l = $${params.length}`); }
    if (ny_fraktion_id) { params.push(ny_fraktion_id); sets.push(`fraktion_id = $${params.length}`); }
    if (ny_frekvens)    { params.push(ny_frekvens);    sets.push(`frekvens = $${params.length}`); }
    if (sets.length) {
      params.push(req.params.id);
      await client.query(`UPDATE beholdere SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    }

    // Opret sag til opfølgning hos driftssystem.
    const sagId = 'SAG-' + Math.random().toString(36).slice(2, 8).toUpperCase();
    await client.query(
      `INSERT INTO sager (id, domain, kategori, prioritet, titel, beskrivelse, kunde_id, ejendom_id, kontrakt_id, ansvarlig, sla_frist)
       VALUES ($1,'renovation','beholderbytte','normal',$2,$3,$4,$5,$6,$7, now() + interval '7 days')`,
      [sagId,
       `Beholderbytte ${beh.fraktion_navn} ${beh.volumen_l}L`,
       `Bytte til ${ny_fraktion_id || beh.fraktion_id} ${ny_volumen_l || beh.volumen_l}L ${ny_frekvens || beh.frekvens}. ${aarsag || ''}`,
       beh.kunde_id, beh.ejendom_id, beh.kontrakt_id, bruger]
    );
    await client.query(
      `INSERT INTO audit_log (entitet, entitet_id, handling, bruger, detaljer)
       VALUES ('beholder',$1,'bytte',$2,$3::jsonb)`,
      [req.params.id, bruger, JSON.stringify({ ny_volumen_l, ny_fraktion_id, ny_frekvens, aarsag, sag_id: sagId })]
    );
    await client.query('COMMIT');
    res.json({ ok: true, sag_id: sagId, mock: 'Beholderbytte-bestilling sendt til driftssystem' });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    next(e);
  } finally { client.release(); }
});

module.exports = router;
