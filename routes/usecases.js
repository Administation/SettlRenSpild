// Use Cases Coverage — viser hvilke af de 43 UCs der er implementeret,
// delvist eller mangler. Status er statisk her men beriges med live tællere fra DB.
const express = require('express');
const router = express.Router();
const { query, one } = require('../db');

const UC = [
  // GROUP 1 — Stamdata
  { id: 'UC-01', titel: 'Opret ny privat renovationskunde',           gruppe: 'stamdata', status: 'done',    note: 'POST /api/kunder + UI "+ Ny kunde". BBR/DAWA er mocked.' },
  { id: 'UC-02', titel: 'Opret ny erhvervskunde',                     gruppe: 'stamdata', status: 'done',    note: 'CVR/EAN-felter findes. CVR-opslag mocked.' },
  { id: 'UC-03', titel: 'Opret fællesbeholder-aftale (boligforening)', gruppe: 'stamdata', status: 'partial', note: 'Schema: beholdere.faelles + fordelingsnoegle findes. UI mangler.' },
  { id: 'UC-04', titel: 'Kontraktovertagelse ved ejerskifte',         gruppe: 'stamdata', status: 'partial', note: 'Manuel via /kontrakter/:id/fraflyt med ny_ejer_kunde_id. BBR-trigger mock.' },
  { id: 'UC-05', titel: 'Indlæs nyt kommuneprisblad',                 gruppe: 'stamdata', status: 'done',    note: 'POST /api/prisblade + linjer endpoint + godkend.' },
  { id: 'UC-06', titel: 'Opdater kommuneregulativ',                   gruppe: 'stamdata', status: 'partial', note: 'Schema: affaldsregulativer findes. UI/validering mangler.' },
  { id: 'UC-07', titel: 'Generer og udsend afhentningskalender',      gruppe: 'stamdata', status: 'done',    note: 'GET /kunder/:id/kalender.ics (RFC 5545) + /kalender.html. Kan abonneres i digital kalender.' },
  { id: 'UC-08', titel: 'Vedligehold beholderregister',               gruppe: 'stamdata', status: 'done',    note: 'Beholdere CRUD + webhook-synk fra driftssystem.' },

  // GROUP 2 — Drift & Tømning
  { id: 'UC-09', titel: 'Eksporter ugentlig tømningsplan',            gruppe: 'drift', status: 'partial', note: 'GET /renovation/tomninger/plan findes. Push til driftssystem mangler.' },
  { id: 'UC-10', titel: 'Modtag og match tømningskvitteringer',       gruppe: 'drift', status: 'done',    note: 'Webhook-route med 4 providers (renoweb/ivar/ambitek/generic) + idempotens.' },
  { id: 'UC-11', titel: 'Håndter tømningsundtagelse',                 gruppe: 'drift', status: 'partial', note: 'undtagelseskode-felt findes. Auto-eskalering til reklamation mangler.' },
  { id: 'UC-12', titel: 'Bestil omtømning',                           gruppe: 'drift', status: 'partial', note: 'Genbruger ekstra-tomning-flow. Dedikeret modtagelse fra reklamation mangler.' },
  { id: 'UC-13', titel: 'Bestil beholderbytte',                       gruppe: 'drift', status: 'done',    note: 'POST /renovation/beholdere/:id/bytte — opretter sag + opdaterer register + audit.' },
  { id: 'UC-14', titel: 'Pause/stop tømningsplan',                    gruppe: 'drift', status: 'done',    note: 'Inkluderet i fritag/fraflyt-flows: aflyser planlagte tømninger.' },
  { id: 'UC-15', titel: 'SLA-overvågning og eskalering',              gruppe: 'drift', status: 'done',    note: 'sla_status (overdue/soon) i sager-route + KPI-tiles på sage-arbejdsbordet.' },
  { id: 'UC-16', titel: 'Konfigurer helligdagsruter',                 gruppe: 'drift', status: 'done',    note: 'helligdage-tabel m/ 13 nationale helligdage seedet. POST /helligdage/justér-planer flytter tømninger.' },
  { id: 'UC-17', titel: 'Akkumuler affaldsdata til ADS',              gruppe: 'drift', status: 'done',    note: 'POST /renovation/ads/beregn aggregerer kg/tomninger pr. fraktion.' },

  // GROUP 3 — Kundesupport
  { id: 'UC-18', titel: 'Reklamation om glemt tømning',               gruppe: 'support', status: 'done',    note: 'Sager-flow + Kunde 360 quick-action "+ Sag".' },
  { id: 'UC-19', titel: 'Bestil ekstra tømning (on-demand)',          gruppe: 'support', status: 'done',    note: 'POST /renovation/tomninger/ekstra + UI quick-action.' },
  { id: 'UC-20', titel: 'Bestil storskraldafhentning',                gruppe: 'support', status: 'done',    note: 'POST /storskrald m/ 6 typer + tidsvindue. Opretter sag, audit-log.' },
  { id: 'UC-21', titel: 'Ændr beholderkomposition',                   gruppe: 'support', status: 'partial', note: 'PUT /renovation/beholdere/:id virker. Regulativ-validering mangler.' },
  { id: 'UC-22', titel: 'Sæsonophør / midlertidig fritagelse',        gruppe: 'support', status: 'done',    note: 'POST /kontrakter/:id/fritag + /genoptag.' },
  { id: 'UC-23', titel: 'Fraflytning og kontraktophør',               gruppe: 'support', status: 'done',    note: 'POST /kontrakter/:id/fraflyt — opretter sag + aflyser planlagte.' },
  { id: 'UC-24', titel: 'Behandl fakturatvist',                       gruppe: 'support', status: 'partial', note: 'Kan oprettes som sag med kategori=fakturafejl. Audit-trail er nu klar.' },
  { id: 'UC-25', titel: 'Opdater fordelingsnøgle for fællesbeholder', gruppe: 'support', status: 'partial', note: 'PUT /renovation/beholdere/:id understøtter fordelingsnoegle. Massevis-genberegning mangler.' },
  { id: 'UC-26', titel: 'Indgå betalingsaftale ved restance',         gruppe: 'support', status: 'done',    note: 'POST /betalingsaftaler — opretter rater, pauser rykker. POST /:id/rate-betalt registrerer indbetaling.' },
  { id: 'UC-27', titel: 'Selvbetjening via Zerv-portal',              gruppe: 'support', status: 'done',    note: 'GET /zerv/min-konto + reklamation/ekstra-tomning/storskrald/kalender endpoints med Bearer-auth.' },

  // GROUP 4 — Afregning & Betaling
  { id: 'UC-28', titel: 'Gennemfør fakturakørsel',                    gruppe: 'afregning', status: 'done',    note: 'POST /fakturakorsel/simuler + /koer. ERP-eksport mock.' },
  { id: 'UC-29', titel: 'Opret og modregn kreditnota',                gruppe: 'afregning', status: 'done',    note: 'POST /fakturaer/:id/kreditnota.' },
  { id: 'UC-30', titel: 'PBS-opkrævning via NETS',                    gruppe: 'afregning', status: 'done',    note: 'GET /pbs/preview + /pbs/fil (NETS Section 41 light) + POST /pbs/retur til auto-match.' },
  { id: 'UC-31', titel: 'EAN-fakturering via Nemhandel',              gruppe: 'afregning', status: 'done',    note: 'GET /fakturaer/:id/oioubl returnerer valid OIOUBL 2.02 XML.' },
  { id: 'UC-32', titel: 'Automatisk rykkerproces',                    gruppe: 'afregning', status: 'partial', note: 'Manuel rykker via /fakturaer/:id/rykker + restance-overblik. Auto-cron mangler.' },
  { id: 'UC-33', titel: 'Overgivelse til SKAT Inddrivelse',           gruppe: 'afregning', status: 'partial', note: 'POST /rykker/skat-inddrivelse/:id mock. Fordringsfil-generering mangler.' },
  { id: 'UC-34', titel: 'Betalingsafstemning',                        gruppe: 'afregning', status: 'partial', note: 'Manuel via POST /betalinger. Bankfilimport + auto-match mangler.' },
  { id: 'UC-35', titel: 'Generer årsopgørelse',                       gruppe: 'afregning', status: 'done',    note: 'GET /aarsopgoerelse/:id?aar=… + /html. Bulk-genering klar til januar-cron.' },
  { id: 'UC-36', titel: 'Eksporter bogføringsposteringer til ERP',    gruppe: 'afregning', status: 'done',    note: 'GET /erp/eksport.csv (debet/kredit-konti pr. faktura/betaling/kreditnota).' },

  // GROUP 5 — Regulering & Priser
  { id: 'UC-37', titel: 'Udsend massevarslinger om prisændring',      gruppe: 'regulering', status: 'done',    note: 'POST /varslinger/simuler + /send. 30-dages lovkrav valideres.' },
  { id: 'UC-38', titel: 'Implementer regulativændring (ny fraktion)', gruppe: 'regulering', status: 'partial', note: 'Genbruger varsling + manuel beholderbytte. Massekontrakt-update mangler.' },
  { id: 'UC-39', titel: 'Indsend ADS-indberetning',                   gruppe: 'regulering', status: 'done',    note: 'POST /renovation/ads/beregn + /godkend + /indsend.' },
  { id: 'UC-40', titel: 'Automatisk prisbladsaktivering',             gruppe: 'regulering', status: 'partial', note: 'Manuel /prisblade/:id/godkend findes. Cron til auto-aktivering ved ikrafttrædelse mangler.' },

  // GROUP 6 — Rapportering
  { id: 'UC-41', titel: 'Dagsoverblik for driftskoordinator',         gruppe: 'overblik', status: 'done',    note: 'Dashboard med KPI-tiles + sage-arbejdsbord.' },
  { id: 'UC-42', titel: 'Overblik for afregningsansvarlig',           gruppe: 'overblik', status: 'partial', note: 'Dashboard og fakturakørsel-side. Årshjul + dedikeret rolleview mangler.' },
  { id: 'UC-43', titel: 'Audit-trail og historik',                    gruppe: 'overblik', status: 'done',    note: 'GET /audit med filtre på entitet/handling/bruger + UI.' },

  // ─── ChatGPT-supplerende UCs der er relevante for Settl (afregning/kunde/compliance) ───
  { id: 'UC-45', titel: 'Vægtdata pr. tømning (brutto/tara/netto)',   gruppe: 'drift',     status: 'done',    note: 'tomninger.vaegt_kg + vaegt_estimeret findes. Webhook-providers leverer det.' },
  { id: 'UC-49', titel: 'Sorteringsguide i Zerv',                     gruppe: 'support',   status: 'done',    note: 'GET /ordninger/sortering/sog?q=… returnerer "hvor skal X hen" med 17 indslag.' },
  { id: 'UC-50', titel: 'Genbrugsplads erhvervsbetaling',             gruppe: 'afregning', status: 'done',    note: 'POST /genbrugsplads + auto-pris til erhverv (1,50 kr/kg el. 250 kr/besøg) + misbrugsdetektion.' },
  { id: 'UC-51', titel: 'Farligt affald som dedikeret flow',          gruppe: 'support',   status: 'done',    note: 'POST /ordninger/farligt-affald + sikkerhedsinstruktioner. Sag m. høj prioritet.' },
  { id: 'UC-52', titel: 'Haveaffald sæsonabonnement',                 gruppe: 'stamdata',  status: 'done',    note: 'POST /ordninger/haveaffald/abonnement opretter kontrakt m/ saeson_fra/saeson_til + havebeholder.' },
  { id: 'UC-53', titel: 'Pay-as-you-throw (vægtbaseret afregning)',   gruppe: 'afregning', status: 'done',    note: 'prisblade.afregningsmodel = "vægt" + kr/kg pr. fraktion + minimumsgebyr. Simulering m. /payt/simulér.' },
  { id: 'UC-54', titel: 'Gebyrsimulering + hvile-i-sig-selv',         gruppe: 'regulering',status: 'done',    note: 'POST /stats/gebyr-simuler + GET /stats/hvile-i-sig-selv (dækningsgrad, takst-anbefaling).' },
  { id: 'UC-55', titel: 'Boligadministrator-portal',                  gruppe: 'support',   status: 'done',    note: 'boligadm_relationer + GET /boligadm/:admin/portefoelje (samlet økonomi på tværs af ejendomme).' },
  { id: 'UC-56', titel: 'Fuldmagt / adgangsdeling',                   gruppe: 'stamdata',  status: 'done',    note: 'fuldmagter-tabel m/ rolle (fuld/kun_se/service_kun) + gyldighedsperiode.' },
  { id: 'UC-57', titel: 'Samtykkestyring + kommunikationskanaler',    gruppe: 'support',   status: 'done',    note: 'samtykker pr. (kunde, type, kanal). 5 typer × 5 kanaler. GDPR-compliant.' },
  { id: 'UC-58', titel: 'GDPR-selvbetjening (indsigt/sletning)',      gruppe: 'overblik',  status: 'done',    note: 'GET /gdpr/:id/eksport (Art. 15) + POST /sletteanmodning (Art. 17) + /anonymiser. Politik-overblik.' },
  { id: 'UC-59', titel: 'Sorteringsscore + adfærdsnudging',           gruppe: 'support',   status: 'done',    note: 'GET /stats/sorteringsscore/:kunde — score 0-100 baseret på rest-andel, CO₂-estimat, sammenligning m. snit.' },
  { id: 'UC-60', titel: 'Kundeservice-dashboard',                     gruppe: 'overblik',  status: 'done',    note: 'GET /stats/kundeservice — løsningstid, FCR%, top-10 problemadresser, automatiseringsgrad.' },
  { id: 'UC-61', titel: 'Miljø- og affaldsdashboard',                 gruppe: 'overblik',  status: 'done',    note: 'GET /stats/miljo — kg pr. fraktion, genanvendelsesandel, CO₂ sparet, fejlsortering, månedlig trend.' },
  { id: 'UC-63', titel: 'Standardbreve & skabeloner',                 gruppe: 'support',   status: 'done',    note: '6 default-skabeloner (rykker/velkomst/godkendelse/afslag/varsling). Mustache-fletning {{kunde_navn}} osv.' },
  { id: 'UC-65', titel: 'Bankfilimport + auto-match',                 gruppe: 'afregning', status: 'done',    note: 'POST /bankfil/preview + /import. Heuristik: fakturanr → kunde-id+belob → unikt belob.' },
  { id: 'UC-66', titel: 'Kommunal opkrævningsfil',                    gruppe: 'afregning', status: 'done',    note: 'GET /kommunal-opkraevning/fil — BFE_NR/BBR_ID/adresse/årligt beløb til ejendomsskattebillet.' },

  // ─── ChatGPT-UCs der hører til driftssystemet (RenoWeb/Ivar/Ambitek), ikke Settl ───
  { id: 'UC-44', titel: 'Chauffør-/Field-app m. offline-mode',        gruppe: 'drift', status: 'partial', note: 'Out-of-scope for Settl. Driftssystemet leverer data via webhook (UC-10 implementeret).' },
  { id: 'UC-46', titel: 'IoT/sensor-integration (fyldningsgrad)',     gruppe: 'drift', status: 'partial', note: 'Out-of-scope for Settl. Webhook-arkitektur kan modtage IoT-events fra driftssystemets gateway.' },
  { id: 'UC-47', titel: 'Beholdervask + materiel-lager',              gruppe: 'drift', status: 'partial', note: 'Out-of-scope for Settl (lager-/operations-system). Audit-events kan modtages.' },
  { id: 'UC-48', titel: 'Ruteplanlægning og -optimering',             gruppe: 'drift', status: 'partial', note: 'Out-of-scope for Settl. Planlagte tømninger eksporteres som grundlag (UC-09).' },
  { id: 'UC-62', titel: 'Entreprenørportal m. SLA-rapportering',      gruppe: 'drift', status: 'partial', note: 'Out-of-scope for Settl. Driftssystemet ejer entreprenør-relationen.' },
  { id: 'UC-64', titel: 'AI-assistent + anomalidetektion',            gruppe: 'overblik',status: 'partial', note: 'Defererer — kræver LLM-budget. Anomalidetektion på vægt findes delvist i /genbrugsplads/stats.' },
];

router.get('/', async (req, res, next) => {
  try {
    // Live tællere så coverage-status er beriget med rigtige tal.
    const counts = await Promise.all([
      one(`SELECT COUNT(*)::int AS n FROM kunder`),
      one(`SELECT COUNT(*)::int AS n FROM kontrakter WHERE status='aktiv'`),
      one(`SELECT COUNT(*)::int AS n FROM tomninger`),
      one(`SELECT COUNT(*)::int AS n FROM webhook_log`),
      one(`SELECT COUNT(*)::int AS n FROM fakturaer`),
      one(`SELECT COUNT(*)::int AS n FROM kreditnotaer`),
      one(`SELECT COUNT(*)::int AS n FROM ads_indberetninger`),
      one(`SELECT COUNT(*)::int AS n FROM audit_log`),
      one(`SELECT COUNT(*)::int AS n FROM sager`),
    ]);
    const summary = {
      kunder: counts[0].n,
      aktive_kontrakter: counts[1].n,
      tomninger: counts[2].n,
      webhook_events: counts[3].n,
      fakturaer: counts[4].n,
      kreditnotaer: counts[5].n,
      ads_indberetninger: counts[6].n,
      audit_events: counts[7].n,
      sager: counts[8].n,
    };
    const stats = {
      total: UC.length,
      done: UC.filter(u => u.status === 'done').length,
      partial: UC.filter(u => u.status === 'partial').length,
      missing: UC.filter(u => u.status === 'missing').length,
    };
    res.json({ stats, summary, usecases: UC });
  } catch (e) { next(e); }
});

module.exports = router;
