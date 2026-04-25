-- ─────────────────────────────────────────────────────────────────────────────
-- CORE SCHEMA — fælles entiteter for både renovation og spildevand.
-- Tabeller her bruges af begge domæner via service_type / domain-discriminator.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS kommuner (
  id            TEXT PRIMARY KEY,
  navn          TEXT NOT NULL,
  cvr           TEXT,
  ean           TEXT,
  email         TEXT,
  telefon       TEXT,
  oprettet      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Fysisk ejendom (BBR-koblet). Én række per adresse.
CREATE TABLE IF NOT EXISTS ejendomme (
  id            TEXT PRIMARY KEY,
  bbr_id        TEXT,
  bfe_nr        TEXT,
  vejnavn       TEXT NOT NULL,
  husnr         TEXT,
  etage         TEXT,
  doer          TEXT,
  postnr        TEXT NOT NULL,
  by            TEXT NOT NULL,
  kommune_id    TEXT REFERENCES kommuner(id),
  ejendomstype  TEXT,
  matrikel      TEXT,
  oprettet      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ejendomme_kommune ON ejendomme(kommune_id);
CREATE INDEX IF NOT EXISTS idx_ejendomme_postnr ON ejendomme(postnr);

-- Kunde — kan være privat (CPR) eller virksomhed (CVR/EAN).
CREATE TABLE IF NOT EXISTS kunder (
  id              TEXT PRIMARY KEY,
  type            TEXT NOT NULL DEFAULT 'privat',         -- 'privat' | 'erhverv' | 'forening'
  navn            TEXT NOT NULL,
  cpr             TEXT,
  cvr             TEXT,
  ean             TEXT,
  email           TEXT,
  telefon         TEXT,
  faktura_kanal   TEXT NOT NULL DEFAULT 'eboks',          -- 'eboks' | 'oioubl' | 'email' | 'papir' | 'pbs'
  pbs_aktiv       BOOLEAN NOT NULL DEFAULT FALSE,
  pbs_pbsnr       TEXT,
  pbs_debgr       TEXT,
  status          TEXT NOT NULL DEFAULT 'aktiv',          -- 'aktiv' | 'spaerret' | 'lukket'
  oprettet        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Kontrakt — knytter kunde til ejendom for én konkret service.
-- service_type discriminerer mellem domæner: vigtig nøgle for fremtidig spildevand-udvidelse.
CREATE TABLE IF NOT EXISTS kontrakter (
  id              TEXT PRIMARY KEY,
  service_type    TEXT NOT NULL,                          -- 'renovation' | 'spildevand'
  kunde_id        TEXT NOT NULL REFERENCES kunder(id),
  ejendom_id      TEXT NOT NULL REFERENCES ejendomme(id),
  start_dato      DATE NOT NULL,
  slut_dato       DATE,
  status          TEXT NOT NULL DEFAULT 'aktiv',          -- 'aktiv' | 'fritaget' | 'opsagt'
  fritaget_aarsag TEXT,
  noter           TEXT,
  oprettet        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kontrakter_kunde ON kontrakter(kunde_id);
CREATE INDEX IF NOT EXISTS idx_kontrakter_ejendom ON kontrakter(ejendom_id);
CREATE INDEX IF NOT EXISTS idx_kontrakter_service ON kontrakter(service_type);
CREATE INDEX IF NOT EXISTS idx_kontrakter_status ON kontrakter(status);

-- Prisblade — versioneret per kommune × service. Spildevand vil bruge samme tabel.
CREATE TABLE IF NOT EXISTS prisblade (
  id              TEXT PRIMARY KEY,
  service_type    TEXT NOT NULL,                          -- 'renovation' | 'spildevand'
  kommune_id      TEXT NOT NULL REFERENCES kommuner(id),
  version         TEXT NOT NULL,
  gyldig_fra      DATE NOT NULL,
  gyldig_til      DATE,
  status          TEXT NOT NULL DEFAULT 'kladde',         -- 'kladde' | 'aktiv' | 'historisk'
  godkendt_af     TEXT,
  godkendt_dato   TIMESTAMPTZ,
  oprettet        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_prisblade_kommune ON prisblade(kommune_id);
CREATE INDEX IF NOT EXISTS idx_prisblade_service_status ON prisblade(service_type, status);

-- Linjer i et prisblad. type+nøgle bruges til at finde pris ved fakturering.
-- Eksempler (renovation): type='grundgebyr', noegle='husstand'
--                         type='tomning', noegle='restaffald-240l-14d'
--                         type='tillaeg', noegle='ekstratomning'
-- Eksempler (spildevand): type='vandafledning', noegle='m3'
--                         type='fast', noegle='aarsgebyr'
CREATE TABLE IF NOT EXISTS prisblad_linjer (
  id              SERIAL PRIMARY KEY,
  prisblad_id     TEXT NOT NULL REFERENCES prisblade(id) ON DELETE CASCADE,
  type            TEXT NOT NULL,
  noegle          TEXT NOT NULL,
  beskrivelse     TEXT,
  enhedspris      NUMERIC(12,4) NOT NULL,
  enhed           TEXT,                                   -- 'stk' | 'tomning' | 'm3' | 'aar'
  moms_pct        NUMERIC(5,2) NOT NULL DEFAULT 25.00,
  UNIQUE(prisblad_id, type, noegle)
);

-- Fakturaer — fælles for alle service_types.
CREATE TABLE IF NOT EXISTS fakturaer (
  id              TEXT PRIMARY KEY,
  fakturanr       INTEGER UNIQUE,
  service_type    TEXT NOT NULL,
  kunde_id        TEXT NOT NULL REFERENCES kunder(id),
  ejendom_id      TEXT REFERENCES ejendomme(id),
  kontrakt_id     TEXT REFERENCES kontrakter(id),
  kommune_id      TEXT REFERENCES kommuner(id),
  periode_fra     DATE NOT NULL,
  periode_til     DATE NOT NULL,
  fakturadato     DATE NOT NULL DEFAULT CURRENT_DATE,
  forfaldsdato    DATE NOT NULL,
  status          TEXT NOT NULL DEFAULT 'kladde',         -- 'kladde' | 'godkendt' | 'sendt' | 'betalt' | 'forfalden' | 'rykker' | 'inddrivelse' | 'krediteret'
  belob_excl      NUMERIC(12,2) NOT NULL DEFAULT 0,
  moms            NUMERIC(12,2) NOT NULL DEFAULT 0,
  belob_incl      NUMERIC(12,2) NOT NULL DEFAULT 0,
  betalt_belob    NUMERIC(12,2) NOT NULL DEFAULT 0,
  faktura_kanal   TEXT,                                   -- snapshot af kunders kanal på fakturatidspunkt
  oprettet        TIMESTAMPTZ NOT NULL DEFAULT now(),
  sendt           TIMESTAMPTZ,
  betalt          TIMESTAMPTZ
);

CREATE SEQUENCE IF NOT EXISTS fakturanr_seq START 100001;

CREATE INDEX IF NOT EXISTS idx_fakturaer_kunde ON fakturaer(kunde_id);
CREATE INDEX IF NOT EXISTS idx_fakturaer_status ON fakturaer(status);
CREATE INDEX IF NOT EXISTS idx_fakturaer_service ON fakturaer(service_type);
CREATE INDEX IF NOT EXISTS idx_fakturaer_periode ON fakturaer(periode_fra, periode_til);

CREATE TABLE IF NOT EXISTS fakturalinjer (
  id              SERIAL PRIMARY KEY,
  faktura_id      TEXT NOT NULL REFERENCES fakturaer(id) ON DELETE CASCADE,
  beskrivelse     TEXT NOT NULL,
  type            TEXT,                                   -- 'grundgebyr' | 'tomning' | 'tillaeg' | 'forbrug' | 'kreditering'
  ref_id          TEXT,                                   -- fx tomning_id eller aflaesning_id
  antal           NUMERIC(12,3) NOT NULL DEFAULT 1,
  enhed           TEXT,
  enhedspris      NUMERIC(12,4) NOT NULL DEFAULT 0,
  belob_excl      NUMERIC(12,2) NOT NULL DEFAULT 0,
  moms_pct        NUMERIC(5,2) NOT NULL DEFAULT 25.00,
  moms            NUMERIC(12,2) NOT NULL DEFAULT 0,
  belob_incl      NUMERIC(12,2) NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_fakturalinjer_faktura ON fakturalinjer(faktura_id);

-- Betalinger på fakturaer.
CREATE TABLE IF NOT EXISTS betalinger (
  id              SERIAL PRIMARY KEY,
  faktura_id      TEXT NOT NULL REFERENCES fakturaer(id),
  belob           NUMERIC(12,2) NOT NULL,
  betalingsdato   DATE NOT NULL DEFAULT CURRENT_DATE,
  metode          TEXT,                                   -- 'pbs' | 'bankoverforsel' | 'mobilepay' | 'kort' | 'kontant'
  reference       TEXT,
  oprettet        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_betalinger_faktura ON betalinger(faktura_id);

-- Kreditnotaer — modposterer en faktura helt eller delvist.
CREATE TABLE IF NOT EXISTS kreditnotaer (
  id              TEXT PRIMARY KEY,
  faktura_id      TEXT NOT NULL REFERENCES fakturaer(id),
  belob           NUMERIC(12,2) NOT NULL,
  aarsag          TEXT,
  oprettet_af     TEXT,
  oprettet        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Sager / reklamationer — generisk for begge domæner via 'domain'-felt.
CREATE TABLE IF NOT EXISTS sager (
  id              TEXT PRIMARY KEY,
  domain          TEXT NOT NULL,                          -- 'renovation' | 'spildevand' | 'kunde'
  kategori        TEXT,                                   -- 'manglende_tomning' | 'beholder_skadet' | 'fakturafejl' | 'tilslutning' | osv.
  prioritet       TEXT NOT NULL DEFAULT 'normal',         -- 'lav' | 'normal' | 'hoej' | 'akut'
  status          TEXT NOT NULL DEFAULT 'aaben',          -- 'aaben' | 'igang' | 'venter_kunde' | 'lukket'
  titel           TEXT NOT NULL,
  beskrivelse     TEXT,
  kunde_id        TEXT REFERENCES kunder(id),
  ejendom_id      TEXT REFERENCES ejendomme(id),
  kontrakt_id     TEXT REFERENCES kontrakter(id),
  ansvarlig       TEXT,
  sla_frist       TIMESTAMPTZ,
  oprettet        TIMESTAMPTZ NOT NULL DEFAULT now(),
  lukket          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sager_status ON sager(status);
CREATE INDEX IF NOT EXISTS idx_sager_domain ON sager(domain);
CREATE INDEX IF NOT EXISTS idx_sager_kunde ON sager(kunde_id);

CREATE TABLE IF NOT EXISTS sag_aktiviteter (
  id              SERIAL PRIMARY KEY,
  sag_id          TEXT NOT NULL REFERENCES sager(id) ON DELETE CASCADE,
  type            TEXT NOT NULL,                          -- 'kommentar' | 'statusskift' | 'tildelt' | 'kreditnota'
  tekst           TEXT,
  bruger          TEXT,
  oprettet        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Generel audit log — bruges til prisblad-godkendelser, ADS-indberetninger, mv.
CREATE TABLE IF NOT EXISTS audit_log (
  id              SERIAL PRIMARY KEY,
  entitet         TEXT NOT NULL,                          -- 'prisblad' | 'faktura' | 'kontrakt' | osv.
  entitet_id      TEXT NOT NULL,
  handling        TEXT NOT NULL,                          -- 'oprettet' | 'godkendt' | 'sendt' | 'opdateret'
  bruger          TEXT,
  detaljer        JSONB,
  oprettet        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_entitet ON audit_log(entitet, entitet_id);
