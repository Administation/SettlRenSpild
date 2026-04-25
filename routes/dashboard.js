const express = require('express');
const router = express.Router();
const { query, one } = require('../db');

router.get('/', async (req, res, next) => {
  try {
    const [kunder, kontrakter, abnetSager, ufaktureredeTomninger, kladdeFakturaer, restance] = await Promise.all([
      one(`SELECT COUNT(*)::int AS n FROM kunder WHERE status = 'aktiv'`),
      one(`SELECT
            COUNT(*)::int AS total,
            SUM(CASE WHEN service_type='renovation' THEN 1 ELSE 0 END)::int AS renovation,
            SUM(CASE WHEN service_type='spildevand' THEN 1 ELSE 0 END)::int AS spildevand
          FROM kontrakter WHERE status = 'aktiv'`),
      one(`SELECT COUNT(*)::int AS n FROM sager WHERE status IN ('aaben','igang','venter_kunde')`),
      one(`SELECT COUNT(*)::int AS n FROM tomninger WHERE faktureret = FALSE`),
      one(`SELECT COUNT(*)::int AS n, COALESCE(SUM(belob_incl),0)::numeric AS belob FROM fakturaer WHERE status = 'kladde'`),
      one(`SELECT COUNT(*)::int AS n,
                  COALESCE(SUM(belob_incl - betalt_belob),0)::numeric AS belob
           FROM fakturaer
           WHERE status IN ('sendt','forfalden','rykker','inddrivelse')
             AND forfaldsdato < CURRENT_DATE`),
    ]);

    const naesteFakturaer = await query(`
      SELECT f.id, f.fakturanr, f.belob_incl, f.fakturadato, f.status, k.navn AS kunde_navn
      FROM fakturaer f JOIN kunder k ON k.id = f.kunde_id
      ORDER BY f.fakturadato DESC LIMIT 10
    `);
    const sagerByKategori = await query(`
      SELECT kategori, COUNT(*)::int AS n FROM sager
      WHERE status IN ('aaben','igang','venter_kunde')
      GROUP BY kategori ORDER BY n DESC LIMIT 10
    `);

    res.json({
      kunder: kunder.n,
      kontrakter,
      abne_sager: abnetSager.n,
      ufakturerede_tomninger: ufaktureredeTomninger.n,
      kladde_fakturaer: kladdeFakturaer,
      restance,
      naeste_fakturaer: naesteFakturaer,
      sager_by_kategori: sagerByKategori,
    });
  } catch (e) { next(e); }
});

module.exports = router;
