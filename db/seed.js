// Seed-data — kommuner, fraktioner, demo-prisblad og et par demo-kunder.
// Kører kun hvis tabellerne er tomme (idempotent).
module.exports = async function seed(pool) {
  // ── Fraktioner ──
  const fraktioner = [
    { id: 'rest',       navn: 'Restaffald',     ews_kode: '20.03.01', densitet: 0.150, farve: '#374151' },
    { id: 'mad',        navn: 'Madaffald',      ews_kode: '20.01.08', densitet: 0.500, farve: '#84cc16' },
    { id: 'papir',      navn: 'Papir/karton',   ews_kode: '20.01.01', densitet: 0.080, farve: '#3b82f6' },
    { id: 'glas',       navn: 'Glas',           ews_kode: '20.01.02', densitet: 0.300, farve: '#06b6d4' },
    { id: 'plast',      navn: 'Plast',          ews_kode: '20.01.39', densitet: 0.040, farve: '#f59e0b' },
    { id: 'metal',      navn: 'Metal',          ews_kode: '20.01.40', densitet: 0.150, farve: '#9ca3af' },
    { id: 'have',       navn: 'Haveaffald',     ews_kode: '20.02.01', densitet: 0.250, farve: '#10b981' },
    { id: 'farligt',    navn: 'Farligt affald', ews_kode: '20.01.13', densitet: 0.500, farve: '#ef4444' },
    { id: 'storskrald', navn: 'Storskrald',     ews_kode: '20.03.07', densitet: 0.200, farve: '#7c3aed' },
  ];
  for (const f of fraktioner) {
    await pool.query(
      `INSERT INTO fraktioner (id, navn, ews_kode, default_densitet, farve)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING`,
      [f.id, f.navn, f.ews_kode, f.densitet, f.farve]
    );
  }

  // ── Kommuner ──
  const kommuner = [
    { id: 'holstebro',  navn: 'Holstebro Kommune',  cvr: '29189927', ean: '5798003910314', email: 'renovation@holstebro.dk', telefon: '96 11 70 00' },
    { id: 'herning',    navn: 'Herning Kommune',    cvr: '29189919', ean: '5798003907413', email: 'affald@herning.dk',       telefon: '96 28 28 28' },
    { id: 'struer',     navn: 'Struer Kommune',     cvr: '29189951', ean: '5798003915715', email: 'renovation@struer.dk',    telefon: '96 84 84 84' },
  ];
  for (const k of kommuner) {
    await pool.query(
      `INSERT INTO kommuner (id, navn, cvr, ean, email, telefon)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING`,
      [k.id, k.navn, k.cvr, k.ean, k.email, k.telefon]
    );
  }

  // ── Stop hvis der allerede er data ──
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM kunder`);
  if (rows[0].n > 0) return;

  // ── Prisblad: Holstebro 2026 ──
  const prisbladId = 'PB-HOLST-2026';
  await pool.query(
    `INSERT INTO prisblade (id, service_type, kommune_id, version, gyldig_fra, gyldig_til, status, godkendt_af, godkendt_dato)
     VALUES ($1,'renovation','holstebro','2026.01','2026-01-01','2026-12-31','aktiv','Byrådet',now())
     ON CONFLICT (id) DO NOTHING`, [prisbladId]
  );
  const linjer = [
    // Grundgebyr (kr/år)
    { type: 'grundgebyr', noegle: 'husstand',           beskr: 'Grundgebyr husstand (administration, genbrugsplads, farligt affald)', pris: 1850.00, enhed: 'år' },
    { type: 'grundgebyr', noegle: 'erhverv-lille',      beskr: 'Grundgebyr lille erhverv',                                            pris: 2800.00, enhed: 'år' },
    // Tømningspriser pr. tømning, fraktion-volumen-frekvens
    { type: 'tomning', noegle: 'rest-140l-14d',  beskr: 'Restaffald 140L 14-dages',  pris: 38.00, enhed: 'tømning' },
    { type: 'tomning', noegle: 'rest-240l-14d',  beskr: 'Restaffald 240L 14-dages',  pris: 56.00, enhed: 'tømning' },
    { type: 'tomning', noegle: 'rest-660l-7d',   beskr: 'Restaffald 660L ugentlig',  pris: 142.00, enhed: 'tømning' },
    { type: 'tomning', noegle: 'mad-140l-14d',   beskr: 'Madaffald 140L 14-dages',   pris: 32.00, enhed: 'tømning' },
    { type: 'tomning', noegle: 'mad-240l-14d',   beskr: 'Madaffald 240L 14-dages',   pris: 48.00, enhed: 'tømning' },
    { type: 'tomning', noegle: 'papir-240l-28d', beskr: 'Papir 240L 4-ugers',        pris: 28.00, enhed: 'tømning' },
    { type: 'tomning', noegle: 'glas-240l-28d',  beskr: 'Glas 240L 4-ugers',         pris: 32.00, enhed: 'tømning' },
    { type: 'tomning', noegle: 'plast-240l-28d', beskr: 'Plast 240L 4-ugers',        pris: 30.00, enhed: 'tømning' },
    // Tillægsydelser
    { type: 'tillaeg', noegle: 'ekstratomning', beskr: 'Ekstra tømning udenfor tur', pris: 250.00, enhed: 'stk' },
    { type: 'tillaeg', noegle: 'beholderbytte', beskr: 'Bytte af beholder',          pris: 350.00, enhed: 'stk' },
  ];
  for (const l of linjer) {
    await pool.query(
      `INSERT INTO prisblad_linjer (prisblad_id, type, noegle, beskrivelse, enhedspris, enhed)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
      [prisbladId, l.type, l.noegle, l.beskr, l.pris, l.enhed]
    );
  }

  // ── Demo-kunder, ejendomme, kontrakter, beholdere, tømninger ──
  const demo = [
    {
      kunde: { id: 'KU-DEMO01', type: 'privat', navn: 'Anders Madsen',   cpr: '120580-XXXX', email: 'anders@example.dk', telefon: '20 12 34 56', faktura_kanal: 'eboks', pbs_aktiv: true },
      ejendom: { id: 'EJ-DEMO01', vejnavn: 'Ringkøbingvej', husnr: '12',  postnr: '7500', by: 'Holstebro', kommune_id: 'holstebro', ejendomstype: 'Helårsbeboelse' },
      beholdere: [
        { id: 'BH-DEMO01', fraktion_id: 'rest',  volumen_l: 240, frekvens: '14d' },
        { id: 'BH-DEMO02', fraktion_id: 'mad',   volumen_l: 140, frekvens: '14d' },
        { id: 'BH-DEMO03', fraktion_id: 'papir', volumen_l: 240, frekvens: '28d' },
      ],
    },
    {
      kunde: { id: 'KU-DEMO02', type: 'privat', navn: 'Birgit Sørensen', cpr: '030776-XXXX', email: 'birgit@example.dk', telefon: '40 11 22 33', faktura_kanal: 'email' },
      ejendom: { id: 'EJ-DEMO02', vejnavn: 'Skolegade', husnr: '34', postnr: '7500', by: 'Holstebro', kommune_id: 'holstebro' },
      beholdere: [
        { id: 'BH-DEMO04', fraktion_id: 'rest', volumen_l: 140, frekvens: '14d' },
        { id: 'BH-DEMO05', fraktion_id: 'mad',  volumen_l: 140, frekvens: '14d' },
      ],
    },
    {
      kunde: { id: 'KU-DEMO03', type: 'erhverv', navn: 'Vestjyske Bager ApS', cvr: '12345678', ean: '5790000123456', email: 'kontakt@vbager.dk', telefon: '97 41 23 45', faktura_kanal: 'oioubl' },
      ejendom: { id: 'EJ-DEMO03', vejnavn: 'Industrivej', husnr: '8', postnr: '7500', by: 'Holstebro', kommune_id: 'holstebro', ejendomstype: 'Erhverv' },
      beholdere: [
        { id: 'BH-DEMO06', fraktion_id: 'rest',  volumen_l: 660, frekvens: '7d' },
        { id: 'BH-DEMO07', fraktion_id: 'papir', volumen_l: 240, frekvens: '28d' },
        { id: 'BH-DEMO08', fraktion_id: 'glas',  volumen_l: 240, frekvens: '28d' },
      ],
    },
  ];

  let kontraktNr = 1;
  for (const d of demo) {
    await pool.query(
      `INSERT INTO kunder (id, type, navn, cpr, cvr, ean, email, telefon, faktura_kanal, pbs_aktiv)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING`,
      [d.kunde.id, d.kunde.type, d.kunde.navn, d.kunde.cpr || null, d.kunde.cvr || null, d.kunde.ean || null,
       d.kunde.email, d.kunde.telefon, d.kunde.faktura_kanal, d.kunde.pbs_aktiv || false]
    );
    await pool.query(
      `INSERT INTO ejendomme (id, vejnavn, husnr, postnr, by, kommune_id, ejendomstype)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
      [d.ejendom.id, d.ejendom.vejnavn, d.ejendom.husnr, d.ejendom.postnr, d.ejendom.by, d.ejendom.kommune_id, d.ejendom.ejendomstype || 'Helårsbeboelse']
    );
    const koId = `KO-DEMO0${kontraktNr++}`;
    await pool.query(
      `INSERT INTO kontrakter (id, service_type, kunde_id, ejendom_id, start_dato, status)
       VALUES ($1,'renovation',$2,$3,'2024-01-01','aktiv') ON CONFLICT (id) DO NOTHING`,
      [koId, d.kunde.id, d.ejendom.id]
    );
    for (const b of d.beholdere) {
      await pool.query(
        `INSERT INTO beholdere (id, kontrakt_id, fraktion_id, volumen_l, frekvens, status)
         VALUES ($1,$2,$3,$4,$5,'aktiv') ON CONFLICT (id) DO NOTHING`,
        [b.id, koId, b.fraktion_id, b.volumen_l, b.frekvens]
      );
      // Generér 3 historiske tømninger pr. beholder.
      const dage = b.frekvens === '7d' ? 7 : b.frekvens === '14d' ? 14 : 28;
      const today = new Date();
      const densitet = (fraktioner.find(f => f.id === b.fraktion_id) || {}).densitet || 0.1;
      for (let i = 1; i <= 3; i++) {
        const dt = new Date(today.getTime() - i * dage * 86400000).toISOString().slice(0, 10);
        const tomningId = `TM-${b.id.slice(3)}-${i}`;
        const vaegt = (b.volumen_l * densitet * (0.7 + Math.random() * 0.3)).toFixed(2);
        await pool.query(
          `INSERT INTO tomninger (id, beholder_id, tomning_dato, vaegt_kg, vaegt_estimeret, kilde)
           VALUES ($1,$2,$3,$4,TRUE,'driftssystem') ON CONFLICT (id) DO NOTHING`,
          [tomningId, b.id, dt, vaegt]
        );
      }
    }
  }

  // En åben sag på første kunde.
  await pool.query(
    `INSERT INTO sager (id, domain, kategori, prioritet, titel, beskrivelse, kunde_id, ejendom_id, kontrakt_id, ansvarlig)
     VALUES ('SAG-DEMO01','renovation','manglende_tomning','normal',
             'Restaffald ikke tømt fredag','Borger melder at restaffaldsbeholder ikke blev tømt på den planlagte dato.',
             'KU-DEMO01','EJ-DEMO01','KO-DEMO01','Support')
     ON CONFLICT (id) DO NOTHING`
  );
};
