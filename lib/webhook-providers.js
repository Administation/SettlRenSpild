// Adaptere mellem driftssystemers webhook-formater og vores interne tomning-model.
// Alle providers udstiller {parseTomning(payload)} som returnerer:
//   { external_id, beholder_id, tomning_dato, tomning_tid, vaegt_kg, vaegt_estimeret,
//     undtagelseskode, chauffoer, rute, gps_lat, gps_lon, foto_url }
//
// Tilføj en ny provider ved at lægge en fil her og registrere den i `providers`-objektet.

// ── RenoWeb (de største kommuner i DK bruger denne) ──
// Eksempel-payload:
// { eventId, containerId, emptiedAt, route, driverId, weightKg?, exceptionCode?, gps? }
const renoweb = {
  parseTomning(p) {
    const dato = (p.emptiedAt || '').slice(0, 10);
    return {
      external_id: p.eventId,
      beholder_id: p.containerId,
      tomning_dato: dato,
      tomning_tid: p.emptiedAt,
      vaegt_kg: p.weightKg ?? null,
      vaegt_estimeret: p.weightKg == null,
      undtagelseskode: p.exceptionCode || null,
      chauffoer: p.driverId || null,
      rute: p.route || null,
      gps_lat: p.gps?.lat ?? null,
      gps_lon: p.gps?.lon ?? null,
    };
  },
};

// ── Ivar (vejer ved gateway, høj kvalitet) ──
// Payload: { id, vehicleId, binId, ts, kg, lat, lon, anomaly }
const ivar = {
  parseTomning(p) {
    return {
      external_id: p.id,
      beholder_id: p.binId,
      tomning_dato: (p.ts || '').slice(0, 10),
      tomning_tid: p.ts,
      vaegt_kg: p.kg ?? null,
      vaegt_estimeret: false,                           // Ivar vejer altid
      undtagelseskode: p.anomaly || null,
      chauffoer: p.vehicleId || null,
      rute: null,
      gps_lat: p.lat ?? null,
      gps_lon: p.lon ?? null,
    };
  },
};

// ── Ambitek (mindre, ofte SFTP-baseret men har også HTTP webhook) ──
// Payload: { Id, BeholderId, Tidspunkt, Vaegt, Status }
const ambitek = {
  parseTomning(p) {
    return {
      external_id: String(p.Id),
      beholder_id: p.BeholderId,
      tomning_dato: (p.Tidspunkt || '').slice(0, 10),
      tomning_tid: p.Tidspunkt,
      vaegt_kg: p.Vaegt ?? null,
      vaegt_estimeret: p.Vaegt == null,
      undtagelseskode: p.Status === 'OK' ? null : (p.Status || '').toLowerCase().replace(/\s+/g, '_'),
      chauffoer: null,
      rute: null,
      gps_lat: null,
      gps_lon: null,
    };
  },
};

// ── Generic — vores eget format, fx fra mobile chauffør-app eller tests ──
// Forventer payload tæt på vores interne model.
const generic = {
  parseTomning(p) {
    return {
      external_id: p.external_id || p.id,
      beholder_id: p.beholder_id,
      tomning_dato: p.tomning_dato || (p.tomning_tid || '').slice(0, 10),
      tomning_tid: p.tomning_tid,
      vaegt_kg: p.vaegt_kg ?? null,
      vaegt_estimeret: p.vaegt_estimeret ?? (p.vaegt_kg == null),
      undtagelseskode: p.undtagelseskode || null,
      chauffoer: p.chauffoer || null,
      rute: p.rute || null,
      gps_lat: p.gps_lat ?? null,
      gps_lon: p.gps_lon ?? null,
      foto_url: p.foto_url || null,
    };
  },
};

module.exports = { renoweb, ivar, ambitek, generic };
