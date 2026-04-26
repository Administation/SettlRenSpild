// UC-54 Gebyrsimulering + hvile-i-sig-selv
// UC-59 Sorteringsscore + nudging
// UC-60 Kundeservice-dashboard
// UC-61 Miljø- og affaldsdashboard
const express = require('express');
const router = express.Router();
const { query, one } = require('../db');

// ── UC-54 Gebyrsimulering: hvad sker der med omsætningen hvis priser ændres? ──
router.post('/gebyr-simuler', async (req, res, next) => {
  try {
    const { kommune_id, justeringer = {}, periode_aar } = req.body;
    // justeringer: { 'grundgebyr/husstand': +10%, 'tomning/rest-240l-14d': +50 kr } osv.
    // I demo-version bruger vi en simpel pct-justering på alle linjer eller pr. type.
    const aar = periode_aar || new Date().getFullYear();
    const params = [];
    let kommuneFilter = '';
    if (kommune_id) { params.push(kommune_id); kommuneFilter = `AND e.kommune_id = $${params.length}`; }
    params.push(aar);
    const aarParam = `$${params.length}`;

    const fakturaer = await query(`
      SELECT f.belob_excl, f.belob_incl, f.kommune_id, f.kunde_id
      FROM fakturaer f
      LEFT JOIN ejendomme e ON e.id = f.ejendom_id
      WHERE EXTRACT(YEAR FROM f.fakturadato) = ${aarParam}
        AND f.status NOT IN ('kladde','krediteret')
        ${kommuneFilter}
    `, params);

    const nuvaerende = fakturaer.reduce((s, f) => s + Number(f.belob_excl), 0);
    const pct = Number(justeringer.pct || 0);
    const ny = nuvaerende * (1 + pct / 100);

    res.json({
      aar,
      kommune_id: kommune_id || 'alle',
      antal_fakturaer: fakturaer.length,
      nuvaerende_omsaetning_excl: nuvaerende.toFixed(2),
      ny_omsaetning_excl: ny.toFixed(2),
      aendring_excl: (ny - nuvaerende).toFixed(2),
      aendring_pct: pct,
      hint: 'I produktion: per-linje-justering med beholderkomposition. v1: simpel pct.',
    });
  } catch (e) { next(e); }
});

// Hvile-i-sig-selv-dashboard: dækningsgrad indtægt vs. omkostninger.
// Omkostninger er normalt fra ERP — her bruger vi en konfigureret estimering.
router.get('/hvile-i-sig-selv', async (req, res, next) => {
  try {
    const aar = parseInt(req.query.aar, 10) || new Date().getFullYear();
    const indtaegt = await one(`
      SELECT COALESCE(SUM(belob_excl), 0)::numeric AS belob
      FROM fakturaer
      WHERE EXTRACT(YEAR FROM fakturadato) = $1 AND status NOT IN ('kladde','krediteret')
    `, [aar]);

    // Mocked omkostninger — i prod hentes fra ERP via UC-36-kanalen.
    // Estimation: 60% af indtægten er driftsomkostninger, 25% behandlingsanlæg, 10% admin.
    const drift = Number(indtaegt.belob) * 0.60;
    const behandling = Number(indtaegt.belob) * 0.25;
    const admin = Number(indtaegt.belob) * 0.10;
    const total_omk = drift + behandling + admin;

    res.json({
      aar,
      indtaegt: Number(indtaegt.belob).toFixed(2),
      omkostninger: {
        drift: drift.toFixed(2),
        behandling: behandling.toFixed(2),
        admin: admin.toFixed(2),
        total: total_omk.toFixed(2),
      },
      daekningsgrad_pct: total_omk > 0 ? ((Number(indtaegt.belob) / total_omk) * 100).toFixed(1) : '0',
      saldo: (Number(indtaegt.belob) - total_omk).toFixed(2),
      kommentar: total_omk > Number(indtaegt.belob)
        ? 'Underskud — overvej takststigning ved næste prisbladsversion.'
        : total_omk * 1.05 < Number(indtaegt.belob)
          ? 'Overskud > 5% — kommunalpolitisk overvejelse om takstreduktion (hvile-i-sig-selv princip).'
          : 'Inden for hvile-i-sig-selv-tolerance (±5%).',
      hint: 'Omkostninger er mockede. I prod hentes de via ERP-integration.',
    });
  } catch (e) { next(e); }
});

// ── UC-59 Sorteringsscore — pr. kunde, baseret på vægtdata pr. fraktion ──
router.get('/sorteringsscore/:kunde_id', async (req, res, next) => {
  try {
    const aar = parseInt(req.query.aar, 10) || new Date().getFullYear();
    const periode = parseInt(req.query.dage, 10) || 365;

    const rows = await query(`
      SELECT f.id AS fraktion_id, f.navn AS fraktion_navn,
             COALESCE(SUM(t.vaegt_kg), 0)::numeric AS kg,
             COUNT(t.id)::int AS antal
      FROM fraktioner f
      LEFT JOIN beholdere b ON b.fraktion_id = f.id
      LEFT JOIN kontrakter k ON k.id = b.kontrakt_id AND k.kunde_id = $1
      LEFT JOIN tomninger t ON t.beholder_id = b.id AND t.tomning_dato > now() - ($2 || ' days')::interval
      WHERE k.id IS NOT NULL OR f.id IS NULL
      GROUP BY f.id, f.navn
      ORDER BY f.navn
    `, [req.params.kunde_id, periode]);

    const total = rows.reduce((s, r) => s + Number(r.kg), 0);
    const restAndel = total > 0 ? Number((rows.find(r => r.fraktion_id === 'rest') || { kg: 0 }).kg) / total : 0;
    // Score: 100 - rest_andel%. Lavere rest-andel = bedre sortering.
    const score = Math.max(0, Math.round(100 - restAndel * 100));

    // Sammenligning: gennemsnit på tværs af alle kunder.
    const gns = await one(`
      SELECT AVG(rest_andel) AS snit FROM (
        SELECT
          ku.id AS kunde_id,
          COALESCE(SUM(t.vaegt_kg) FILTER (WHERE b.fraktion_id = 'rest'), 0)::numeric /
          NULLIF(COALESCE(SUM(t.vaegt_kg), 0), 0)::numeric AS rest_andel
        FROM kunder ku
        JOIN kontrakter k ON k.kunde_id = ku.id
        JOIN beholdere b ON b.kontrakt_id = k.id
        LEFT JOIN tomninger t ON t.beholder_id = b.id AND t.tomning_dato > now() - ($1 || ' days')::interval
        GROUP BY ku.id
      ) sub
    `, [periode]);
    const gnsScore = gns?.snit ? Math.max(0, Math.round(100 - Number(gns.snit) * 100)) : null;

    // Nudging-besked.
    let nudging;
    if (score >= 80) nudging = `Flot! Du sorterer bedre end ${gnsScore != null && score > gnsScore ? 'gennemsnittet' : 'mange andre'}.`;
    else if (score >= 60) nudging = 'Du er på rette vej. Husk at madaffald og emballager kan sorteres bedre fra restaffald.';
    else nudging = 'Der er stort potentiale: den meste husholdningsaffald kan genanvendes. Tjek sorteringsguiden.';

    res.json({
      kunde_id: req.params.kunde_id,
      periode_dage: periode,
      score,
      gennemsnit_score: gnsScore,
      total_kg: total.toFixed(1),
      pr_fraktion: rows,
      rest_andel_pct: (restAndel * 100).toFixed(1),
      nudging,
      co2_estimat_kg: Math.round(total * 0.4), // grov estimering: 0,4 kg CO2 sparet pr. kg sorteret affald
    });
  } catch (e) { next(e); }
});

// ── UC-60 Kundeservice-dashboard ──
router.get('/kundeservice', async (req, res, next) => {
  try {
    const dage = parseInt(req.query.dage, 10) || 30;
    const sla = await one(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'lukket' AND lukket > now() - ($1 || ' days')::interval)::int AS lukket_periode,
        COUNT(*) FILTER (WHERE status <> 'lukket')::int AS aabne,
        COUNT(*) FILTER (WHERE status <> 'lukket' AND sla_frist IS NOT NULL AND sla_frist < now())::int AS sla_overskredet,
        AVG(EXTRACT(EPOCH FROM (lukket - oprettet))/3600) FILTER (WHERE status = 'lukket' AND lukket > now() - ($1 || ' days')::interval) AS gns_loesningstid_timer
      FROM sager
    `, [dage]);

    const top10 = await query(`
      SELECT s.kunde_id, COALESCE(k.navn, '— ukendt') AS kunde_navn,
             e.vejnavn, e.husnr, e.postnr,
             COUNT(*)::int AS antal_sager
      FROM sager s
      LEFT JOIN kunder k ON k.id = s.kunde_id
      LEFT JOIN ejendomme e ON e.id = s.ejendom_id
      WHERE s.oprettet > now() - ($1 || ' days')::interval
      GROUP BY s.kunde_id, k.navn, e.vejnavn, e.husnr, e.postnr
      HAVING COUNT(*) > 1
      ORDER BY COUNT(*) DESC LIMIT 10
    `, [dage]);

    const fcr = await one(`
      WITH oprettelser AS (
        SELECT s.id, s.oprettet, s.lukket,
               COUNT(a.id) FILTER (WHERE a.type = 'kommentar')::int AS antal_kommentarer
        FROM sager s
        LEFT JOIN sag_aktiviteter a ON a.sag_id = s.id
        WHERE s.oprettet > now() - ($1 || ' days')::interval
        GROUP BY s.id, s.oprettet, s.lukket
      )
      SELECT
        COUNT(*) FILTER (WHERE lukket IS NOT NULL AND antal_kommentarer = 0)::int AS fcr_loest,
        COUNT(*)::int AS total
      FROM oprettelser
    `, [dage]);

    const kanaler = await query(`
      SELECT COALESCE(ansvarlig, 'Anden') AS kanal, COUNT(*)::int AS n
      FROM sager
      WHERE oprettet > now() - ($1 || ' days')::interval
      GROUP BY ansvarlig ORDER BY n DESC
    `, [dage]);

    const kategorier = await query(`
      SELECT kategori, COUNT(*)::int AS n
      FROM sager
      WHERE oprettet > now() - ($1 || ' days')::interval
      GROUP BY kategori ORDER BY n DESC
    `, [dage]);

    res.json({
      periode_dage: dage,
      sla,
      first_contact_resolution_pct: fcr.total > 0 ? ((fcr.fcr_loest / fcr.total) * 100).toFixed(1) : '0',
      top_problemadresser: top10,
      kanaler, kategorier,
      automatiseringsgrad_pct: (() => {
        const auto = kanaler.filter(k => k.kanal === 'Zerv' || k.kanal === 'System').reduce((s, k) => s + Number(k.n), 0);
        const total = kanaler.reduce((s, k) => s + Number(k.n), 0);
        return total > 0 ? ((auto / total) * 100).toFixed(1) : '0';
      })(),
    });
  } catch (e) { next(e); }
});

// ── UC-61 Miljø- og affaldsdashboard ──
router.get('/miljo', async (req, res, next) => {
  try {
    const aar = parseInt(req.query.aar, 10) || new Date().getFullYear();
    const fraktioner = await query(`
      SELECT f.id, f.navn, f.farve,
             COUNT(t.id)::int AS antal_tomninger,
             COALESCE(SUM(t.vaegt_kg), 0)::numeric AS total_kg
      FROM fraktioner f
      LEFT JOIN beholdere b ON b.fraktion_id = f.id
      LEFT JOIN tomninger t ON t.beholder_id = b.id AND EXTRACT(YEAR FROM t.tomning_dato) = $1
      GROUP BY f.id, f.navn, f.farve
      ORDER BY total_kg DESC
    `, [aar]);

    const total = fraktioner.reduce((s, f) => s + Number(f.total_kg), 0);
    const restKg = Number((fraktioner.find(f => f.id === 'rest') || { total_kg: 0 }).total_kg);
    const genanvendelses_andel = total > 0 ? ((total - restKg) / total) * 100 : 0;

    // Per måned: trend over året.
    const pr_maaned = await query(`
      SELECT EXTRACT(MONTH FROM t.tomning_dato)::int AS maaned,
             SUM(t.vaegt_kg)::numeric AS kg
      FROM tomninger t
      WHERE EXTRACT(YEAR FROM t.tomning_dato) = $1
      GROUP BY maaned ORDER BY maaned
    `, [aar]);

    // Top-fejlsorterings-mønstre (undtagelseskoder).
    const fejlsortering = await query(`
      SELECT undtagelseskode, COUNT(*)::int AS n
      FROM tomninger
      WHERE undtagelseskode = 'forkert_indhold' OR undtagelseskode = 'forkert_fraktion'
      AND EXTRACT(YEAR FROM tomning_dato) = $1
      GROUP BY undtagelseskode
    `, [aar]);

    res.json({
      aar,
      total_kg: total.toFixed(1),
      genanvendelses_andel_pct: genanvendelses_andel.toFixed(1),
      co2_sparet_kg_estimat: Math.round((total - restKg) * 0.4),
      pr_fraktion: fraktioner,
      pr_maaned,
      fejlsortering,
    });
  } catch (e) { next(e); }
});

module.exports = router;
