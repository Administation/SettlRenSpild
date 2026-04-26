-- ─────────────────────────────────────────────────────────────────────────────
-- SPILDEVAND SCHEMA — domæne-specifikke tabeller for vandmålere og aflæsninger.
-- Genbruger fra core: kunder, ejendomme, kontrakter (m. service_type='spildevand'),
-- prisblade (m. service_type='spildevand'), fakturaer, betalinger, sager.
-- ─────────────────────────────────────────────────────────────────────────────

-- Vandmålere — fysiske målere på en ejendom. Én ejendom kan have hovedmåler
-- og evt. fradragsmålere (havevanding) eller bimaalere (lejligheder).
CREATE TABLE IF NOT EXISTS vandmaalere (
  id              TEXT PRIMARY KEY,
  ejendom_id      TEXT NOT NULL REFERENCES ejendomme(id),
  kontrakt_id     TEXT REFERENCES kontrakter(id),
  maalernummer    TEXT NOT NULL,                          -- fysisk maaler-ID fra producent
  fabrikat        TEXT,                                   -- 'Kamstrup' | 'Diehl' | 'Sensus'
  type            TEXT NOT NULL DEFAULT 'mekanisk',       -- 'mekanisk' | 'ultralyd' | 'smart'
  dimension       TEXT,                                   -- 'qn1.5' | 'qn2.5' | 'qn6' | 'qn10'
  installeret     DATE NOT NULL,
  nedtaget        DATE,
  bimaaler_af     TEXT REFERENCES vandmaalere(id),        -- hvis bimåler under hovedmåler
  fradragsmaaler  BOOLEAN NOT NULL DEFAULT FALSE,         -- havevanding/erhvervsdispensation
  fjernaflaest    BOOLEAN NOT NULL DEFAULT FALSE,         -- IoT-tilkoblet (smart meter)
  status          TEXT NOT NULL DEFAULT 'aktiv',          -- 'aktiv' | 'defekt' | 'nedtaget' | 'udskiftet'
  oprettet        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(maalernummer)
);

CREATE INDEX IF NOT EXISTS idx_vandmaalere_ejendom ON vandmaalere(ejendom_id);
CREATE INDEX IF NOT EXISTS idx_vandmaalere_kontrakt ON vandmaalere(kontrakt_id);
CREATE INDEX IF NOT EXISTS idx_vandmaalere_status ON vandmaalere(status);

-- Måleraflæsninger — kan være manuelle, kunde-indberettede, fjernaflæste eller estimerede.
CREATE TABLE IF NOT EXISTS aflaesninger (
  id              SERIAL PRIMARY KEY,
  maaler_id       TEXT NOT NULL REFERENCES vandmaalere(id),
  dato            DATE NOT NULL,
  stand_m3        NUMERIC(12,3) NOT NULL,
  kilde           TEXT NOT NULL DEFAULT 'manuel',         -- 'manuel' | 'kunde' | 'fjernaflaest' | 'estimat' | 'aarsskifte'
  aflaeser        TEXT,
  validering      TEXT NOT NULL DEFAULT 'gyldig',         -- 'gyldig' | 'flagget' | 'korrigeret' | 'estimat'
  noter           TEXT,
  faktureret      BOOLEAN NOT NULL DEFAULT FALSE,
  external_ref    TEXT,                                   -- providerens event-id, til dedup
  oprettet        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_aflaesninger_maaler ON aflaesninger(maaler_id);
CREATE INDEX IF NOT EXISTS idx_aflaesninger_dato ON aflaesninger(dato);
CREATE INDEX IF NOT EXISTS idx_aflaesninger_validering ON aflaesninger(validering);
CREATE UNIQUE INDEX IF NOT EXISTS idx_aflaesninger_external ON aflaesninger(external_ref) WHERE external_ref IS NOT NULL;

-- Acontoplan — spildevand kører typisk aconto-rater + årsopgørelse.
CREATE TABLE IF NOT EXISTS acontoplaner (
  id              TEXT PRIMARY KEY,
  kontrakt_id     TEXT NOT NULL REFERENCES kontrakter(id),
  aar             INTEGER NOT NULL,
  forventet_m3    NUMERIC(10,2) NOT NULL,
  estimeret_aarsbelob NUMERIC(12,2) NOT NULL,
  rate_belob      NUMERIC(12,2) NOT NULL,
  antal_rater     INTEGER NOT NULL DEFAULT 4,
  status          TEXT NOT NULL DEFAULT 'aktiv',          -- 'aktiv' | 'afsluttet' | 'annulleret'
  oprettet        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(kontrakt_id, aar)
);

-- Spildevand-prisblade har desuden en "afregningsmodel"-kolonne der allerede findes
-- (volumen | vægt | m3) — vi tilføjer ikke ny kolonne men bruger noegle/enhed på prisblad_linjer:
--   type='vandafledning', noegle='m3', enhedspris=20.45 (kr/m³)
--   type='fast_aar',      noegle='husstand', enhedspris=625 (kr/år)
--   type='statsafgift',   noegle='m3', enhedspris=8.98 (statsafgift)
--   type='tilslutning',   noegle='engangs', enhedspris=42500 (engangsbidrag)
--   type='saerbidrag',    noegle='erhverv-promille', enhedspris=… (erhverv >0,5‰)
