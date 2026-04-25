const express = require('express');
const router = express.Router();
const { query } = require('../db');

router.get('/', async (req, res, next) => {
  try { res.json(await query(`SELECT * FROM fraktioner ORDER BY navn`)); }
  catch (e) { next(e); }
});

module.exports = router;
