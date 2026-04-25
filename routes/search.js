// Global søgning til topbar type-ahead.
// Søger på tværs af kunder, ejendomme, kontrakter, fakturaer og sager.
// Bruger pg_trgm for hurtig fuzzy match — limiteret til 10 hits pr. type.
const express = require('express');
const router = express.Router();
const { query } = require('../db');

router.get('/', async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    if (q.length < 2) return res.json({ kunder: [], ejendomme: [], kontrakter: [], fakturaer: [], sager: [] });

    const limit = Math.min(10, parseInt(req.query.limit, 10) || 5);
    const like = `%${q}%`;
    const prefix = `${q.toLowerCase()}%`;

    const [kunder, ejendomme, kontrakter, fakturaer, sager] = await Promise.all([
      query(`
        SELECT id, navn, type, cvr, email
        FROM kunder
        WHERE navn ILIKE $1 OR LOWER(id) LIKE $2 OR cvr LIKE $2 OR cpr LIKE $2 OR email ILIKE $1
        ORDER BY similarity(navn, $3) DESC NULLS LAST
        LIMIT ${limit}
      `, [like, prefix, q]),
      query(`
        SELECT id, vejnavn, husnr, postnr, by
        FROM ejendomme
        WHERE vejnavn ILIKE $1 OR by ILIKE $1 OR postnr LIKE $2
        ORDER BY similarity(vejnavn, $3) DESC NULLS LAST
        LIMIT ${limit}
      `, [like, prefix, q]),
      query(`
        SELECT k.id, k.service_type, k.status, ku.navn AS kunde_navn
        FROM kontrakter k JOIN kunder ku ON ku.id = k.kunde_id
        WHERE k.id ILIKE $1
        LIMIT ${limit}
      `, [like]),
      query(`
        SELECT f.id, f.fakturanr, f.status, f.belob_incl, ku.navn AS kunde_navn
        FROM fakturaer f JOIN kunder ku ON ku.id = f.kunde_id
        WHERE f.id ILIKE $1 OR CAST(f.fakturanr AS TEXT) ILIKE $1 OR ku.navn ILIKE $1
        ORDER BY f.fakturadato DESC
        LIMIT ${limit}
      `, [like]),
      query(`
        SELECT s.id, s.titel, s.status, s.prioritet, s.domain, ku.navn AS kunde_navn
        FROM sager s LEFT JOIN kunder ku ON ku.id = s.kunde_id
        WHERE s.titel ILIKE $1 OR s.id ILIKE $1
        ORDER BY similarity(s.titel, $2) DESC NULLS LAST
        LIMIT ${limit}
      `, [like, q]),
    ]);

    res.json({ kunder, ejendomme, kontrakter, fakturaer, sager });
  } catch (e) { next(e); }
});

module.exports = router;
