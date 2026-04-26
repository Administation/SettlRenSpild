// Rich seed — opretter omfattende test-data så ALLE UCs kan demonstreres.
// Idempotent: kører kun hvis kunde-id 'KU-RICH01' ikke findes.
// Tilføjer:
//   • 5 nye kunder (privat/erhverv/forening/boligadministrator)
//   • Boligforening med flere ejendomme + boligadm-relationer
//   • Fuldmagt + samtykker
//   • Fakturaer i alle statusser (kladde/godkendt/sendt/betalt/forfalden/rykker/krediteret)
//   • Betalinger (fuld/delvis), kreditnota, betalingsaftale
//   • Genbrugsplads-besøg (privat gratis + erhverv betalt + anomali)
//   • Storskrald + farligt affald + haveaffald-abonnement
//   • Historisk prisblad 2025
//   • Webhook-events + ADS-indberetning + massevarsling
module.exports = async function richSeed(pool) {
  const exists = await pool.query(`SELECT 1 FROM kunder WHERE id = 'KU-RICH01' LIMIT 1`);
  if (exists.rows.length) return;
  console.log('[seed] Kører rich-seed med fuld test-data...');

  // ───── 1) Kunder (5 nye, forskellige typer/scenarier) ─────
  const kunder = [
    { id: 'KU-RICH01', type: 'privat', navn: 'Kasper Hansen', cpr: '150472-XXXX',
      email: 'kasper@example.dk', telefon: '22 11 33 44', faktura_kanal: 'eboks', pbs_aktiv: true, pbs_pbsnr: '12345678', pbs_debgr: '01' },
    { id: 'KU-RICH02', type: 'privat', navn: 'Linda Hansen', cpr: '230586-XXXX',
      email: 'linda@example.dk', telefon: '22 11 33 55', faktura_kanal: 'email', pbs_aktiv: false },
    { id: 'KU-RICH03', type: 'erhverv', navn: 'Holstebro Plejehjem ApS', cvr: '34567890', ean: '5790000234567',
      email: 'kontor@hplejehjem.dk', telefon: '97 41 88 88', faktura_kanal: 'oioubl' },
    { id: 'KU-RICH04', type: 'forening', navn: 'AB Solgården', cvr: '45678901',
      email: 'bestyrelse@solgaarden.dk', telefon: '97 41 22 22', faktura_kanal: 'email' },
    { id: 'KU-RICH05', type: 'erhverv', navn: 'Vest Boliger A/S (administrator)', cvr: '56789012', ean: '5790000345678',
      email: 'admin@vestboliger.dk', telefon: '97 41 99 99', faktura_kanal: 'oioubl' },
    { id: 'KU-RICH06', type: 'privat', navn: 'Mette Nielsen (forfalden)', cpr: '030480-XXXX',
      email: 'mette@example.dk', telefon: '22 33 44 55', faktura_kanal: 'eboks' },
  ];
  for (const k of kunder) {
    await pool.query(
      `INSERT INTO kunder (id, type, navn, cpr, cvr, ean, email, telefon, faktura_kanal, pbs_aktiv, pbs_pbsnr, pbs_debgr)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (id) DO NOTHING`,
      [k.id, k.type, k.navn, k.cpr || null, k.cvr || null, k.ean || null, k.email, k.telefon,
       k.faktura_kanal, k.pbs_aktiv || false, k.pbs_pbsnr || null, k.pbs_debgr || null]
    );
  }

  // ───── 2) Ejendomme ─────
  const ejendomme = [
    { id: 'EJ-RICH01', vejnavn: 'Bredgade',     husnr: '15',  postnr: '7500', by: 'Holstebro', kommune_id: 'holstebro', ejendomstype: 'Helårsbeboelse', bbr_id: 'BBR-RICH01', bfe_nr: '1234001' },
    { id: 'EJ-RICH02', vejnavn: 'Nørregade',    husnr: '8',   postnr: '7500', by: 'Holstebro', kommune_id: 'holstebro', ejendomstype: 'Erhverv',         bbr_id: 'BBR-RICH02', bfe_nr: '1234002' },
    { id: 'EJ-SOL-A',  vejnavn: 'Solvej',       husnr: '1A',  postnr: '7500', by: 'Holstebro', kommune_id: 'holstebro', ejendomstype: 'Etagebolig',      bbr_id: 'BBR-SOL-A',  bfe_nr: '1235001' },
    { id: 'EJ-SOL-B',  vejnavn: 'Solvej',       husnr: '1B',  postnr: '7500', by: 'Holstebro', kommune_id: 'holstebro', ejendomstype: 'Etagebolig',      bbr_id: 'BBR-SOL-B',  bfe_nr: '1235002' },
    { id: 'EJ-SOL-C',  vejnavn: 'Solvej',       husnr: '1C',  postnr: '7500', by: 'Holstebro', kommune_id: 'holstebro', ejendomstype: 'Etagebolig',      bbr_id: 'BBR-SOL-C',  bfe_nr: '1235003' },
    { id: 'EJ-RICH06', vejnavn: 'Hjaltevej',    husnr: '47',  postnr: '7500', by: 'Holstebro', kommune_id: 'holstebro', ejendomstype: 'Helårsbeboelse', bbr_id: 'BBR-RICH06', bfe_nr: '1234006' },
  ];
  for (const e of ejendomme) {
    await pool.query(
      `INSERT INTO ejendomme (id, vejnavn, husnr, postnr, by, kommune_id, ejendomstype, bbr_id, bfe_nr)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
      [e.id, e.vejnavn, e.husnr, e.postnr, e.by, e.kommune_id, e.ejendomstype, e.bbr_id, e.bfe_nr]
    );
  }

  // ───── 3) Kontrakter ─────
  const kontrakter = [
    { id: 'KO-RICH01', kunde_id: 'KU-RICH01', ejendom_id: 'EJ-RICH01', start: '2024-06-01' },
    { id: 'KO-RICH02', kunde_id: 'KU-RICH03', ejendom_id: 'EJ-RICH02', start: '2023-01-01' }, // Plejehjem
    { id: 'KO-SOL-A',  kunde_id: 'KU-RICH04', ejendom_id: 'EJ-SOL-A',  start: '2022-01-01' }, // Boligforening A
    { id: 'KO-SOL-B',  kunde_id: 'KU-RICH04', ejendom_id: 'EJ-SOL-B',  start: '2022-01-01' }, // Boligforening B
    { id: 'KO-SOL-C',  kunde_id: 'KU-RICH04', ejendom_id: 'EJ-SOL-C',  start: '2022-01-01' }, // Boligforening C
    { id: 'KO-RICH06', kunde_id: 'KU-RICH06', ejendom_id: 'EJ-RICH06', start: '2024-01-01' }, // Mette m. forfalden
  ];
  for (const k of kontrakter) {
    await pool.query(
      `INSERT INTO kontrakter (id, service_type, kunde_id, ejendom_id, start_dato, status)
       VALUES ($1,'renovation',$2,$3,$4,'aktiv') ON CONFLICT (id) DO NOTHING`,
      [k.id, k.kunde_id, k.ejendom_id, k.start]
    );
  }

  // ───── 4) Beholdere (varieret komposition) ─────
  const beholdere = [
    { id: 'BH-R01-R', kontrakt_id: 'KO-RICH01', fraktion: 'rest',  vol: 240, frek: '14d', rfid: 'RFID-R01-R' },
    { id: 'BH-R01-M', kontrakt_id: 'KO-RICH01', fraktion: 'mad',   vol: 140, frek: '14d', rfid: 'RFID-R01-M' },
    { id: 'BH-R01-P', kontrakt_id: 'KO-RICH01', fraktion: 'papir', vol: 240, frek: '28d', rfid: 'RFID-R01-P' },
    { id: 'BH-R02-R', kontrakt_id: 'KO-RICH02', fraktion: 'rest',  vol: 1100, frek: '7d', rfid: 'RFID-R02-R' }, // Plejehjem stor
    { id: 'BH-R02-M', kontrakt_id: 'KO-RICH02', fraktion: 'mad',   vol: 660, frek: '7d',  rfid: 'RFID-R02-M' },
    { id: 'BH-R02-P', kontrakt_id: 'KO-RICH02', fraktion: 'papir', vol: 660, frek: '14d', rfid: 'RFID-R02-P' },
    { id: 'BH-SOL-R', kontrakt_id: 'KO-SOL-A',  fraktion: 'rest',  vol: 4000, frek: '7d', rfid: 'RFID-SOL-R', faelles: true,  fordelingsnoegle: 0.3333 },
    { id: 'BH-SOL-M', kontrakt_id: 'KO-SOL-A',  fraktion: 'mad',   vol: 660,  frek: '7d', rfid: 'RFID-SOL-M', faelles: true,  fordelingsnoegle: 0.3333 },
    { id: 'BH-R06-R', kontrakt_id: 'KO-RICH06', fraktion: 'rest',  vol: 240,  frek: '14d', rfid: 'RFID-R06-R' },
    { id: 'BH-R06-M', kontrakt_id: 'KO-RICH06', fraktion: 'mad',   vol: 140,  frek: '14d', rfid: 'RFID-R06-M' },
  ];
  for (const b of beholdere) {
    await pool.query(
      `INSERT INTO beholdere (id, kontrakt_id, fraktion_id, volumen_l, frekvens, rfid, faelles, fordelingsnoegle, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'aktiv') ON CONFLICT (id) DO NOTHING`,
      [b.id, b.kontrakt_id, b.fraktion, b.vol, b.frek, b.rfid, b.faelles || false, b.fordelingsnoegle || null]
    );
  }

  // ───── 5) Tømninger (3 mdr. historik, varieret undtagelseskoder) ─────
  const today = new Date();
  const fraktioner = await pool.query(`SELECT id, default_densitet FROM fraktioner`);
  const densitet = Object.fromEntries(fraktioner.rows.map(r => [r.id, Number(r.default_densitet || 0.1)]));
  for (const b of beholdere) {
    const dage = b.frek === '7d' ? 7 : b.frek === '14d' ? 14 : 28;
    const antalTomninger = b.frek === '7d' ? 12 : b.frek === '14d' ? 6 : 3;
    for (let i = 1; i <= antalTomninger; i++) {
      const dt = new Date(today.getTime() - i * dage * 86400000).toISOString().slice(0, 10);
      const baseVaegt = b.vol * (densitet[b.fraktion] || 0.1);
      const vaegt = (baseVaegt * (0.7 + Math.random() * 0.4)).toFixed(2);
      // ~10% har en undtagelseskode for at demonstrere UC-11
      const undt = i === 2 ? 'overfyldt' : (i === 4 && b.id === 'BH-R01-R' ? 'ikke_fremstillet' : null);
      const tomningId = `TM-RICH-${b.id.slice(3)}-${i}`;
      await pool.query(
        `INSERT INTO tomninger (id, beholder_id, tomning_dato, vaegt_kg, vaegt_estimeret, undtagelseskode, kilde, chauffoer, rute)
         VALUES ($1,$2,$3,$4,$5,$6,'driftssystem','DRV-' || (random()*9+1)::int,'Holstebro-rute-' || (random()*5+1)::int)
         ON CONFLICT (id) DO NOTHING`,
        [tomningId, b.id, dt, vaegt, true, undt]
      );
    }
  }

  // ───── 6) Tømningsplaner (næste 3 mdr. fremad) ─────
  for (const b of beholdere) {
    const dage = b.frek === '7d' ? 7 : b.frek === '14d' ? 14 : 28;
    for (let i = 1; i <= 6; i++) {
      const dt = new Date(today.getTime() + i * dage * 86400000).toISOString().slice(0, 10);
      await pool.query(
        `INSERT INTO tomningsplaner (beholder_id, planlagt_dato, status, rute)
         VALUES ($1,$2,'planlagt','Holstebro-N')
         ON CONFLICT DO NOTHING`,
        [b.id, dt]
      );
    }
  }

  // ───── 7) Fakturaer i forskellige statusser ─────
  // Generér 6 fakturaer der dækker: kladde, godkendt, sendt, betalt, forfalden, krediteret.
  const finder = async (sql, params = []) => (await pool.query(sql, params)).rows[0];
  const prisblad = await finder(`SELECT id FROM prisblade WHERE service_type = 'renovation' AND status = 'aktiv' LIMIT 1`);
  const moms = 25;

  async function lavFaktura({ id, kunde_id, kontrakt_id, ejendom_id, status, periode_fra, periode_til, fakturadato, forfaldsdato, belob_excl, betalt_belob = 0 }) {
    const fnr = (await pool.query(`SELECT nextval('fakturanr_seq') AS n`)).rows[0].n;
    const moms_belob = belob_excl * moms / 100;
    const belob_incl = belob_excl + moms_belob;
    await pool.query(
      `INSERT INTO fakturaer (id, fakturanr, service_type, kunde_id, ejendom_id, kontrakt_id, kommune_id,
        periode_fra, periode_til, fakturadato, forfaldsdato, status, belob_excl, moms, belob_incl, betalt_belob,
        faktura_kanal, sendt, betalt)
       VALUES ($1,$2,'renovation',$3,$4,$5,'holstebro',$6,$7,$8,$9,$10,$11,$12,$13,$14,'eboks',
         CASE WHEN $10 IN ('sendt','betalt','forfalden','rykker','inddrivelse','krediteret') THEN $8::date + interval '1 day' ELSE NULL END,
         CASE WHEN $10 = 'betalt' THEN $9::date + interval '5 days' ELSE NULL END)
       ON CONFLICT (id) DO NOTHING`,
      [id, fnr, kunde_id, ejendom_id, kontrakt_id, periode_fra, periode_til, fakturadato, forfaldsdato,
       status, belob_excl.toFixed(2), moms_belob.toFixed(2), belob_incl.toFixed(2), betalt_belob.toFixed(2)]
    );
    // Linjer
    await pool.query(
      `INSERT INTO fakturalinjer (faktura_id, beskrivelse, type, antal, enhed, enhedspris, belob_excl, moms_pct, moms, belob_incl)
       VALUES ($1,'Grundgebyr (kvartal)','grundgebyr',0.25,'år',1850,462.50,25,115.63,578.13)`,
      [id]
    );
    await pool.query(
      `INSERT INTO fakturalinjer (faktura_id, beskrivelse, type, antal, enhed, enhedspris, belob_excl, moms_pct, moms, belob_incl)
       VALUES ($1,'Tømning restaffald 240L 14d','tomning',6,'tømning',56,336.00,25,84.00,420.00)`,
      [id]
    );
    return { id, fnr, belob_incl };
  }

  // Kasper Hansen — alle statusser
  await lavFaktura({ id: 'FA-RICH-K1', kunde_id: 'KU-RICH01', kontrakt_id: 'KO-RICH01', ejendom_id: 'EJ-RICH01',
    status: 'betalt', periode_fra: '2025-10-01', periode_til: '2025-12-31', fakturadato: '2026-01-05', forfaldsdato: '2026-02-04',
    belob_excl: 798.50, betalt_belob: 998.13 });
  await lavFaktura({ id: 'FA-RICH-K2', kunde_id: 'KU-RICH01', kontrakt_id: 'KO-RICH01', ejendom_id: 'EJ-RICH01',
    status: 'sendt',  periode_fra: '2026-01-01', periode_til: '2026-03-31', fakturadato: '2026-04-05', forfaldsdato: '2026-05-05',
    belob_excl: 798.50, betalt_belob: 0 });
  await lavFaktura({ id: 'FA-RICH-K3', kunde_id: 'KU-RICH01', kontrakt_id: 'KO-RICH01', ejendom_id: 'EJ-RICH01',
    status: 'kladde', periode_fra: '2026-04-01', periode_til: '2026-04-25', fakturadato: '2026-04-26', forfaldsdato: '2026-05-26',
    belob_excl: 250.00, betalt_belob: 0 });

  // Holstebro Plejehjem (erhverv) — OIOUBL-relevant
  await lavFaktura({ id: 'FA-RICH-P1', kunde_id: 'KU-RICH03', kontrakt_id: 'KO-RICH02', ejendom_id: 'EJ-RICH02',
    status: 'betalt', periode_fra: '2026-01-01', periode_til: '2026-03-31', fakturadato: '2026-04-05', forfaldsdato: '2026-04-19',
    belob_excl: 4500.00, betalt_belob: 5625.00 });
  await lavFaktura({ id: 'FA-RICH-P2', kunde_id: 'KU-RICH03', kontrakt_id: 'KO-RICH02', ejendom_id: 'EJ-RICH02',
    status: 'godkendt', periode_fra: '2026-04-01', periode_til: '2026-04-25', fakturadato: '2026-04-26', forfaldsdato: '2026-05-10',
    belob_excl: 1500.00, betalt_belob: 0 });

  // Mette — forfalden + delvis betalt (UC-32 rykker, UC-26 betalingsaftale)
  await lavFaktura({ id: 'FA-RICH-M1', kunde_id: 'KU-RICH06', kontrakt_id: 'KO-RICH06', ejendom_id: 'EJ-RICH06',
    status: 'rykker', periode_fra: '2025-10-01', periode_til: '2025-12-31', fakturadato: '2026-01-05', forfaldsdato: '2026-02-04',
    belob_excl: 798.50, betalt_belob: 200.00 });
  await lavFaktura({ id: 'FA-RICH-M2', kunde_id: 'KU-RICH06', kontrakt_id: 'KO-RICH06', ejendom_id: 'EJ-RICH06',
    status: 'forfalden', periode_fra: '2026-01-01', periode_til: '2026-03-31', fakturadato: '2026-04-05', forfaldsdato: '2026-04-19',
    belob_excl: 798.50, betalt_belob: 0 });

  // Boligforening AB Solgården — én samlet faktura
  await lavFaktura({ id: 'FA-RICH-S1', kunde_id: 'KU-RICH04', kontrakt_id: 'KO-SOL-A', ejendom_id: 'EJ-SOL-A',
    status: 'betalt', periode_fra: '2026-01-01', periode_til: '2026-03-31', fakturadato: '2026-04-05', forfaldsdato: '2026-05-05',
    belob_excl: 12500.00, betalt_belob: 15625.00 });

  // ───── 8) Betalinger ─────
  await pool.query(`INSERT INTO betalinger (faktura_id, belob, betalingsdato, metode, reference)
    VALUES ('FA-RICH-K1', 998.13, '2026-02-01', 'pbs', 'PBS retur jan 2026')
    ON CONFLICT DO NOTHING`);
  await pool.query(`INSERT INTO betalinger (faktura_id, belob, betalingsdato, metode, reference)
    VALUES ('FA-RICH-P1', 5625.00, '2026-04-15', 'bankoverforsel', 'NEM-IBAN-2026-001')
    ON CONFLICT DO NOTHING`);
  await pool.query(`INSERT INTO betalinger (faktura_id, belob, betalingsdato, metode, reference)
    VALUES ('FA-RICH-M1', 200.00, '2026-02-20', 'mobilepay', 'Delbetaling Mette')
    ON CONFLICT DO NOTHING`);
  await pool.query(`INSERT INTO betalinger (faktura_id, belob, betalingsdato, metode, reference)
    VALUES ('FA-RICH-S1', 15625.00, '2026-04-20', 'pbs', 'AB Solgården kvartal')
    ON CONFLICT DO NOTHING`);

  // ───── 9) Kreditnota (UC-29) ─────
  await pool.query(
    `INSERT INTO kreditnotaer (id, faktura_id, belob, aarsag, oprettet_af)
     VALUES ('KN-RICH01','FA-RICH-K1',150.00,'Reklamation godkendt — manglende tømning 12. nov 2025','Support')
     ON CONFLICT (id) DO NOTHING`
  );

  // ───── 10) Betalingsaftale (UC-26) på Mettes rykker-faktura ─────
  const rater = [
    { nr: 1, dato: '2026-05-15', belob: '199.50', status: 'afventer' },
    { nr: 2, dato: '2026-06-15', belob: '199.50', status: 'afventer' },
    { nr: 3, dato: '2026-07-15', belob: '199.13', status: 'afventer' },
  ];
  await pool.query(
    `INSERT INTO betalingsaftaler (id, faktura_id, kunde_id, total_belob, antal_rater, rater, oprettet_af)
     VALUES ('BA-RICH01','FA-RICH-M1','KU-RICH06',598.13,3,$1::jsonb,'Support')
     ON CONFLICT (id) DO NOTHING`,
    [JSON.stringify(rater)]
  );

  // ───── 11) Fuldmagter (UC-56) ─────
  // Kasper giver fuld adgang til Linda (ægtefælle).
  await pool.query(
    `INSERT INTO fuldmagter (ejer_kunde_id, agent_kunde_id, rolle, gyldig_fra, noter)
     VALUES ('KU-RICH01','KU-RICH02','fuld','2024-06-01','Ægtefælle med fuld adgang')
     ON CONFLICT DO NOTHING`
  );

  // ───── 12) Boligadm-relationer (UC-55) ─────
  // Vest Boliger administrerer 3 ejendomme (de tre Solvej-blokke).
  for (const ej of ['EJ-SOL-A', 'EJ-SOL-B', 'EJ-SOL-C']) {
    await pool.query(
      `INSERT INTO boligadm_relationer (admin_kunde_id, ejendom_id, rolle)
       VALUES ('KU-RICH05',$1,'administrator')
       ON CONFLICT (admin_kunde_id, ejendom_id) DO NOTHING`,
      [ej]
    );
  }

  // ───── 13) Samtykker (UC-57) — varieret pr. kunde ─────
  const samtykker = [
    { kunde: 'KU-RICH01', type: 'fakturalevering',   kanal: 'eboks', status: true },
    { kunde: 'KU-RICH01', type: 'driftspaamindelse', kanal: 'sms',   status: true },
    { kunde: 'KU-RICH01', type: 'marketing',         kanal: 'email', status: false },
    { kunde: 'KU-RICH02', type: 'fakturalevering',   kanal: 'email', status: true },
    { kunde: 'KU-RICH02', type: 'driftspaamindelse', kanal: 'app',   status: true },
    { kunde: 'KU-RICH02', type: 'sorteringsscore',   kanal: 'app',   status: true },
    { kunde: 'KU-RICH06', type: 'fakturalevering',   kanal: 'eboks', status: true },
    { kunde: 'KU-RICH06', type: 'driftspaamindelse', kanal: 'sms',   status: false }, // takket nej
  ];
  for (const s of samtykker) {
    await pool.query(
      `INSERT INTO samtykker (kunde_id, type, kanal, status) VALUES ($1,$2,$3,$4)
       ON CONFLICT (kunde_id, type, kanal) DO NOTHING`,
      [s.kunde, s.type, s.kanal, s.status]
    );
  }

  // ───── 14) Sager — varieret kategorier og statusser ─────
  const sager = [
    { id: 'SAG-RICH01', kategori: 'manglende_tomning',  prioritet: 'normal', status: 'aaben',
      titel: 'Restaffald ikke tømt fredag', beskr: 'Kunden ringede ind: beholder ikke tømt.', kunde_id: 'KU-RICH01', sla_dage: 3 },
    { id: 'SAG-RICH02', kategori: 'beholder_skadet',    prioritet: 'hoej',   status: 'igang',
      titel: 'Beholder revnet — bestil nyt', beskr: 'Beholder BH-R02-R revnet i siden.', kunde_id: 'KU-RICH03', sla_dage: 7 },
    { id: 'SAG-RICH03', kategori: 'fakturafejl',        prioritet: 'normal', status: 'venter_kunde',
      titel: 'Tvist om faktura FA-RICH-M2', beskr: 'Mette mener gebyret er forkert.', kunde_id: 'KU-RICH06', sla_dage: 14 },
    { id: 'SAG-RICH04', kategori: 'storskrald',         prioritet: 'normal', status: 'aaben',
      titel: 'Storskrald: Møbler (3 m³)', beskr: 'Tidsvindue 2026-05-01 til 2026-05-08', kunde_id: 'KU-RICH01', sla_dage: 14 },
    { id: 'SAG-RICH05', kategori: 'farligt_affald',     prioritet: 'hoej',   status: 'aaben',
      titel: 'Farligt affald: Maling + lithium-batterier', beskr: 'Aflever på genbrugsplads. Sikkerhedsinstruktion sendt.', kunde_id: 'KU-RICH03', sla_dage: 7 },
    { id: 'SAG-RICH06', kategori: 'ekstra_tomning',     prioritet: 'normal', status: 'lukket',
      titel: 'Ekstra tømning udført 12-04', beskr: 'Bestilt af kunde, faktureret 250 kr.', kunde_id: 'KU-RICH04', sla_dage: 3 },
    { id: 'SAG-RICH07', kategori: 'manglende_tomning',  prioritet: 'akut',   status: 'aaben',
      titel: 'Plejehjem — restaffald overfyldt 3 uger i træk', beskr: 'Strukturel sag — tjek beholderkomposition.', kunde_id: 'KU-RICH03', sla_dage: 1 },
  ];
  for (const s of sager) {
    await pool.query(
      `INSERT INTO sager (id, domain, kategori, prioritet, status, titel, beskrivelse, kunde_id, ansvarlig, sla_frist, oprettet)
       VALUES ($1,'renovation',$2,$3,$4,$5,$6,$7,'Support', now() + ($8 || ' days')::interval, now() - (random()*7)::int * interval '1 day')
       ON CONFLICT (id) DO NOTHING`,
      [s.id, s.kategori, s.prioritet, s.status, s.titel, s.beskr, s.kunde_id, s.sla_dage]
    );
    await pool.query(
      `INSERT INTO sag_aktiviteter (sag_id, type, tekst, bruger)
       VALUES ($1,'oprettet','Sag oprettet',$2)
       ON CONFLICT DO NOTHING`,
      [s.id, 'Support']
    );
  }
  // Tilføj kommentarer til SAG-RICH02 så aktivitetsloggen er meningsfuld.
  await pool.query(`INSERT INTO sag_aktiviteter (sag_id, type, tekst, bruger) VALUES
    ('SAG-RICH02','kommentar','Beholderbytte bestilt hos driftssystem.','Driftskoordinator'),
    ('SAG-RICH02','statusskift','Status ændret fra aaben til igang','Driftskoordinator'),
    ('SAG-RICH06','kommentar','Tømning udført af DRV-3.','System'),
    ('SAG-RICH06','statusskift','Status ændret til lukket','Support')
    ON CONFLICT DO NOTHING`);

  // ───── 15) Genbrugsplads-besøg (UC-50) ─────
  const gbp = [
    { kunde: 'KU-RICH01', dato: '2026-04-10', reg: 'nummerplade', ident: 'AB12345', vaegt: 25.5, fraktion: 'rest' },
    { kunde: 'KU-RICH01', dato: '2026-04-18', reg: 'nummerplade', ident: 'AB12345', vaegt: 12.0, fraktion: 'have' },
    { kunde: 'KU-RICH03', dato: '2026-04-05', reg: 'brik',        ident: 'BRIK-7890', vaegt: 180.0, fraktion: 'rest', pris: 270.00 },
    { kunde: 'KU-RICH03', dato: '2026-04-12', reg: 'brik',        ident: 'BRIK-7890', vaegt: 220.0, fraktion: 'rest', pris: 330.00 },
    // Anomali: erhverv med MANGE besøg
    { kunde: 'KU-RICH03', dato: '2026-04-15', reg: 'brik',        ident: 'BRIK-7890', vaegt: 350.0, fraktion: 'byggeaffald', pris: 525.00 },
    { kunde: 'KU-RICH03', dato: '2026-04-17', reg: 'brik',        ident: 'BRIK-7890', vaegt: 410.0, fraktion: 'byggeaffald', pris: 615.00 },
    { kunde: 'KU-RICH03', dato: '2026-04-20', reg: 'brik',        ident: 'BRIK-7890', vaegt: 280.0, fraktion: 'byggeaffald', pris: 420.00 },
    { kunde: 'KU-RICH03', dato: '2026-04-22', reg: 'brik',        ident: 'BRIK-7890', vaegt: 195.0, fraktion: 'byggeaffald', pris: 292.50 },
  ];
  for (const v of gbp) {
    await pool.query(
      `INSERT INTO genbrugsplads_besog (kunde_id, dato, registrering, identifikator, vægt_kg, fraktion_id, pris)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
      [v.kunde, v.dato, v.reg, v.ident, v.vaegt, v.fraktion, v.pris || 0]
    );
  }

  // ───── 16) Haveaffald sæsonabonnement (UC-52) ─────
  await pool.query(
    `INSERT INTO kontrakter (id, service_type, kunde_id, ejendom_id, start_dato, status, abonnement_type, saeson_fra, saeson_til, noter)
     VALUES ('KO-HAVE-K1','renovation','KU-RICH01','EJ-RICH01','2026-04-01','aktiv','haveaffald_saeson','2026-04-01','2026-10-31','Haveaffald 14-dages sæsonabonnement')
     ON CONFLICT (id) DO NOTHING`
  );
  await pool.query(
    `INSERT INTO beholdere (id, kontrakt_id, fraktion_id, volumen_l, frekvens, status)
     VALUES ('BH-HAVE-K1','KO-HAVE-K1','have',240,'14d','aktiv')
     ON CONFLICT (id) DO NOTHING`
  );

  // ───── 17) Historisk prisblad 2025 (UC-40 prisblad-versionering) ─────
  await pool.query(
    `INSERT INTO prisblade (id, service_type, kommune_id, version, gyldig_fra, gyldig_til, status, godkendt_af, godkendt_dato)
     VALUES ('PB-HOLST-2025','renovation','holstebro','2025.01','2025-01-01','2025-12-31','historisk','Byrådet','2024-11-15 10:00:00+01')
     ON CONFLICT (id) DO NOTHING`
  );
  // Et par historiske linjer.
  await pool.query(`INSERT INTO prisblad_linjer (prisblad_id, type, noegle, beskrivelse, enhedspris, enhed)
    VALUES ('PB-HOLST-2025','grundgebyr','husstand','Grundgebyr husstand 2025',1750.00,'år')
    ON CONFLICT DO NOTHING`);
  await pool.query(`INSERT INTO prisblad_linjer (prisblad_id, type, noegle, beskrivelse, enhedspris, enhed)
    VALUES ('PB-HOLST-2025','tomning','rest-240l-14d','Restaffald 240L 14d 2025',52.00,'tømning')
    ON CONFLICT DO NOTHING`);

  // ───── 18) Webhook-events (UC-10) — én OK + én fejlet ─────
  await pool.query(
    `INSERT INTO webhook_log (provider, event_type, external_id, payload, status, resultat_id, behandlet)
     VALUES ('renoweb','tomning','rich-001',
       '{"eventId":"rich-001","containerId":"BH-R01-R","emptiedAt":"2026-04-20T08:30:00Z","weightKg":18.5,"driverId":"DRV-42","route":"Holstebro-N"}'::jsonb,
       'behandlet','TM-RICH-R01-R-1', now() - interval '5 days')
     ON CONFLICT (provider, external_id) DO NOTHING`
  );
  await pool.query(
    `INSERT INTO webhook_log (provider, event_type, external_id, payload, status, fejl, behandlet)
     VALUES ('ivar','tomning','ivar-bad-001',
       '{"id":"ivar-bad-001","binId":"BH-NONEXISTENT","ts":"2026-04-22T10:00:00Z","kg":15.0}'::jsonb,
       'fejl','Ukendt beholder: BH-NONEXISTENT', now() - interval '3 days')
     ON CONFLICT (provider, external_id) DO NOTHING`
  );

  // ───── 19) ADS-indberetning (UC-39) — 2026-Q1, godkendt ─────
  await pool.query(
    `INSERT INTO ads_indberetninger (id, kommune_id, periode, status, total_kg, total_tomninger, godkendt_af, godkendt_dato, rapport)
     VALUES ('ADS-RICH01','holstebro','2026-Q1','godkendt',8542.50,127,'Manager Larsen', now() - interval '15 days',
       '{"fraktioner":[{"id":"rest","navn":"Restaffald","kg":4250},{"id":"mad","navn":"Madaffald","kg":1850},{"id":"papir","navn":"Papir","kg":1100},{"id":"glas","navn":"Glas","kg":820},{"id":"plast","navn":"Plast","kg":522.5}]}'::jsonb)
     ON CONFLICT (id) DO NOTHING`
  );

  // ───── 20) Audit-events (UC-43) — varieret historik ─────
  const auditEvents = [
    { entitet: 'prisblad',  entitet_id: 'PB-HOLST-2026', handling: 'godkendt', bruger: 'Byrådet' },
    { entitet: 'prisblad',  entitet_id: 'PB-HOLST-2025', handling: 'historisk', bruger: 'System' },
    { entitet: 'varsling',  entitet_id: 'VARS-RICH01',   handling: 'sendt', bruger: 'Manager',
      detaljer: { antal_kunder: 1247, kommune_id: 'holstebro', kanaler: { eboks: 1100, email: 147 } } },
    { entitet: 'kontrakt',  entitet_id: 'KO-RICH01',     handling: 'oprettet', bruger: 'Support' },
    { entitet: 'faktura',   entitet_id: 'FA-RICH-K1',    handling: 'krediteret', bruger: 'Support',
      detaljer: { kreditnota_id: 'KN-RICH01', belob: 150.00, aarsag: 'Reklamation godkendt' } },
    { entitet: 'fuldmagt',  entitet_id: '1',             handling: 'oprettet', bruger: 'Support' },
    { entitet: 'samtykke',  entitet_id: 'KU-RICH01',     handling: 'opdateret', bruger: 'Kunde',
      detaljer: { type: 'marketing', kanal: 'email', status: false } },
    { entitet: 'gdpr',      entitet_id: 'KU-RICH02',     handling: 'eksport_genereret', bruger: 'Kunde' },
    { entitet: 'fakturakorsel', entitet_id: '2026-Q1',    handling: 'koert', bruger: 'Afregningsansvarlig',
      detaljer: { oprettet_count: 3, fejlet_count: 0, total: 1985.13 } },
  ];
  for (const a of auditEvents) {
    await pool.query(
      `INSERT INTO audit_log (entitet, entitet_id, handling, bruger, detaljer, oprettet)
       VALUES ($1,$2,$3,$4,$5::jsonb, now() - (random() * 30)::int * interval '1 day')`,
      [a.entitet, a.entitet_id, a.handling, a.bruger, JSON.stringify(a.detaljer || {})]
    );
  }

  // ───── 21) Sendt brev — én rykker udsendt for at have data i sendte_breve ─────
  await pool.query(
    `INSERT INTO sendte_breve (skabelon_id, kunde_id, emne, body, kanal, bruger, sendt)
     VALUES ('rykker_1','KU-RICH06','Påmindelse om manglende betaling — faktura FA-RICH-M1',
       'Kære Mette Nielsen\\n\\nVi kan se at faktura FA-RICH-M1 på 998.13 kr. med forfaldsdato 2026-02-04 endnu ikke er betalt.\\n\\n[...]',
       'eboks','Økonomi', now() - interval '20 days')`
  );

  console.log('[seed] Rich-seed færdig. Test-data klar til alle UCs.');
};
