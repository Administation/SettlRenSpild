// Webhook-modtager fra eksterne driftssystemer (RenoWeb, Ivar, Ambitek, m.fl.)
// Auth: Bearer token via env-var. Idempotens via tomninger.external_ref.
// Alle events logges i webhook_log for audit og debug.
const express = require('express');
const router = express.Router();
const { query, one, pool } = require('../db');
const providers = require('../lib/webhook-providers');

function genTomningId() {
  return 'TM-' + Math.random().toString(36).slice(2, 8).toUpperCase();
}

// Verificér Bearer-token. Bruger env-var WEBHOOK_TOKEN_<PROVIDER> hvis sat,
// ellers fælles WEBHOOK_TOKEN. Hvis ingen token er sat → afvis (fail-secure).
function verifyToken(provider, req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const expected =
    process.env[`WEBHOOK_TOKEN_${provider.toUpperCase()}`] ||
    process.env.WEBHOOK_TOKEN;
  if (!expected) return { ok: false, reason: 'no_token_configured' };
  if (!token || token !== expected) return { ok: false, reason: 'invalid_token' };
  return { ok: true };
}

// Tømnings-webhook: POST /api/renovation/webhook/tomning/:provider
// Kan modtage enten ét enkelt event eller en array af events.
router.post('/tomning/:provider', async (req, res, next) => {
  const provider = (req.params.provider || '').toLowerCase();
  const adapter = providers[provider];
  if (!adapter) return res.status(404).json({ error: `Unknown provider: ${provider}` });

  const auth = verifyToken(provider, req);
  if (!auth.ok) return res.status(401).json({ error: 'Unauthorized', reason: auth.reason });

  const events = Array.isArray(req.body) ? req.body : [req.body];
  const results = [];

  for (const payload of events) {
    let parsed;
    try { parsed = adapter.parseTomning(payload); }
    catch (e) { results.push({ status: 'fejl', fejl: 'Parse error: ' + e.message }); continue; }

    if (!parsed.external_id) { results.push({ status: 'fejl', fejl: 'external_id mangler' }); continue; }
    if (!parsed.beholder_id) { results.push({ status: 'fejl', fejl: 'beholder_id mangler' }); continue; }

    const externalRef = `${provider}:${parsed.external_id}`;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Log alle indkomne events. UNIQUE(provider, external_id) sikrer dedup.
      const logRes = await client.query(
        `INSERT INTO webhook_log (provider, event_type, external_id, payload)
         VALUES ($1,'tomning',$2,$3::jsonb)
         ON CONFLICT (provider, external_id) DO NOTHING
         RETURNING id`,
        [provider, parsed.external_id, JSON.stringify(payload)]
      );
      if (!logRes.rows.length) {
        await client.query('COMMIT');
        results.push({ status: 'ignoreret', reason: 'duplicate', external_id: parsed.external_id });
        continue;
      }
      const logId = logRes.rows[0].id;

      // Verificér beholder findes.
      const beh = (await client.query(`SELECT b.*, f.default_densitet FROM beholdere b JOIN fraktioner f ON f.id = b.fraktion_id WHERE b.id = $1`, [parsed.beholder_id])).rows[0];
      if (!beh) {
        await client.query(
          `UPDATE webhook_log SET status = 'fejl', fejl = $1, behandlet = now() WHERE id = $2`,
          [`Ukendt beholder: ${parsed.beholder_id}`, logId]
        );
        await client.query('COMMIT');
        results.push({ status: 'fejl', fejl: 'unknown_beholder', external_id: parsed.external_id });
        continue;
      }

      // Estimér vægt hvis ikke oplyst.
      let vaegt = parsed.vaegt_kg;
      let estimeret = parsed.vaegt_estimeret;
      if (vaegt == null) {
        vaegt = (Number(beh.volumen_l) * Number(beh.default_densitet || 0.1)).toFixed(2);
        estimeret = true;
      }

      // Opret tomning. Idempotens via UNIQUE(external_ref).
      const tId = genTomningId();
      const ins = await client.query(
        `INSERT INTO tomninger (id, beholder_id, tomning_dato, tomning_tid, vaegt_kg, vaegt_estimeret,
           undtagelseskode, chauffoer, rute, gps_lat, gps_lon, foto_url, kilde, external_ref)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'driftssystem',$13)
         ON CONFLICT (external_ref) WHERE external_ref IS NOT NULL DO NOTHING
         RETURNING id`,
        [tId, parsed.beholder_id, parsed.tomning_dato, parsed.tomning_tid, vaegt, estimeret,
         parsed.undtagelseskode, parsed.chauffoer, parsed.rute, parsed.gps_lat, parsed.gps_lon, parsed.foto_url, externalRef]
      );
      const insertedId = ins.rows[0]?.id;

      await client.query(
        `UPDATE webhook_log SET status = 'behandlet', resultat_id = $1, behandlet = now() WHERE id = $2`,
        [insertedId || tId, logId]
      );

      await client.query('COMMIT');
      results.push({ status: 'behandlet', tomning_id: insertedId || tId, external_id: parsed.external_id });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      // Forsøg at logge fejlen alligevel.
      await pool.query(
        `UPDATE webhook_log SET status = 'fejl', fejl = $1, behandlet = now()
         WHERE provider = $2 AND external_id = $3`,
        [e.message, provider, parsed.external_id]
      ).catch(() => {});
      results.push({ status: 'fejl', fejl: e.message, external_id: parsed.external_id });
    } finally {
      client.release();
    }
  }

  // 200 hvis mindst ét lykkedes, 207 hvis blandet, 400 hvis alle fejlede.
  const success = results.filter(r => r.status === 'behandlet' || r.status === 'ignoreret').length;
  const code = success === results.length ? 200 : success === 0 ? 400 : 207;
  res.status(code).json({ received: events.length, results });
});

// Liste over webhook-events til admin-UI.
router.get('/log', async (req, res, next) => {
  try {
    const { provider, status, limit = 100, offset = 0 } = req.query;
    const where = [];
    const params = [];
    if (provider) { params.push(provider); where.push(`provider = $${params.length}`); }
    if (status)   { params.push(status);   where.push(`status   = $${params.length}`); }
    params.push(parseInt(limit, 10), parseInt(offset, 10));
    const rows = await query(`
      SELECT * FROM webhook_log
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY modtaget DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params);
    const total = await one(`
      SELECT COUNT(*)::int AS n FROM webhook_log
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    `, params.slice(0, -2));
    res.json({ rows, total: total.n });
  } catch (e) { next(e); }
});

router.get('/log/:id', async (req, res, next) => {
  try {
    const r = await one(`SELECT * FROM webhook_log WHERE id = $1`, [req.params.id]);
    if (!r) return res.status(404).json({ error: 'Ikke fundet' });
    res.json(r);
  } catch (e) { next(e); }
});

// Re-process et fejlet event (admin-handling).
router.post('/log/:id/genprocess', async (req, res, next) => {
  try {
    const r = await one(`SELECT * FROM webhook_log WHERE id = $1`, [req.params.id]);
    if (!r) return res.status(404).json({ error: 'Ikke fundet' });
    // Mark som "modtaget" så reprocesseringen kan ske via samme path.
    await pool.query(`UPDATE webhook_log SET status = 'modtaget', fejl = NULL WHERE id = $1`, [req.params.id]);
    res.json({ ok: true, hint: 'Genindsend payloaden til /api/renovation/webhook/tomning/' + r.provider });
  } catch (e) { next(e); }
});

module.exports = router;
