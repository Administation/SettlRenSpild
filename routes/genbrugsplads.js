// UC-50 Genbrugsplads erhvervsbetaling — registrér besøg og opkrævning.
// Hardware-integrationen (nummerplade-genkendelse, brik) hører til driftssystemet;
// her er det afregnings-siden: registrér besøg → fakturér.
const express = require('express');
const router = express.Router();
const { query, one, pool } = require('../db');

router.get('/', async (req, res, next) => {
  try {
    const { kunde_id, fra, til, faktureret } = req.query;
    const where = []; const params = [];
    if (kunde_id) { params.push(kunde_id); where.push(`g.kunde_id = $${params.length}`); }
    if (fra)      { params.push(fra);      where.push(`g.dato >= $${params.length}`); }
    if (til)      { params.push(til);      where.push(`g.dato <= $${params.length}`); }
    if (faktureret !== undefined) { params.push(faktureret === 'true'); where.push(`g.faktureret = $${params.length}`); }
    const sql = `
      SELECT g.*, k.navn AS kunde_navn, k.type AS kunde_type, f.navn AS fraktion_navn
      FROM genbrugsplads_besog g
      JOIN kunder k ON k.id = g.kunde_id
      LEFT JOIN fraktioner f ON f.id = g.fraktion_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY g.dato DESC LIMIT 200
    `;
    res.json(await query(sql, params));
  } catch (e) { next(e); }
});

// Registrér et besøg (manuelt eller via webhook fra adgangs-system).
router.post('/', async (req, res, next) => {
  try {
    const { kunde_id, ejendom_id, dato, registrering = 'manuel', identifikator, vægt_kg, fraktion_id, pris, noter } = req.body;
    if (!kunde_id) return res.status(400).json({ error: 'kunde_id påkrævet' });
    const k = await one(`SELECT type FROM kunder WHERE id = $1`, [kunde_id]);
    if (!k) return res.status(404).json({ error: 'Kunde ikke fundet' });

    let beregnetPris = pris;
    // Privatkunder: gratis (medregnet i grundgebyr). Erhverv: standardpris pr. besøg eller pr. kg.
    if (beregnetPris == null) {
      if (k.type === 'erhverv') {
        beregnetPris = vægt_kg ? Number(vægt_kg) * 1.50 : 250.00; // fx 1,50 kr/kg eller 250 kr/besøg
      } else {
        beregnetPris = 0;
      }
    }
    const r = await pool.query(
      `INSERT INTO genbrugsplads_besog (kunde_id, ejendom_id, dato, registrering, identifikator, vægt_kg, fraktion_id, pris, noter)
       VALUES ($1,$2,COALESCE($3, now()),$4,$5,$6,$7,$8,$9) RETURNING *`,
      [kunde_id, ejendom_id || null, dato || null, registrering, identifikator || null,
       vægt_kg || null, fraktion_id || null, beregnetPris, noter || null]
    );
    await pool.query(
      `INSERT INTO audit_log (entitet, entitet_id, handling, bruger, detaljer)
       VALUES ('genbrugsplads_besog',$1,'registreret',$2,$3::jsonb)`,
      [String(r.rows[0].id), req.body.bruger || 'System',
       JSON.stringify({ kunde_id, kunde_type: k.type, registrering, vægt_kg, pris: beregnetPris })]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { next(e); }
});

// Stats: misbrugsdetektion — kunder med usædvanligt mange besøg.
router.get('/stats', async (req, res, next) => {
  try {
    const periode = parseInt(req.query.dage, 10) || 30;
    const stats = await query(`
      SELECT k.id, k.navn, k.type,
             COUNT(g.id)::int AS antal_besog,
             COALESCE(SUM(g.vægt_kg),0)::numeric AS total_kg,
             COALESCE(SUM(g.pris),0)::numeric AS total_pris,
             COUNT(g.id) FILTER (WHERE g.faktureret = FALSE)::int AS ufakturerede
      FROM genbrugsplads_besog g
      JOIN kunder k ON k.id = g.kunde_id
      WHERE g.dato > now() - ($1 || ' days')::interval
      GROUP BY k.id, k.navn, k.type
      HAVING COUNT(g.id) > 0
      ORDER BY antal_besog DESC LIMIT 50
    `, [periode]);

    // Anomalidetektion: erhvervskunder med >10 besøg eller >500 kg pr. dag i snit.
    const anomali = stats.filter(r =>
      r.type === 'erhverv' && (Number(r.antal_besog) > 10 || (Number(r.total_kg) / periode) > 500)
    );
    res.json({ periode_dage: periode, top: stats, anomali });
  } catch (e) { next(e); }
});

module.exports = router;
