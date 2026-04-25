const express = require('express');
const router = express.Router();
const { query, one, pool } = require('../db');
const { parsePaging, paginatedQuery } = require('../lib/pagination');

function genSagId() {
  return 'SAG-' + Math.random().toString(36).slice(2, 8).toUpperCase();
}

router.get('/', async (req, res, next) => {
  try {
    const { domain, status, kunde_id, prioritet, kategori, ansvarlig, q, sla } = req.query;
    const { limit, offset } = parsePaging(req.query, { limit: 50 });
    const where = [];
    const params = [];
    if (domain)    { params.push(domain);    where.push(`s.domain    = $${params.length}`); }
    if (kunde_id)  { params.push(kunde_id);  where.push(`s.kunde_id  = $${params.length}`); }
    if (prioritet) { params.push(prioritet); where.push(`s.prioritet = $${params.length}`); }
    if (kategori)  { params.push(kategori);  where.push(`s.kategori  = $${params.length}`); }
    if (ansvarlig) { params.push(ansvarlig); where.push(`s.ansvarlig = $${params.length}`); }

    // Status accepterer kommasepareret liste, eller særværdien 'aabne' (alt undtagen lukket).
    if (status) {
      if (status === 'aabne') {
        where.push(`s.status <> 'lukket'`);
      } else {
        const list = status.split(',').map(s => s.trim()).filter(Boolean);
        params.push(list);
        where.push(`s.status = ANY($${params.length}::text[])`);
      }
    }

    if (q) {
      params.push(`%${q}%`);
      where.push(`(s.titel ILIKE $${params.length} OR s.beskrivelse ILIKE $${params.length} OR s.id ILIKE $${params.length})`);
    }

    // SLA-filter: 'overdue' = SLA-frist overskredet, 'soon' = inden for 24h.
    if (sla === 'overdue') where.push(`s.sla_frist IS NOT NULL AND s.sla_frist < now() AND s.status <> 'lukket'`);
    if (sla === 'soon')    where.push(`s.sla_frist IS NOT NULL AND s.sla_frist BETWEEN now() AND now() + interval '24 hours' AND s.status <> 'lukket'`);

    const result = await paginatedQuery(pool, {
      selectSql: `s.*, k.navn AS kunde_navn,
                  CASE
                    WHEN s.status = 'lukket' THEN 'closed'
                    WHEN s.sla_frist IS NULL THEN 'none'
                    WHEN s.sla_frist < now() THEN 'overdue'
                    WHEN s.sla_frist < now() + interval '24 hours' THEN 'soon'
                    ELSE 'ok'
                  END AS sla_status`,
      fromSql: 'sager s LEFT JOIN kunder k ON k.id = s.kunde_id',
      whereSql: where.join(' AND '),
      params,
      orderBy: `CASE WHEN s.status = 'lukket' THEN 1 ELSE 0 END,
                CASE s.prioritet WHEN 'akut' THEN 0 WHEN 'hoej' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
                s.oprettet DESC`,
      limit,
      offset,
    });
    res.json(result);
  } catch (e) { next(e); }
});

// KPI-tæller: aggregér åbne sager efter status/prioritet/SLA.
// Bruges af sage-arbejdsbordet til "kø-bjælker".
router.get('/stats', async (req, res, next) => {
  try {
    const { domain } = req.query;
    const params = [];
    let domainFilter = '';
    if (domain) { params.push(domain); domainFilter = `AND domain = $${params.length}`; }

    const stats = await query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'aaben')::int        AS aaben,
        COUNT(*) FILTER (WHERE status = 'igang')::int        AS igang,
        COUNT(*) FILTER (WHERE status = 'venter_kunde')::int AS venter_kunde,
        COUNT(*) FILTER (WHERE status = 'lukket')::int       AS lukket,
        COUNT(*) FILTER (WHERE prioritet = 'akut'  AND status <> 'lukket')::int AS akut,
        COUNT(*) FILTER (WHERE prioritet = 'hoej'  AND status <> 'lukket')::int AS hoej,
        COUNT(*) FILTER (WHERE sla_frist IS NOT NULL AND sla_frist < now() AND status <> 'lukket')::int AS sla_overdue,
        COUNT(*) FILTER (WHERE sla_frist IS NOT NULL AND sla_frist BETWEEN now() AND now() + interval '24 hours' AND status <> 'lukket')::int AS sla_soon
      FROM sager
      WHERE 1=1 ${domainFilter}
    `, params);
    const byKategori = await query(`
      SELECT kategori, COUNT(*)::int AS n FROM sager
      WHERE status <> 'lukket' ${domainFilter}
      GROUP BY kategori ORDER BY n DESC
    `, params);
    const byAnsvarlig = await query(`
      SELECT COALESCE(ansvarlig, '— ikke tildelt') AS ansvarlig, COUNT(*)::int AS n FROM sager
      WHERE status <> 'lukket' ${domainFilter}
      GROUP BY ansvarlig ORDER BY n DESC
    `, params);
    res.json({ ...stats[0], by_kategori: byKategori, by_ansvarlig: byAnsvarlig });
  } catch (e) { next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const s = await one(`SELECT * FROM sager WHERE id = $1`, [req.params.id]);
    if (!s) return res.status(404).json({ error: 'Sag ikke fundet' });
    const aktiviteter = await query(`SELECT * FROM sag_aktiviteter WHERE sag_id = $1 ORDER BY oprettet`, [req.params.id]);
    res.json({ ...s, aktiviteter });
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const id = req.body.id || genSagId();
    const { domain='renovation', kategori, prioritet='normal', titel, beskrivelse, kunde_id, ejendom_id, kontrakt_id, ansvarlig, sla_frist } = req.body;
    if (!titel) return res.status(400).json({ error: 'titel påkrævet' });
    await pool.query(
      `INSERT INTO sager (id, domain, kategori, prioritet, titel, beskrivelse, kunde_id, ejendom_id, kontrakt_id, ansvarlig, sla_frist)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, domain, kategori, prioritet, titel, beskrivelse, kunde_id, ejendom_id, kontrakt_id, ansvarlig, sla_frist]
    );
    await pool.query(
      `INSERT INTO sag_aktiviteter (sag_id, type, tekst, bruger) VALUES ($1,'oprettet','Sag oprettet',$2)`,
      [id, ansvarlig || 'System']
    );
    res.status(201).json(await one(`SELECT * FROM sager WHERE id = $1`, [id]));
  } catch (e) { next(e); }
});

router.post('/:id/kommentar', async (req, res, next) => {
  try {
    const { tekst, bruger='Support' } = req.body;
    await pool.query(`INSERT INTO sag_aktiviteter (sag_id, type, tekst, bruger) VALUES ($1,'kommentar',$2,$3)`, [req.params.id, tekst, bruger]);
    res.json(await query(`SELECT * FROM sag_aktiviteter WHERE sag_id = $1 ORDER BY oprettet`, [req.params.id]));
  } catch (e) { next(e); }
});

router.put('/:id', async (req, res, next) => {
  try {
    const fields = ['status','prioritet','ansvarlig','kategori','titel','beskrivelse','sla_frist'];
    const sets = [];
    const params = [];
    for (const f of fields) {
      if (f in req.body) { params.push(req.body[f]); sets.push(`${f} = $${params.length}`); }
    }
    const lukker = req.body.status === 'lukket';
    if (lukker) sets.push(`lukket = now()`);
    if (!sets.length) return res.json(await one(`SELECT * FROM sager WHERE id = $1`, [req.params.id]));
    params.push(req.params.id);
    await pool.query(`UPDATE sager SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    if (req.body.status) {
      await pool.query(`INSERT INTO sag_aktiviteter (sag_id, type, tekst, bruger) VALUES ($1,'statusskift',$2,$3)`,
        [req.params.id, `Status ændret til ${req.body.status}`, req.body.bruger || 'System']);
    }
    res.json(await one(`SELECT * FROM sager WHERE id = $1`, [req.params.id]));
  } catch (e) { next(e); }
});

module.exports = router;
