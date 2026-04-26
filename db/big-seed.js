// Big seed — 100 kunder med kontrakter for renovation og/eller spildevand,
// målere, aflæsninger, fakturaer i forskellige statusser, samtykker, sager.
// Idempotent: kører kun hvis kunde-id 'KU-BIG-001' ikke findes.
//
// Domæne-fordeling: 40% kun renovation · 30% kun spildevand · 30% begge.
module.exports = async function bigSeed(pool) {
  const exists = await pool.query(`SELECT 1 FROM kunder WHERE id = 'KU-BIG-001' LIMIT 1`);
  if (exists.rows.length) return;
  console.log('[seed] Genererer 100-kunde test-data (begge domæner)...');

  // Spildevand-prisblad for Holstebro 2026 — opret hvis ikke findes.
  await pool.query(
    `INSERT INTO prisblade (id, service_type, kommune_id, version, gyldig_fra, gyldig_til, status, godkendt_af, godkendt_dato)
     VALUES ('PB-SPILD-HOLST-2026','spildevand','holstebro','2026.01','2026-01-01','2026-12-31','aktiv','Byrådet', now())
     ON CONFLICT (id) DO NOTHING`
  );
  const spildLinjer = [
    { type: 'fast_aar',       noegle: 'husstand',         beskr: 'Fast årligt spildevandsgebyr (administration)', pris: 625.00, enhed: 'år' },
    { type: 'vandafledning',  noegle: 'm3',               beskr: 'Vandafledningsbidrag pr. m³',                    pris: 28.45, enhed: 'm³' },
    { type: 'statsafgift',    noegle: 'm3',               beskr: 'Statsafgift på spildevand',                       pris: 8.98,  enhed: 'm³' },
    { type: 'tilslutning',    noegle: 'engangs',          beskr: 'Tilslutningsbidrag (engangsgebyr)',               pris: 42500.00, enhed: 'stk' },
    { type: 'saerbidrag',     noegle: 'erhverv-promille', beskr: 'Særbidrag erhverv >0,5‰ kvælstof',                pris: 15.00, enhed: 'm³' },
  ];
  for (const l of spildLinjer) {
    await pool.query(
      `INSERT INTO prisblad_linjer (prisblad_id, type, noegle, beskrivelse, enhedspris, enhed)
       VALUES ('PB-SPILD-HOLST-2026',$1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [l.type, l.noegle, l.beskr, l.pris, l.enhed]
    );
  }
  // Tilsvarende for Herning og Struer (samme priser, demo-niveau).
  for (const kom of ['herning','struer']) {
    const id = `PB-SPILD-${kom.toUpperCase()}-2026`;
    await pool.query(
      `INSERT INTO prisblade (id, service_type, kommune_id, version, gyldig_fra, gyldig_til, status, godkendt_af, godkendt_dato)
       VALUES ($1,'spildevand',$2,'2026.01','2026-01-01','2026-12-31','aktiv','Byrådet', now())
       ON CONFLICT (id) DO NOTHING`, [id, kom]
    );
    for (const l of spildLinjer) {
      await pool.query(
        `INSERT INTO prisblad_linjer (prisblad_id, type, noegle, beskrivelse, enhedspris, enhed)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
        [id, l.type, l.noegle, l.beskr, l.pris, l.enhed]
      );
    }
  }

  const fornavne = ['Anders','Mette','Lars','Birgit','Kasper','Linda','Mads','Sofie','Peter','Anna','Niels','Karen','Erik','Hanne','Henrik','Susanne','Jan','Lone','Kim','Britta','Søren','Inge','Michael','Tina','Jens','Pia','Bo','Camilla','David','Eva','Frederik','Gitte','Hans','Ida','Jacob','Kirsten','Lise','Morten','Nina','Ole','Pernille','Rasmus','Sabrina','Thomas','Ulla','Vibeke','Werner','Yrsa','Zenia'];
  const efternavne = ['Hansen','Jensen','Nielsen','Pedersen','Andersen','Christensen','Larsen','Sørensen','Rasmussen','Jørgensen','Petersen','Madsen','Kristensen','Olsen','Thomsen','Christiansen','Poulsen','Johansen','Møller','Mortensen','Knudsen','Holm','Bach','Lund','Riis','Frederiksen','Iversen','Dahl','Berg','Skov'];
  const veje = ['Bredgade','Nørregade','Søndergade','Østergade','Vestergade','Skolegade','Kirkevej','Hovedgaden','Solvej','Engvej','Skovvej','Bakkevej','Birkevej','Rosenvej','Hjaltevej','Ringkøbingvej','Industrivej','Stationsvej','Mosevej','Lindevej','Markvænget','Fjordvej','Ahornvej','Egevej','Bøgevej'];
  const byer = [
    { kom: 'holstebro', postnr: '7500', by: 'Holstebro' },
    { kom: 'holstebro', postnr: '7560', by: 'Hjerm' },
    { kom: 'herning',   postnr: '7400', by: 'Herning' },
    { kom: 'herning',   postnr: '7430', by: 'Ikast' },
    { kom: 'struer',    postnr: '7600', by: 'Struer' },
  ];
  const fraktioner = [
    { id: 'rest',  vol: [140, 240, 660, 1100], frek: ['7d', '14d'] },
    { id: 'mad',   vol: [140, 240], frek: ['14d'] },
    { id: 'papir', vol: [240, 660], frek: ['28d'] },
    { id: 'glas',  vol: [240], frek: ['28d'] },
    { id: 'plast', vol: [240], frek: ['28d'] },
  ];

  // Hent fraktion-densiteter til vægt-estimering.
  const fr = await pool.query(`SELECT id, default_densitet FROM fraktioner`);
  const densitet = Object.fromEntries(fr.rows.map(r => [r.id, Number(r.default_densitet || 0.1)]));

  function rand(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
  function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
  function pad(n, w) { return String(n).padStart(w, '0'); }

  const today = new Date();
  let kontraktNr = 1, beholderNr = 1, maalerNr = 1, fakturaCount = 0;
  const bulkInserts = [];

  for (let i = 1; i <= 100; i++) {
    const kundeId = `KU-BIG-${pad(i, 3)}`;
    const r = Math.random();
    const type = r < 0.7 ? 'privat' : r < 0.92 ? 'erhverv' : 'forening';
    const navn = type === 'erhverv'
      ? `${rand(['Vestjyske','Nordjyske','Ringkøbing','Holstebro','Herning'])} ${rand(['Bager','Café','Service','Værksted','Klinik','Apotek','Fitness'])} ${rand(['ApS','A/S','I/S'])}`
      : type === 'forening' ? `AB ${rand(['Solgården','Bakkely','Birkevænget','Engparken','Skovgården'])}`
      : `${rand(fornavne)} ${rand(efternavne)}`;
    const cvr = type !== 'privat' ? String(10000000 + randInt(1, 89999999)) : null;
    const cpr = type === 'privat' ? `${pad(randInt(1, 28), 2)}${pad(randInt(1, 12), 2)}${randInt(40, 99)}-XXXX` : null;
    const ean = type === 'erhverv' && Math.random() < 0.6 ? '5790000' + pad(randInt(100000, 999999), 6) : null;
    const fakturaKanal = ean ? 'oioubl' : type === 'erhverv' ? 'email' : Math.random() < 0.7 ? 'eboks' : 'email';
    const pbsAktiv = type === 'privat' && Math.random() < 0.45;
    const status = Math.random() < 0.97 ? 'aktiv' : Math.random() < 0.5 ? 'spaerret' : 'lukket';
    await pool.query(
      `INSERT INTO kunder (id, type, navn, cpr, cvr, ean, email, telefon, faktura_kanal, pbs_aktiv, pbs_pbsnr, pbs_debgr, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (id) DO NOTHING`,
      [kundeId, type, navn, cpr, cvr, ean,
       `${navn.toLowerCase().split(' ')[0]}.${i}@example.dk`,
       `${randInt(20, 50)} ${pad(randInt(0, 99), 2)} ${pad(randInt(0, 99), 2)} ${pad(randInt(0, 99), 2)}`,
       fakturaKanal, pbsAktiv,
       pbsAktiv ? String(10000000 + randInt(1, 89999999)) : null,
       pbsAktiv ? pad(randInt(1, 99), 2) : null,
       status]
    );

    // Ejendom + adresse
    const ejId = `EJ-BIG-${pad(i, 3)}`;
    const sted = rand(byer);
    await pool.query(
      `INSERT INTO ejendomme (id, vejnavn, husnr, postnr, by, kommune_id, ejendomstype, bbr_id, bfe_nr)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
      [ejId, rand(veje), String(randInt(1, 200)), sted.postnr, sted.by, sted.kom,
       type === 'erhverv' ? 'Erhverv' : type === 'forening' ? 'Etagebolig' : 'Helårsbeboelse',
       'BBR-BIG-' + pad(i, 3), pad(2000000 + i, 7)]
    );

    // Domæne-fordeling: 40% renov, 30% spild, 30% begge
    const dom = Math.random();
    const harRenov = dom < 0.7;
    const harSpild = dom >= 0.4;

    // ──── Renovation-kontrakt + beholdere + tomninger ────
    if (harRenov) {
      const koId = `KO-RENO-${pad(kontraktNr++, 4)}`;
      await pool.query(
        `INSERT INTO kontrakter (id, service_type, kunde_id, ejendom_id, start_dato, status)
         VALUES ($1,'renovation',$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING`,
        [koId, kundeId, ejId,
         `2024-${pad(randInt(1, 12), 2)}-01`,
         status === 'aktiv' ? 'aktiv' : 'opsagt']
      );
      // 2-4 beholdere
      const antalBeh = type === 'erhverv' ? 3 : type === 'forening' ? 4 : randInt(2, 3);
      const fraktionerValgt = ['rest','mad'].concat(antalBeh > 2 ? ['papir'] : []).concat(antalBeh > 3 ? ['glas'] : []);
      for (let b = 0; b < fraktionerValgt.length; b++) {
        const f = fraktionerValgt[b];
        const def = fraktioner.find(x => x.id === f);
        const vol = type === 'erhverv' ? rand([660, 1100]) : rand(def.vol.filter(v => v <= 240));
        const frek = type === 'erhverv' ? '7d' : rand(def.frek);
        const behId = `BH-BIG-${pad(beholderNr++, 5)}`;
        await pool.query(
          `INSERT INTO beholdere (id, kontrakt_id, fraktion_id, volumen_l, frekvens, rfid, status)
           VALUES ($1,$2,$3,$4,$5,$6,'aktiv') ON CONFLICT (id) DO NOTHING`,
          [behId, koId, f, vol, frek, 'RFID-' + behId]
        );
        // 6-12 historiske tomninger
        const dage = frek === '7d' ? 7 : frek === '14d' ? 14 : 28;
        const antalT = frek === '7d' ? 12 : 6;
        for (let t = 1; t <= antalT; t++) {
          const dt = new Date(today.getTime() - t * dage * 86400000).toISOString().slice(0, 10);
          const baseV = vol * (densitet[f] || 0.1);
          const v = (baseV * (0.7 + Math.random() * 0.4)).toFixed(2);
          const undt = (Math.random() < 0.05) ? 'overfyldt' : (Math.random() < 0.02 ? 'ikke_fremstillet' : null);
          await pool.query(
            `INSERT INTO tomninger (id, beholder_id, tomning_dato, vaegt_kg, vaegt_estimeret, undtagelseskode, kilde, chauffoer)
             VALUES ($1,$2,$3,$4,TRUE,$5,'driftssystem','DRV-' || $6::int)
             ON CONFLICT (id) DO NOTHING`,
            [`TM-BIG-${behId.slice(7)}-${t}`, behId, dt, v, undt, randInt(1, 9)]
          );
        }
      }
    }

    // ──── Spildevand-kontrakt + måler + aflæsninger ────
    if (harSpild) {
      const koId = `KO-SPILD-${pad(kontraktNr++, 4)}`;
      await pool.query(
        `INSERT INTO kontrakter (id, service_type, kunde_id, ejendom_id, start_dato, status)
         VALUES ($1,'spildevand',$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING`,
        [koId, kundeId, ejId,
         `2024-${pad(randInt(1, 12), 2)}-01`,
         status === 'aktiv' ? 'aktiv' : 'opsagt']
      );
      // Hovedmåler
      const maalerId = `VM-BIG-${pad(maalerNr++, 5)}`;
      const fjernaflaest = Math.random() < 0.4;
      const fabrikat = rand(['Kamstrup','Diehl','Sensus','Itron']);
      await pool.query(
        `INSERT INTO vandmaalere (id, ejendom_id, kontrakt_id, maalernummer, fabrikat, type, dimension, installeret, fjernaflaest, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'aktiv') ON CONFLICT (id) DO NOTHING`,
        [maalerId, ejId, koId,
         pad(80000000 + maalerNr, 8),
         fabrikat, fjernaflaest ? 'smart' : 'mekanisk', 'qn2.5',
         '2022-01-15', fjernaflaest]
      );
      // Aflæsninger over de sidste 24 måneder, ca. en pr. kvartal/måned
      const aarsforbrug = type === 'erhverv' ? randInt(800, 5000) : type === 'forening' ? randInt(2000, 8000) : randInt(80, 280);
      let standM3 = randInt(0, 50);
      const interval = fjernaflaest ? 30 : 90; // smart: månedlig, manuel: kvartalsvis
      for (let m = 24; m >= 0; m--) {
        const dt = new Date(today.getTime() - m * interval * 86400000 / (interval / 30)).toISOString().slice(0, 10);
        const tilfoerelse = (aarsforbrug / 365) * interval * (0.85 + Math.random() * 0.3);
        standM3 += tilfoerelse;
        // Ca. 5% chance for anomali (lækage)
        const anomali = Math.random() < 0.05;
        if (anomali && m > 5) standM3 += tilfoerelse * 4; // simulér lækage
        await pool.query(
          `INSERT INTO aflaesninger (maaler_id, dato, stand_m3, kilde, validering, noter)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT DO NOTHING`,
          [maalerId, dt, standM3.toFixed(3),
           fjernaflaest ? 'fjernaflaest' : 'manuel',
           anomali ? 'flagget' : 'gyldig',
           anomali ? '[Auto] Stort forbrug — mulig lækage?' : null]
        );
      }
      // Aconto-plan for 2026
      if (status === 'aktiv') {
        const fast = 625, va = 28.45, sa = 8.98;
        const estBelob = (va + sa) * aarsforbrug + fast;
        const aarsbelob = estBelob * 1.25;
        await pool.query(
          `INSERT INTO acontoplaner (id, kontrakt_id, aar, forventet_m3, estimeret_aarsbelob, rate_belob, antal_rater)
           VALUES ($1,$2,2026,$3,$4,$5,4) ON CONFLICT (kontrakt_id, aar) DO NOTHING`,
          [`AC-BIG-${pad(i, 3)}`, koId, aarsforbrug, aarsbelob.toFixed(2), (aarsbelob / 4).toFixed(2)]
        );
      }
    }

    // ──── Fakturaer ────
    // 3-6 fakturaer over de sidste 12 måneder, varieret status
    const fakturaerCount = type === 'erhverv' ? 6 : 4;
    for (let f = 1; f <= fakturaerCount; f++) {
      const fakturaId = `FA-BIG-${pad(i, 3)}-${f}`;
      const fnr = (await pool.query(`SELECT nextval('fakturanr_seq') AS n`)).rows[0].n;
      const monthsAgo = (fakturaerCount - f) * 3;
      const fakturadato = new Date(today.getFullYear(), today.getMonth() - monthsAgo, 1).toISOString().slice(0,10);
      const periodeFra = new Date(today.getFullYear(), today.getMonth() - monthsAgo - 3, 1).toISOString().slice(0,10);
      const periodeTil = new Date(today.getFullYear(), today.getMonth() - monthsAgo, 0).toISOString().slice(0,10);
      const forfaldsdato = new Date(today.getFullYear(), today.getMonth() - monthsAgo + 1, 1).toISOString().slice(0,10);

      // Determine service_type randomly fra hvad kunden har
      const svc = harRenov && harSpild ? rand(['renovation','spildevand']) : harRenov ? 'renovation' : 'spildevand';
      const belobExcl = svc === 'spildevand'
        ? (type === 'erhverv' ? randInt(2500, 8000) : randInt(800, 2500))
        : (type === 'erhverv' ? randInt(1500, 4500) : randInt(400, 1100));
      const moms = belobExcl * 0.25;
      const belobIncl = belobExcl + moms;

      // Status: ældre = oftere betalt, nyere = oftere åben
      let fStatus = 'kladde', betalt = 0;
      if (f === fakturaerCount) fStatus = 'kladde';
      else if (f === fakturaerCount - 1) {
        const r = Math.random();
        fStatus = r < 0.3 ? 'sendt' : r < 0.6 ? 'godkendt' : 'kladde';
      } else {
        const r = Math.random();
        if (r < 0.7) { fStatus = 'betalt'; betalt = belobIncl; }
        else if (r < 0.85) { fStatus = 'forfalden'; }
        else if (r < 0.95) { fStatus = 'rykker'; betalt = belobIncl * 0.3; }
        else { fStatus = 'krediteret'; }
      }
      await pool.query(
        `INSERT INTO fakturaer (id, fakturanr, service_type, kunde_id, ejendom_id, kommune_id,
          periode_fra, periode_til, fakturadato, forfaldsdato, status,
          belob_excl, moms, belob_incl, betalt_belob, faktura_kanal,
          sendt, betalt)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
           CASE WHEN $11 IN ('sendt','betalt','forfalden','rykker','krediteret') THEN $9::date + interval '1 day' ELSE NULL END,
           CASE WHEN $11 = 'betalt' THEN $10::date + interval '5 days' ELSE NULL END)
         ON CONFLICT (id) DO NOTHING`,
        [fakturaId, fnr, svc, kundeId, ejId, sted.kom,
         periodeFra, periodeTil, fakturadato, forfaldsdato, fStatus,
         belobExcl.toFixed(2), moms.toFixed(2), belobIncl.toFixed(2), betalt.toFixed(2),
         fakturaKanal]
      );
      fakturaCount++;
      // Indbetalinger ved betalt-status
      if (fStatus === 'betalt') {
        await pool.query(
          `INSERT INTO betalinger (faktura_id, belob, betalingsdato, metode, reference)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
          [fakturaId, belobIncl.toFixed(2),
           new Date(new Date(forfaldsdato).getTime() - randInt(1, 14) * 86400000).toISOString().slice(0,10),
           pbsAktiv ? 'pbs' : rand(['bankoverforsel','mobilepay','kort']),
           pbsAktiv ? 'PBS retur' : `IBAN ${pad(randInt(1000000000, 9999999999), 10)}`]
        );
      } else if (fStatus === 'rykker' && betalt > 0) {
        await pool.query(
          `INSERT INTO betalinger (faktura_id, belob, betalingsdato, metode, reference)
           VALUES ($1,$2,$3,'mobilepay','Delbetaling') ON CONFLICT DO NOTHING`,
          [fakturaId, betalt.toFixed(2),
           new Date(new Date(forfaldsdato).getTime() + 14 * 86400000).toISOString().slice(0,10)]
        );
      }
    }

    // ──── Sager (10% har en åben sag) ────
    if (Math.random() < 0.10) {
      const sagId = `SAG-BIG-${pad(i, 3)}`;
      const dom = harRenov && harSpild ? rand(['renovation','spildevand']) : harRenov ? 'renovation' : 'spildevand';
      const kategori = dom === 'renovation'
        ? rand(['manglende_tomning','beholder_skadet','fakturafejl','forkert_indhold'])
        : rand(['maaler_defekt','aflaesning_fejl','fakturafejl','laekage_mistanke']);
      const titel = dom === 'renovation' ? 'Manglende tømning' : 'Vandmåler-anomali';
      await pool.query(
        `INSERT INTO sager (id, domain, kategori, prioritet, status, titel, beskrivelse, kunde_id, ejendom_id, ansvarlig, sla_frist, oprettet)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Support', now() + interval '5 days', now() - (random() * 14)::int * interval '1 day')
         ON CONFLICT (id) DO NOTHING`,
        [sagId, dom, kategori, rand(['lav','normal','hoej']), rand(['aaben','igang','venter_kunde']),
         titel, `Auto-genereret ${dom}-sag for ${navn}`, kundeId, ejId]
      );
    }

    // ──── Samtykker ────
    const samtykkerData = [
      { type: 'fakturalevering', kanal: fakturaKanal, status: true },
      { type: 'driftspaamindelse', kanal: Math.random() < 0.5 ? 'sms' : 'email', status: Math.random() < 0.7 },
      { type: 'marketing', kanal: 'email', status: Math.random() < 0.3 },
    ];
    for (const s of samtykkerData) {
      await pool.query(
        `INSERT INTO samtykker (kunde_id, type, kanal, status) VALUES ($1,$2,$3,$4)
         ON CONFLICT (kunde_id, type, kanal) DO NOTHING`,
        [kundeId, s.type, s.kanal, s.status]
      );
    }

    if (i % 25 === 0) console.log(`[seed] ${i}/100 kunder...`);
  }
  console.log(`[seed] Big-seed færdig. ${fakturaCount} fakturaer oprettet.`);
};
