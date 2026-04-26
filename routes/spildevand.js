// Spildevand-domæne routes — vandmålere, aflæsninger, forbrugsberegning, aconto.
// Genbruger fakturer/betalinger/sager via service_type='spildevand'-discriminator.
const express = require('express');
const router = express.Router();
const { query, one, pool } = require('../db');
const { parsePaging, paginatedQuery } = require('../lib/pagination');

function genMaalerId() { return 'VM-' + Math.random().toString(36).slice(2, 8).toUpperCase(); }
function genAcontoId() { return 'AC-' + Math.random().toString(36).slice(2, 8).toUpperCase(); }

// ── VANDMÅLERE ──
router.get('/maalere', async (req, res, next) => {
  try {
    const { ejendom_id, kontrakt_id, status, q } = req.query;
    const { limit, offset } = parsePaging(req.query, { limit: 50 });
    const where = []; const params = [];
    if (ejendom_id)  { params.push(ejendom_id);  where.push(`m.ejendom_id  = $${params.length}`); }
    if (kontrakt_id) { params.push(kontrakt_id); where.push(`m.kontrakt_id = $${params.length}`); }
    if (status)      { params.push(status);      where.push(`m.status      = $${params.length}`); }
    if (q) {
      params.push(`%${q}%`);
      where.push(`(m.maalernummer ILIKE $${params.length} OR e.vejnavn ILIKE $${params.length} OR ku.navn ILIKE $${params.length})`);
    }
    const result = await paginatedQuery(pool, {
      selectSql: `m.*, e.vejnavn, e.husnr, e.postnr, e.by, ku.id AS kunde_id, ku.navn AS kunde_navn,
        (SELECT MAX(stand_m3) FROM aflaesninger a WHERE a.maaler_id = m.id) AS sidste_stand,
        (SELECT MAX(dato) FROM aflaesninger a WHERE a.maaler_id = m.id) AS sidste_aflaesning_dato`,
      fromSql: `vandmaalere m
        LEFT JOIN ejendomme e ON e.id = m.ejendom_id
        LEFT JOIN kontrakter k ON k.id = m.kontrakt_id
        LEFT JOIN kunder ku ON ku.id = k.kunde_id`,
      whereSql: where.join(' AND '),
      params, orderBy: 'm.installeret DESC',
      limit, offset,
    });
    res.json(result);
  } catch (e) { next(e); }
});

router.get('/maalere/:id', async (req, res, next) => {
  try {
    const m = await one(`
      SELECT m.*, e.vejnavn, e.husnr, e.postnr, e.by, ku.id AS kunde_id, ku.navn AS kunde_navn,
             k.id AS kontrakt_id, k.status AS kontrakt_status
      FROM vandmaalere m
      LEFT JOIN ejendomme e ON e.id = m.ejendom_id
      LEFT JOIN kontrakter k ON k.id = m.kontrakt_id
      LEFT JOIN kunder ku ON ku.id = k.kunde_id
      WHERE m.id = $1
    `, [req.params.id]);
    if (!m) return res.status(404).json({ error: 'Måler ikke fundet' });
    const aflaesninger = await query(`
      SELECT * FROM aflaesninger WHERE maaler_id = $1 ORDER BY dato DESC LIMIT 50
    `, [req.params.id]);
    const bimaalere = await query(`
      SELECT id, maalernummer, status FROM vandmaalere WHERE bimaaler_af = $1
    `, [req.params.id]);
    res.json({ ...m, aflaesninger, bimaalere });
  } catch (e) { next(e); }
});

router.post('/maalere', async (req, res, next) => {
  try {
    const id = req.body.id || genMaalerId();
    const { ejendom_id, kontrakt_id, maalernummer, fabrikat='Kamstrup', type='mekanisk',
            dimension='qn2.5', installeret, bimaaler_af, fradragsmaaler=false, fjernaflaest=false } = req.body;
    if (!ejendom_id || !maalernummer || !installeret) return res.status(400).json({ error: 'ejendom_id, maalernummer og installeret påkrævet' });
    await pool.query(
      `INSERT INTO vandmaalere (id, ejendom_id, kontrakt_id, maalernummer, fabrikat, type, dimension,
         installeret, bimaaler_af, fradragsmaaler, fjernaflaest)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, ejendom_id, kontrakt_id || null, maalernummer, fabrikat, type, dimension,
       installeret, bimaaler_af || null, fradragsmaaler, fjernaflaest]
    );
    res.status(201).json(await one(`SELECT * FROM vandmaalere WHERE id = $1`, [id]));
  } catch (e) { next(e); }
});

// Udskift måler — markér gammel som 'udskiftet' og opret ny.
router.post('/maalere/:id/udskift', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { ny_maalernummer, fabrikat, type, dimension, slut_stand_m3, ny_start_stand_m3=0, dato } = req.body;
    if (!ny_maalernummer) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'ny_maalernummer påkrævet' }); }
    const gammel = (await client.query(`SELECT * FROM vandmaalere WHERE id = $1`, [req.params.id])).rows[0];
    if (!gammel) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Måler ikke fundet' }); }
    const datoStr = dato || new Date().toISOString().slice(0,10);

    // Slut-aflæsning på gammel måler.
    if (slut_stand_m3 != null) {
      await client.query(
        `INSERT INTO aflaesninger (maaler_id, dato, stand_m3, kilde, validering, noter)
         VALUES ($1,$2,$3,'manuel','gyldig','Slut-aflæsning ved udskiftning')`,
        [req.params.id, datoStr, slut_stand_m3]
      );
    }
    // Markér som udskiftet.
    await client.query(`UPDATE vandmaalere SET status = 'udskiftet', nedtaget = $1 WHERE id = $2`,
      [datoStr, req.params.id]);
    // Opret ny måler.
    const nyId = genMaalerId();
    await client.query(
      `INSERT INTO vandmaalere (id, ejendom_id, kontrakt_id, maalernummer, fabrikat, type, dimension, installeret)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [nyId, gammel.ejendom_id, gammel.kontrakt_id, ny_maalernummer,
       fabrikat || gammel.fabrikat, type || gammel.type, dimension || gammel.dimension, datoStr]
    );
    // Start-aflæsning på ny måler.
    await client.query(
      `INSERT INTO aflaesninger (maaler_id, dato, stand_m3, kilde, validering, noter)
       VALUES ($1,$2,$3,'manuel','gyldig','Start-aflæsning på ny måler')`,
      [nyId, datoStr, ny_start_stand_m3]
    );
    await client.query(
      `INSERT INTO audit_log (entitet, entitet_id, handling, bruger, detaljer)
       VALUES ('vandmaaler',$1,'udskiftet',$2,$3::jsonb)`,
      [req.params.id, req.body.bruger || 'Drift',
       JSON.stringify({ ny_id: nyId, ny_maalernummer, slut_stand_m3, ny_start_stand_m3, dato: datoStr })]
    );
    await client.query('COMMIT');
    res.status(201).json({ ok: true, ny_maaler_id: nyId });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    next(e);
  } finally { client.release(); }
});

// ── AFLÆSNINGER ──
router.get('/aflaesninger', async (req, res, next) => {
  try {
    const { maaler_id, kontrakt_id, validering, kilde, fra, til } = req.query;
    const { limit, offset } = parsePaging(req.query, { limit: 100 });
    const where = []; const params = [];
    if (maaler_id)   { params.push(maaler_id);   where.push(`a.maaler_id = $${params.length}`); }
    if (kontrakt_id) { params.push(kontrakt_id); where.push(`m.kontrakt_id = $${params.length}`); }
    if (validering)  { params.push(validering);  where.push(`a.validering = $${params.length}`); }
    if (kilde)       { params.push(kilde);       where.push(`a.kilde = $${params.length}`); }
    if (fra)         { params.push(fra);         where.push(`a.dato >= $${params.length}`); }
    if (til)         { params.push(til);         where.push(`a.dato <= $${params.length}`); }
    const result = await paginatedQuery(pool, {
      selectSql: `a.*, m.maalernummer, m.fabrikat, e.vejnavn, e.husnr, e.postnr, e.by, ku.navn AS kunde_navn`,
      fromSql: `aflaesninger a
        JOIN vandmaalere m ON m.id = a.maaler_id
        LEFT JOIN ejendomme e ON e.id = m.ejendom_id
        LEFT JOIN kontrakter k ON k.id = m.kontrakt_id
        LEFT JOIN kunder ku ON ku.id = k.kunde_id`,
      whereSql: where.join(' AND '),
      params, orderBy: 'a.dato DESC',
      limit, offset,
    });
    res.json(result);
  } catch (e) { next(e); }
});

// Manuel registrering — validerer at standen er stigende ift. seneste aflæsning.
router.post('/aflaesninger', async (req, res, next) => {
  try {
    const { maaler_id, dato, stand_m3, kilde='manuel', aflaeser, noter } = req.body;
    if (!maaler_id || !dato || stand_m3 == null) return res.status(400).json({ error: 'maaler_id, dato og stand_m3 påkrævet' });

    // Find seneste aflæsning og valider — anomali-flag hvis stand falder eller forbruget er ekstrem.
    const sidste = await one(`SELECT stand_m3, dato FROM aflaesninger WHERE maaler_id = $1 ORDER BY dato DESC LIMIT 1`, [maaler_id]);
    let validering = 'gyldig';
    let auto_noter = noter || '';
    if (sidste) {
      if (Number(stand_m3) < Number(sidste.stand_m3)) {
        validering = 'flagget';
        auto_noter = `[Auto] Faldende stand: tidligere ${sidste.stand_m3} m³ → ny ${stand_m3} m³. ` + auto_noter;
      } else {
        const dage = (new Date(dato) - new Date(sidste.dato)) / 86400000 || 1;
        const m3PerDag = (Number(stand_m3) - Number(sidste.stand_m3)) / dage;
        if (m3PerDag > 5) {
          validering = 'flagget';
          auto_noter = `[Auto] Stort forbrug: ${m3PerDag.toFixed(2)} m³/dag — mulig lækage? ` + auto_noter;
        }
      }
    }
    const r = await pool.query(
      `INSERT INTO aflaesninger (maaler_id, dato, stand_m3, kilde, aflaeser, validering, noter)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [maaler_id, dato, stand_m3, kilde, aflaeser || null, validering, auto_noter || null]
    );
    res.status(201).json({ ...r.rows[0], anomali: validering === 'flagget' });
  } catch (e) { next(e); }
});

// Estimerede aflæsninger ved årsskifte for målere uden aflæsning i perioden.
router.post('/aflaesninger/aarsskifte-estimat', async (req, res, next) => {
  try {
    const aar = parseInt(req.body?.aar, 10) || new Date().getFullYear();
    const refDato = `${aar}-01-01`;
    // Find målere uden aflæsning i sidste 60 dage før refDato.
    const maalere = await query(`
      SELECT m.id,
             (SELECT MAX(stand_m3) FROM aflaesninger a WHERE a.maaler_id = m.id) AS sidste_stand,
             (SELECT MAX(dato) FROM aflaesninger a WHERE a.maaler_id = m.id) AS sidste_dato
      FROM vandmaalere m
      WHERE m.status = 'aktiv'
      HAVING (SELECT MAX(dato) FROM aflaesninger a WHERE a.maaler_id = m.id) IS NULL
         OR (SELECT MAX(dato) FROM aflaesninger a WHERE a.maaler_id = m.id) < ($1::date - interval '60 days')
    `, [refDato]);
    let oprettet = 0;
    for (const m of maalere) {
      const estStand = m.sidste_stand ? Number(m.sidste_stand) + 50 : 0; // grov estimering: +50 m³/år
      await pool.query(
        `INSERT INTO aflaesninger (maaler_id, dato, stand_m3, kilde, validering, noter)
         VALUES ($1,$2,$3,'estimat','estimat','Auto-genereret årsskifte-estimat')`,
        [m.id, refDato, estStand.toFixed(3)]
      );
      oprettet++;
    }
    res.json({ ok: true, oprettet, aar });
  } catch (e) { next(e); }
});

// ── FORBRUGSBEREGNING for en kontrakt-periode ──
// Bruges af fakturakørsel — beregner m³-forbrug, vandafledning, statsafgift.
router.post('/forbrug', async (req, res, next) => {
  try {
    const { kontrakt_id, periode_fra, periode_til } = req.body;
    if (!kontrakt_id || !periode_fra || !periode_til) return res.status(400).json({ error: 'kontrakt_id, periode_fra, periode_til påkrævet' });

    // Find aktive målere på kontrakten.
    const maalere = await query(`
      SELECT m.* FROM vandmaalere m
      WHERE m.kontrakt_id = $1
        AND (m.nedtaget IS NULL OR m.nedtaget > $2::date)
        AND m.installeret <= $3::date
        AND m.status IN ('aktiv','udskiftet')
    `, [kontrakt_id, periode_fra, periode_til]);

    if (!maalere.length) return res.json({ kontrakt_id, m3_forbrug: 0, linjer: [], advarsel: 'Ingen målere fundet på kontrakten' });

    // Find aflæsninger nær periode_fra og periode_til.
    let totalM3 = 0;
    let fradragM3 = 0;
    const detaljer = [];
    for (const m of maalere) {
      const startA = await one(`
        SELECT * FROM aflaesninger WHERE maaler_id = $1 AND dato <= $2::date
        ORDER BY dato DESC LIMIT 1
      `, [m.id, periode_fra]);
      const slutA = await one(`
        SELECT * FROM aflaesninger WHERE maaler_id = $1 AND dato <= $2::date
        ORDER BY dato DESC LIMIT 1
      `, [m.id, periode_til]);
      const startStand = startA ? Number(startA.stand_m3) : 0;
      const slutStand  = slutA  ? Number(slutA.stand_m3)  : startStand;
      const m3 = Math.max(0, slutStand - startStand);
      detaljer.push({
        maaler_id: m.id, maalernummer: m.maalernummer,
        bimaaler: !!m.bimaaler_af, fradragsmaaler: m.fradragsmaaler,
        start_stand: startStand, slut_stand: slutStand, m3,
      });
      if (m.fradragsmaaler) fradragM3 += m3;
      else if (!m.bimaaler_af) totalM3 += m3; // hovedmåler bidrager kun, ikke bimaalere (de er "i" hovedmaaler)
    }
    const afledteM3 = Math.max(0, totalM3 - fradragM3);

    // Find aktivt prisblad og priser.
    const ejendom = await one(`SELECT kommune_id FROM kontrakter k JOIN ejendomme e ON e.id = k.ejendom_id WHERE k.id = $1`, [kontrakt_id]);
    const prisblad = await one(`
      SELECT * FROM prisblade
      WHERE service_type = 'spildevand' AND kommune_id = $1 AND status = 'aktiv'
        AND gyldig_fra <= $2::date AND (gyldig_til IS NULL OR gyldig_til >= $2::date)
      ORDER BY gyldig_fra DESC LIMIT 1
    `, [ejendom?.kommune_id, periode_til]);

    if (!prisblad) return res.json({ kontrakt_id, m3_forbrug: afledteM3, fradrag: fradragM3, linjer: [], advarsel: 'Intet aktivt spildevand-prisblad' });

    const linjer = await query(`SELECT * FROM prisblad_linjer WHERE prisblad_id = $1`, [prisblad.id]);
    const out = [];

    // Vandafledning kr/m³.
    const vaPris = linjer.find(l => l.type === 'vandafledning' && l.noegle === 'm3');
    if (vaPris && afledteM3 > 0) {
      out.push({
        beskrivelse: `Vandafledningsbidrag (${afledteM3.toFixed(2)} m³)`,
        type: 'vandafledning', antal: afledteM3.toFixed(3),
        enhed: 'm³', enhedspris: vaPris.enhedspris,
        belob_excl: (afledteM3 * Number(vaPris.enhedspris)).toFixed(2),
        moms_pct: vaPris.moms_pct,
      });
    }
    // Statsafgift kr/m³.
    const sa = linjer.find(l => l.type === 'statsafgift' && l.noegle === 'm3');
    if (sa && afledteM3 > 0) {
      out.push({
        beskrivelse: `Statsafgift på spildevand (${afledteM3.toFixed(2)} m³)`,
        type: 'statsafgift', antal: afledteM3.toFixed(3),
        enhed: 'm³', enhedspris: sa.enhedspris,
        belob_excl: (afledteM3 * Number(sa.enhedspris)).toFixed(2),
        moms_pct: sa.moms_pct,
      });
    }
    // Fast årligt gebyr (proratet).
    const fast = linjer.find(l => l.type === 'fast_aar' && l.noegle === 'husstand');
    if (fast) {
      const dage = (new Date(periode_til) - new Date(periode_fra)) / 86400000 + 1;
      const aarFraktion = dage / 365;
      out.push({
        beskrivelse: `Fast årligt spildevandsgebyr (${dage.toFixed(0)} dage)`,
        type: 'fast_aar', antal: aarFraktion.toFixed(4),
        enhed: 'år', enhedspris: fast.enhedspris,
        belob_excl: (Number(fast.enhedspris) * aarFraktion).toFixed(2),
        moms_pct: fast.moms_pct,
      });
    }
    res.json({ kontrakt_id, periode: { fra: periode_fra, til: periode_til },
      m3_forbrug: afledteM3, fradrag_m3: fradragM3, hovedmaaler_m3: totalM3,
      detaljer, prisblad: { id: prisblad.id, version: prisblad.version }, linjer: out });
  } catch (e) { next(e); }
});

// ── ACONTOPLAN ──
router.get('/aconto', async (req, res, next) => {
  try {
    const { kontrakt_id, kunde_id, status } = req.query;
    const where = []; const params = [];
    if (kontrakt_id) { params.push(kontrakt_id); where.push(`a.kontrakt_id = $${params.length}`); }
    if (status)      { params.push(status);      where.push(`a.status = $${params.length}`); }
    if (kunde_id)    { params.push(kunde_id);    where.push(`k.kunde_id = $${params.length}`); }
    const rows = await query(`
      SELECT a.*, k.kunde_id, ku.navn AS kunde_navn
      FROM acontoplaner a
      JOIN kontrakter k ON k.id = a.kontrakt_id
      JOIN kunder ku ON ku.id = k.kunde_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY a.aar DESC, a.oprettet DESC
    `, params);
    res.json(rows);
  } catch (e) { next(e); }
});

router.post('/aconto', async (req, res, next) => {
  try {
    const { kontrakt_id, aar, forventet_m3, antal_rater = 4 } = req.body;
    if (!kontrakt_id || !aar || !forventet_m3) return res.status(400).json({ error: 'kontrakt_id, aar og forventet_m3 påkrævet' });

    // Beregn estimeret beløb fra prisblad.
    const ejendom = await one(`SELECT kommune_id FROM kontrakter k JOIN ejendomme e ON e.id = k.ejendom_id WHERE k.id = $1`, [kontrakt_id]);
    const prisblad = await one(`
      SELECT id FROM prisblade WHERE service_type = 'spildevand' AND kommune_id = $1
        AND status = 'aktiv' ORDER BY gyldig_fra DESC LIMIT 1
    `, [ejendom?.kommune_id]);
    let estBelob = 0;
    if (prisblad) {
      const linjer = await query(`SELECT type, noegle, enhedspris FROM prisblad_linjer WHERE prisblad_id = $1`, [prisblad.id]);
      const va = Number((linjer.find(l => l.type === 'vandafledning' && l.noegle === 'm3') || {}).enhedspris || 0);
      const sa = Number((linjer.find(l => l.type === 'statsafgift'   && l.noegle === 'm3') || {}).enhedspris || 0);
      const fast = Number((linjer.find(l => l.type === 'fast_aar'    && l.noegle === 'husstand') || {}).enhedspris || 0);
      estBelob = (va + sa) * Number(forventet_m3) + fast;
      estBelob = estBelob * 1.25; // moms
    }
    const id = genAcontoId();
    await pool.query(
      `INSERT INTO acontoplaner (id, kontrakt_id, aar, forventet_m3, estimeret_aarsbelob, rate_belob, antal_rater)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (kontrakt_id, aar) DO UPDATE SET
         forventet_m3 = EXCLUDED.forventet_m3,
         estimeret_aarsbelob = EXCLUDED.estimeret_aarsbelob,
         rate_belob = EXCLUDED.rate_belob,
         antal_rater = EXCLUDED.antal_rater`,
      [id, kontrakt_id, aar, forventet_m3, estBelob.toFixed(2), (estBelob / antal_rater).toFixed(2), antal_rater]
    );
    res.status(201).json(await one(`SELECT * FROM acontoplaner WHERE id = $1`, [id]));
  } catch (e) { next(e); }
});

// ── WEBHOOK fra fjernaflæsnings-system (fx Kamstrup READy) ──
router.post('/webhook/aflaesning/:provider', async (req, res, next) => {
  try {
    const provider = req.params.provider.toLowerCase();
    const expected = process.env[`WEBHOOK_TOKEN_${provider.toUpperCase()}`] || process.env.WEBHOOK_TOKEN;
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    if (!expected || token !== expected) return res.status(401).json({ error: 'Unauthorized' });

    const events = Array.isArray(req.body) ? req.body : [req.body];
    const results = [];
    for (const ev of events) {
      const externalRef = `${provider}:${ev.eventId || ev.id}`;
      const dup = await one(`SELECT id FROM aflaesninger WHERE external_ref = $1`, [externalRef]);
      if (dup) { results.push({ status: 'ignoreret', reason: 'duplicate' }); continue; }
      const m = await one(`SELECT id FROM vandmaalere WHERE maalernummer = $1 OR id = $1`, [ev.maalernummer || ev.maaler_id]);
      if (!m) { results.push({ status: 'fejl', fejl: 'Ukendt måler' }); continue; }
      await pool.query(
        `INSERT INTO aflaesninger (maaler_id, dato, stand_m3, kilde, validering, external_ref, noter)
         VALUES ($1,$2,$3,'fjernaflaest','gyldig',$4,$5)`,
        [m.id, ev.dato || ev.timestamp.slice(0,10), ev.stand_m3 || ev.value, externalRef, `Provider: ${provider}`]
      );
      results.push({ status: 'behandlet', maaler_id: m.id });
    }
    res.json({ received: events.length, results });
  } catch (e) { next(e); }
});

// ── ANOMALIDETEKTION: målere med flagget aflæsninger eller ingen aflæsning >90 dage ──
router.get('/anomalier', async (req, res, next) => {
  try {
    const flagget = await query(`
      SELECT a.*, m.maalernummer, ku.navn AS kunde_navn
      FROM aflaesninger a
      JOIN vandmaalere m ON m.id = a.maaler_id
      LEFT JOIN kontrakter k ON k.id = m.kontrakt_id
      LEFT JOIN kunder ku ON ku.id = k.kunde_id
      WHERE a.validering = 'flagget'
      ORDER BY a.dato DESC LIMIT 50
    `);
    const manglende = await query(`
      SELECT m.id, m.maalernummer, m.fabrikat, m.installeret,
             (SELECT MAX(dato) FROM aflaesninger a WHERE a.maaler_id = m.id) AS sidste_dato,
             ku.navn AS kunde_navn
      FROM vandmaalere m
      LEFT JOIN kontrakter k ON k.id = m.kontrakt_id
      LEFT JOIN kunder ku ON ku.id = k.kunde_id
      WHERE m.status = 'aktiv'
        AND ((SELECT MAX(dato) FROM aflaesninger a WHERE a.maaler_id = m.id) IS NULL
          OR (SELECT MAX(dato) FROM aflaesninger a WHERE a.maaler_id = m.id) < CURRENT_DATE - 90)
      LIMIT 50
    `);
    res.json({ flagget, manglende });
  } catch (e) { next(e); }
});

module.exports = router;
