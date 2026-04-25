-- ─────────────────────────────────────────────────────────────────────────────
-- RENOVATION SCHEMA — domæne-specifikke tabeller for affaldshåndtering.
-- Spildevand vil få sit eget schema-fil med vandmaalere, aflæsninger osv.
-- ─────────────────────────────────────────────────────────────────────────────

-- Affaldsfraktioner (lookup) — restaffald, papir, glas, plast, madaffald, osv.
CREATE TABLE IF NOT EXISTS fraktioner (
  id              TEXT PRIMARY KEY,                       -- 'rest' | 'papir' | 'glas' | 'plast' | 'mad' | 'have' | 'farligt' | 'storskrald'
  navn            TEXT NOT NULL,
  ews_kode        TEXT,                                   -- EWS-kode for ADS-indberetning
  default_densitet NUMERIC(8,3),                          -- kg/L til vægt-estimering ved ADS-indberetning
  farve           TEXT
);

-- Beholder / container på en kontrakt. Én række per fysisk beholder.
CREATE TABLE IF NOT EXISTS beholdere (
  id              TEXT PRIMARY KEY,
  kontrakt_id     TEXT NOT NULL REFERENCES kontrakter(id) ON DELETE CASCADE,
  fraktion_id     TEXT NOT NULL REFERENCES fraktioner(id),
  volumen_l       INTEGER NOT NULL,                       -- 140, 240, 660, 1100, 4000 osv.
  frekvens        TEXT NOT NULL,                          -- '7d' | '14d' | '28d' | 'ad-hoc'
  rfid            TEXT,                                   -- chip på beholder, kobling til driftssystem
  status          TEXT NOT NULL DEFAULT 'aktiv',          -- 'aktiv' | 'i_reparation' | 'inaktiv'
  placering       TEXT,                                   -- noter til renovatør
  faelles         BOOLEAN NOT NULL DEFAULT FALSE,         -- delt mellem flere kontrakter
  fordelingsnoegle NUMERIC(6,4),                          -- 0..1, når faelles=true
  oprettet        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_beholdere_kontrakt ON beholdere(kontrakt_id);
CREATE INDEX IF NOT EXISTS idx_beholdere_fraktion ON beholdere(fraktion_id);

-- Tømningsplan — planlagte tømninger pr. beholder (genereres ud fra frekvens).
CREATE TABLE IF NOT EXISTS tomningsplaner (
  id              SERIAL PRIMARY KEY,
  beholder_id     TEXT NOT NULL REFERENCES beholdere(id) ON DELETE CASCADE,
  planlagt_dato   DATE NOT NULL,
  rute            TEXT,
  status          TEXT NOT NULL DEFAULT 'planlagt'        -- 'planlagt' | 'gennemfoert' | 'afvist' | 'aflyst'
);

CREATE INDEX IF NOT EXISTS idx_tomningsplaner_dato ON tomningsplaner(planlagt_dato);
CREATE INDEX IF NOT EXISTS idx_tomningsplaner_beholder ON tomningsplaner(beholder_id);

-- Tømningskvitteringer — registreret efter tømning. Kilde: driftssystem-webhook
-- eller manuel registrering. Bruges til fakturering og ADS-indberetning.
CREATE TABLE IF NOT EXISTS tomninger (
  id              TEXT PRIMARY KEY,
  beholder_id     TEXT NOT NULL REFERENCES beholdere(id),
  plan_id         INTEGER REFERENCES tomningsplaner(id),
  tomning_dato    DATE NOT NULL,
  tomning_tid     TIMESTAMPTZ,
  vaegt_kg        NUMERIC(10,2),
  vaegt_estimeret BOOLEAN NOT NULL DEFAULT TRUE,          -- false hvis vejet via vægtsystem
  undtagelseskode TEXT,                                   -- 'ikke_fremstillet' | 'overfyldt' | 'forkert_indhold' osv.
  chauffoer       TEXT,
  rute            TEXT,
  gps_lat         NUMERIC(9,6),
  gps_lon         NUMERIC(9,6),
  foto_url        TEXT,
  faktureret      BOOLEAN NOT NULL DEFAULT FALSE,
  faktura_linje_id INTEGER REFERENCES fakturalinjer(id),
  kilde           TEXT NOT NULL DEFAULT 'manuel',         -- 'manuel' | 'driftssystem' | 'vaegtsystem'
  oprettet        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- external_ref tilføjes via ALTER for at virke på eksisterende databaser.
ALTER TABLE tomninger ADD COLUMN IF NOT EXISTS external_ref TEXT;

-- Idempotens på webhook-import: samme provider+event ID må kun give én tømning.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tomninger_external_ref ON tomninger(external_ref) WHERE external_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tomninger_beholder ON tomninger(beholder_id);
CREATE INDEX IF NOT EXISTS idx_tomninger_dato ON tomninger(tomning_dato);
CREATE INDEX IF NOT EXISTS idx_tomninger_faktureret ON tomninger(faktureret);

-- Affaldsregulativ — kommunens regler for hvilke fraktioner der er obligatoriske,
-- min. volumener, fritagelsesregler. Bruges af valideringsmotor (v2).
CREATE TABLE IF NOT EXISTS affaldsregulativer (
  id              TEXT PRIMARY KEY,
  kommune_id      TEXT NOT NULL REFERENCES kommuner(id),
  version         TEXT NOT NULL,
  gyldig_fra      DATE NOT NULL,
  gyldig_til      DATE,
  regler          JSONB,                                  -- { obligatoriske_fraktioner: [...], min_volumen: {...}, fritagelse: {...} }
  oprettet        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ADS-indberetning til Miljøstyrelsen (kvartalsvis).
CREATE TABLE IF NOT EXISTS ads_indberetninger (
  id              TEXT PRIMARY KEY,
  kommune_id      TEXT NOT NULL REFERENCES kommuner(id),
  periode         TEXT NOT NULL,                          -- '2026-Q1'
  status          TEXT NOT NULL DEFAULT 'kladde',         -- 'kladde' | 'godkendt' | 'indsendt' | 'fejl'
  total_kg        NUMERIC(14,2),
  total_tomninger INTEGER,
  godkendt_af     TEXT,
  godkendt_dato   TIMESTAMPTZ,
  indsendt_dato   TIMESTAMPTZ,
  rapport         JSONB,                                  -- { fraktioner: [{ id, kg, tomninger }, ...] }
  oprettet        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ads_kommune_periode ON ads_indberetninger(kommune_id, periode);
