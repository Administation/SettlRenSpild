// Vercel serverless entry — wrapper omkring Express-appen.
// Kører schema- og seed-init én gang per cold start.
require('dotenv').config({ override: true });

const path = require('path');
const express = require('express');
const cors = require('cors');

const { init } = require('../db');

const app = express();

app.use(cors());
app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Sørg for DB er klar før hver request. init() er memoiseret.
app.use(async (req, res, next) => {
  try {
    await init();
    next();
  } catch (e) {
    console.error('DB init fejlede:', e);
    res.status(500).json({ error: 'Database initialization failed', detail: e.message });
  }
});

// Core routes — fælles for alle service-typer.
app.use('/api/search', require('../routes/search'));
app.use('/api/kunder', require('../routes/kunder'));
app.use('/api/ejendomme', require('../routes/ejendomme'));
app.use('/api/kontrakter', require('../routes/kontrakter'));
app.use('/api/kommuner', require('../routes/kommuner'));
app.use('/api/prisblade', require('../routes/prisblade'));
app.use('/api/fakturaer', require('../routes/fakturaer'));
app.use('/api/betalinger', require('../routes/betalinger'));
app.use('/api/sager', require('../routes/sager'));
app.use('/api/dashboard', require('../routes/dashboard'));

// Renovation domæne-routes.
app.use('/api/renovation/webhook', require('../routes/webhook'));
app.use('/api/renovation/fraktioner', require('../routes/fraktioner'));
app.use('/api/renovation/beholdere', require('../routes/beholdere'));
app.use('/api/renovation/tomninger', require('../routes/tomninger'));
app.use('/api/renovation/ads', require('../routes/ads'));

// Spildevand domæne-routes — placeholder for fremtidig udvidelse.
// app.use('/api/spildevand/maalere', require('../routes/maalere'));
// app.use('/api/spildevand/aflaesninger', require('../routes/aflaesninger'));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, app: 'SettlRenSpild', version: require('../package.json').version });
});

// SPA-fallback — alt der ikke er API serverer index.html.
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error', detail: err.message });
});

// Lokal udvikling: lyt på port. På Vercel bruges module.exports = app i stedet.
if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`SettlRenSpild kører på http://localhost:${port}`));
}

module.exports = app;
