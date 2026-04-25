const express = require('express');
const router = express.Router();
const { query, one, pool } = require('../db');

function genAdsId() {
  return 'ADS-' + Math.random().toString(36).slice(2, 8).toUpperCase();
}

// Kvartals-perioder: '2026-Q1' → fra/til datoer.
function periodeRange(periode) {
  const m = /^(\d{4})-Q([1-4])$/.exec(periode || '');
  if (!m) return null;
  const aar = Number(m[1]);
  const q = Number(m[2]);
  const fra = `${aar}-${String((q - 1) * 3 + 1).padStart(2, '0')}-01`;
  const tilMaaned = q * 3;
  const sidsteDag = new Date(aar, tilMaaned, 0).getDate();
  const til = `${aar}-${String(tilMaaned).padStart(2, '0')}-${sidsteDag}`;
  return { fra, til };
}

router.get('/', async (req, res, next) => {
  try {
    const { kommune_id } = req.query;
    const where = [];
    const params = [];
    if (kommune_id) { params.push(kommune_id); where.push(`a.kommune_id = $${params.length}`); }
    const sql = `
      SELECT a.*, k.navn AS kommune_navn FROM ads_indberetninger a
      JOIN kommuner k ON k.id = a.kommune_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY a.periode DESC, k.navn
    `;
    res.json(await query(sql, params));
  } catch (e) { next(e); }
});

// Beregn rapport ud fra tømninger i perioden — opretter en kladde.
router.post('/beregn', async (req, res, next) => {
  try {
    const { kommune_id, periode } = req.body;
    if (!kommune_id || !periode) return res.status(400).json({ error: 'kommune_id og periode påkrævet' });
    const range = periodeRange(periode);
    if (!range) return res.status(400).json({ error: 'periode skal have format YYYY-Qn' });

    const fraktioner = await query(`
      SELECT f.id, f.navn, f.ews_kode,
             COUNT(t.id)::int AS tomninger,
             COALESCE(SUM(t.vaegt_kg),0)::numeric AS kg
      FROM fraktioner f
      LEFT JOIN beholdere b ON b.fraktion_id = f.id
      LEFT JOIN kontrakter k ON k.id = b.kontrakt_id
      LEFT JOIN ejendomme e ON e.id = k.ejendom_id AND e.kommune_id = $1
      LEFT JOIN tomninger t ON t.beholder_id = b.id
        AND t.tomning_dato BETWEEN $2 AND $3
        AND e.id IS NOT NULL
      GROUP BY f.id, f.navn, f.ews_kode
      ORDER BY f.navn
    `, [kommune_id, range.fra, range.til]);

    const total_kg = fraktioner.reduce((s, r) => s + Number(r.kg), 0);
    const total_tomninger = fraktioner.reduce((s, r) => s + Number(r.tomninger), 0);

    const id = genAdsId();
    await pool.query(
      `INSERT INTO ads_indberetninger (id, kommune_id, periode, status, total_kg, total_tomninger, rapport)
       VALUES ($1,$2,$3,'kladde',$4,$5,$6::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [id, kommune_id, periode, total_kg.toFixed(2), total_tomninger, JSON.stringify({ fraktioner })]
    );
    res.status(201).json(await one(`SELECT * FROM ads_indberetninger WHERE id = $1`, [id]));
  } catch (e) { next(e); }
});

router.post('/:id/godkend', async (req, res, next) => {
  try {
    const { godkendt_af = 'Manager' } = req.body || {};
    await pool.query(
      `UPDATE ads_indberetninger SET status = 'godkendt', godkendt_af = $1, godkendt_dato = now() WHERE id = $2`,
      [godkendt_af, req.params.id]
    );
    await pool.query(
      `INSERT INTO audit_log (entitet, entitet_id, handling, bruger) VALUES ('ads',$1,'godkendt',$2)`,
      [req.params.id, godkendt_af]
    );
    res.json(await one(`SELECT * FROM ads_indberetninger WHERE id = $1`, [req.params.id]));
  } catch (e) { next(e); }
});

router.post('/:id/indsend', async (req, res, next) => {
  try {
    // Mock: simulér succesfuld OAuth2-baseret indsendelse til Miljøstyrelsen.
    const a = await one(`SELECT * FROM ads_indberetninger WHERE id = $1`, [req.params.id]);
    if (!a) return res.status(404).json({ error: 'Indberetning ikke fundet' });
    if (a.status !== 'godkendt') return res.status(400).json({ error: 'Skal godkendes før indsendelse' });
    const mock = { reference: 'ADS-' + Date.now(), status: 'modtaget' };
    await pool.query(
      `UPDATE ads_indberetninger SET status = 'indsendt', indsendt_dato = now() WHERE id = $1`,
      [req.params.id]
    );
    await pool.query(
      `INSERT INTO audit_log (entitet, entitet_id, handling, bruger, detaljer)
       VALUES ('ads',$1,'indsendt','System',$2::jsonb)`,
      [req.params.id, JSON.stringify(mock)]
    );
    res.json({ ...await one(`SELECT * FROM ads_indberetninger WHERE id = $1`, [req.params.id]), mock });
  } catch (e) { next(e); }
});

module.exports = router;
