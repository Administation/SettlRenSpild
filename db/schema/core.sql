-- ─────────────────────────────────────────────────────────────────────────────
-- CORE SCHEMA — fælles entiteter for både renovation og spildevand.
-- Tabeller her bruges af begge domæner via service_type / domain-discriminator.
-- ─────────────────────────────────────────────────────────────────────────────

-- Trigram-extension giver os hurtig fuzzy søgning på 100k+ rækker.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

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

-- Log af indkomne webhook-events fra eksterne systemer (driftssystemer, vægt, m.fl.).
-- Bruges til debug, idempotens-tjek og dead-letter-håndtering.
CREATE TABLE IF NOT EXISTS webhook_log (
  id              SERIAL PRIMARY KEY,
  provider        TEXT NOT NULL,                          -- 'renoweb' | 'ivar' | 'ambitek' | 'generic'
  event_type      TEXT NOT NULL,                          -- 'tomning' | 'beholder_ny' | 'rute' | osv.
  external_id     TEXT,                                   -- providerens event-id, til dedup
  payload         JSONB NOT NULL,
  status          TEXT NOT NULL DEFAULT 'modtaget',       -- 'modtaget' | 'behandlet' | 'fejl' | 'ignoreret'
  fejl            TEXT,
  resultat_id     TEXT,                                   -- fx tomninger.id ved succes
  modtaget        TIMESTAMPTZ NOT NULL DEFAULT now(),
  behandlet       TIMESTAMPTZ,
  UNIQUE(provider, external_id)
);

CREATE INDEX IF NOT EXISTS idx_webhook_status ON webhook_log(status);
CREATE INDEX IF NOT EXISTS idx_webhook_provider_modtaget ON webhook_log(provider, modtaget DESC);

-- UC-26 Betalingsaftaler — ratebetaling for kunder i restance.
CREATE TABLE IF NOT EXISTS betalingsaftaler (
  id              TEXT PRIMARY KEY,
  faktura_id      TEXT NOT NULL REFERENCES fakturaer(id),
  kunde_id        TEXT NOT NULL REFERENCES kunder(id),
  total_belob     NUMERIC(12,2) NOT NULL,
  antal_rater     INTEGER NOT NULL,
  rater           JSONB NOT NULL,                         -- [{ nr, dato, belob, status }]
  status          TEXT NOT NULL DEFAULT 'aktiv',          -- 'aktiv' | 'gennemfoert' | 'misligholdt' | 'annulleret'
  oprettet        TIMESTAMPTZ NOT NULL DEFAULT now(),
  oprettet_af     TEXT
);

CREATE INDEX IF NOT EXISTS idx_betalingsaftaler_faktura ON betalingsaftaler(faktura_id);
CREATE INDEX IF NOT EXISTS idx_betalingsaftaler_status ON betalingsaftaler(status);

-- UC-16 Helligdage og deres effekt på tømningsruter.
CREATE TABLE IF NOT EXISTS helligdage (
  id              SERIAL PRIMARY KEY,
  kommune_id      TEXT REFERENCES kommuner(id),           -- NULL = gælder alle kommuner (nationale helligdage)
  dato            DATE NOT NULL,
  navn            TEXT NOT NULL,
  forskyder_til   DATE,                                   -- hvornår tømningen flyttes til (NULL = aflyses)
  noter           TEXT,
  UNIQUE(kommune_id, dato)
);

CREATE INDEX IF NOT EXISTS idx_helligdage_dato ON helligdage(dato);

-- UC-57 Samtykker + kommunikationskanaler — pr. kunde valg af SMS/mail/Digital Post.
CREATE TABLE IF NOT EXISTS samtykker (
  id              SERIAL PRIMARY KEY,
  kunde_id        TEXT NOT NULL REFERENCES kunder(id) ON DELETE CASCADE,
  type            TEXT NOT NULL,                          -- 'fakturalevering' | 'driftspaamindelse' | 'marketing' | 'sorteringsscore' | 'gdpr'
  kanal           TEXT NOT NULL,                          -- 'eboks' | 'email' | 'sms' | 'app' | 'papir'
  status          BOOLEAN NOT NULL DEFAULT TRUE,
  opdateret       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(kunde_id, type, kanal)
);

-- UC-56 Fuldmagter — ejer giver adgang til ægtefælle/vicevært/kollega.
CREATE TABLE IF NOT EXISTS fuldmagter (
  id              SERIAL PRIMARY KEY,
  ejer_kunde_id   TEXT NOT NULL REFERENCES kunder(id) ON DELETE CASCADE,
  agent_kunde_id  TEXT NOT NULL REFERENCES kunder(id) ON DELETE CASCADE,
  rolle           TEXT NOT NULL,                          -- 'fuld' | 'kun_se' | 'service_kun'
  gyldig_fra      DATE NOT NULL DEFAULT CURRENT_DATE,
  gyldig_til      DATE,
  noter           TEXT,
  oprettet        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fuldmagter_agent ON fuldmagter(agent_kunde_id);
CREATE INDEX IF NOT EXISTS idx_fuldmagter_ejer  ON fuldmagter(ejer_kunde_id);

-- UC-55 Boligadministrator-portal — én admin-kunde har adgang til mange ejendomme.
CREATE TABLE IF NOT EXISTS boligadm_relationer (
  id              SERIAL PRIMARY KEY,
  admin_kunde_id  TEXT NOT NULL REFERENCES kunder(id) ON DELETE CASCADE,
  ejendom_id      TEXT NOT NULL REFERENCES ejendomme(id) ON DELETE CASCADE,
  rolle           TEXT NOT NULL DEFAULT 'administrator',  -- 'administrator' | 'samlet_betaler' | 'kun_se'
  oprettet        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(admin_kunde_id, ejendom_id)
);
CREATE INDEX IF NOT EXISTS idx_boligadm_admin ON boligadm_relationer(admin_kunde_id);

-- UC-63 Standardbreve / skabeloner.
CREATE TABLE IF NOT EXISTS brev_skabeloner (
  id              TEXT PRIMARY KEY,
  navn            TEXT NOT NULL,
  emne            TEXT NOT NULL,
  body            TEXT NOT NULL,                          -- understøtter {{kunde_navn}}, {{fakturanr}}, osv.
  kategori        TEXT,                                   -- 'rykker' | 'velkomst' | 'fakturatvist' | 'afslag' | 'godkendelse'
  oprettet        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Sendte breve med flettet indhold pr. kunde (audit).
CREATE TABLE IF NOT EXISTS sendte_breve (
  id              SERIAL PRIMARY KEY,
  skabelon_id     TEXT REFERENCES brev_skabeloner(id),
  kunde_id        TEXT NOT NULL REFERENCES kunder(id) ON DELETE CASCADE,
  sag_id          TEXT REFERENCES sager(id),
  emne            TEXT NOT NULL,
  body            TEXT NOT NULL,
  kanal           TEXT NOT NULL,                          -- 'eboks' | 'email' | 'sms'
  sendt           TIMESTAMPTZ NOT NULL DEFAULT now(),
  bruger          TEXT
);

-- UC-50 Genbrugsplads-besøg (erhverv betaler pr. besøg).
CREATE TABLE IF NOT EXISTS genbrugsplads_besog (
  id              SERIAL PRIMARY KEY,
  kunde_id        TEXT NOT NULL REFERENCES kunder(id),
  ejendom_id      TEXT REFERENCES ejendomme(id),
  dato            TIMESTAMPTZ NOT NULL DEFAULT now(),
  registrering    TEXT,                                   -- 'nummerplade' | 'brik' | 'manuel'
  identifikator   TEXT,                                   -- nummerplade eller brik-id
  vægt_kg         NUMERIC(10,2),
  fraktion_id     TEXT REFERENCES fraktioner(id),
  pris            NUMERIC(12,2),
  faktureret      BOOLEAN NOT NULL DEFAULT FALSE,
  noter           TEXT
);
CREATE INDEX IF NOT EXISTS idx_gbp_kunde ON genbrugsplads_besog(kunde_id);
CREATE INDEX IF NOT EXISTS idx_gbp_dato ON genbrugsplads_besog(dato);

-- UC-53 Pay-as-you-throw — afregningsmodel pr. prisblad.
ALTER TABLE prisblade ADD COLUMN IF NOT EXISTS afregningsmodel TEXT NOT NULL DEFAULT 'volumen';
-- Værdier: 'volumen' (default — pr. tømning) | 'vægt' (pay-as-you-throw, kr/kg)

-- UC-52 Haveaffald sæsonabonnement.
ALTER TABLE kontrakter ADD COLUMN IF NOT EXISTS abonnement_type TEXT;
-- 'standard' | 'haveaffald_saeson' | 'storskrald_aar' | 'farligt_aar'
ALTER TABLE kontrakter ADD COLUMN IF NOT EXISTS saeson_fra DATE;
ALTER TABLE kontrakter ADD COLUMN IF NOT EXISTS saeson_til DATE;

-- ─────────────────────────────────────────────────────────────────────────────
-- TRIGRAM-INDEKSER — gør ILIKE '%foo%' hurtig på store tabeller.
-- Bruges af søgebaren og listefilter.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_kunder_navn_trgm    ON kunder    USING gin (navn   gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_kunder_id_trgm      ON kunder    USING gin (id     gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_kunder_cvr_trgm     ON kunder    USING gin (cvr    gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_kunder_email_trgm   ON kunder    USING gin (email  gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_ejendomme_vej_trgm  ON ejendomme USING gin (vejnavn gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_ejendomme_by_trgm   ON ejendomme USING gin (by     gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_sager_titel_trgm    ON sager     USING gin (titel  gin_trgm_ops);

-- B-tree indekser til oprettelses-sortering og fakturanr-opslag.
CREATE INDEX IF NOT EXISTS idx_kunder_oprettet     ON kunder    (oprettet DESC);
CREATE INDEX IF NOT EXISTS idx_fakturaer_oprettet  ON fakturaer (oprettet DESC);
CREATE INDEX IF NOT EXISTS idx_sager_oprettet      ON sager     (oprettet DESC);
CREATE INDEX IF NOT EXISTS idx_kontrakter_oprettet ON kontrakter(oprettet DESC);
