// OIOUBL 2.02 Invoice-generator til Nemhandel/EAN-modtagere.
// Genererer minimum viable OIOUBL XML — tilstrækkeligt til at validere som UBL Invoice
// og blive accepteret af Nemhandel-AccessPoint i de fleste tilfælde.
// For fuld 100% spec-kompatibilitet skal Schematron-validering tilføjes (out of scope for v1).

function esc(v) {
  if (v == null) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function num(v) {
  return Number(v || 0).toFixed(2);
}

// pg driveren returnerer DATE-felter som Date-objekter — normaliser til "YYYY-MM-DD".
function isoDate(v) {
  if (!v) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

// Identifikation af modtager: EAN bruges hvis tilgængelig (offentlig EAN-mappe),
// ellers CVR. SchemeID-værdier følger OIOUBL endpoint-konventioner.
function endpointForPart(party) {
  if (party.ean) return { schemeID: 'GLN', value: party.ean };
  if (party.cvr) return { schemeID: 'DK:CVR', value: 'DK' + party.cvr };
  return { schemeID: 'DK:CVR', value: 'DK00000000' };
}

function partyXml(label, party) {
  const ep = endpointForPart(party);
  const adr = party.adresse || {};
  return `<cac:${label}>
    <cbc:EndpointID schemeID="${esc(ep.schemeID)}">${esc(ep.value)}</cbc:EndpointID>
    <cac:Party>
      ${party.ean ? `<cbc:EndpointID schemeID="GLN">${esc(party.ean)}</cbc:EndpointID>` : ''}
      <cac:PartyIdentification><cbc:ID schemeID="${esc(ep.schemeID)}">${esc(ep.value)}</cbc:ID></cac:PartyIdentification>
      <cac:PartyName><cbc:Name>${esc(party.navn)}</cbc:Name></cac:PartyName>
      <cac:PostalAddress>
        <cbc:StreetName>${esc(adr.vej || '')}</cbc:StreetName>
        ${adr.husnr ? `<cbc:BuildingNumber>${esc(adr.husnr)}</cbc:BuildingNumber>` : ''}
        <cbc:CityName>${esc(adr.by || '')}</cbc:CityName>
        <cbc:PostalZone>${esc(adr.postnr || '')}</cbc:PostalZone>
        <cac:Country><cbc:IdentificationCode>DK</cbc:IdentificationCode></cac:Country>
      </cac:PostalAddress>
      ${party.cvr ? `<cac:PartyTaxScheme>
        <cbc:CompanyID schemeID="DK:CVR">DK${esc(party.cvr)}</cbc:CompanyID>
        <cac:TaxScheme><cbc:ID>63</cbc:ID><cbc:Name>Moms</cbc:Name></cac:TaxScheme>
      </cac:PartyTaxScheme>` : ''}
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${esc(party.navn)}</cbc:RegistrationName>
        ${party.cvr ? `<cbc:CompanyID schemeID="DK:CVR">DK${esc(party.cvr)}</cbc:CompanyID>` : ''}
      </cac:PartyLegalEntity>
      ${party.email || party.telefon ? `<cac:Contact>
        ${party.telefon ? `<cbc:Telephone>${esc(party.telefon)}</cbc:Telephone>` : ''}
        ${party.email ? `<cbc:ElectronicMail>${esc(party.email)}</cbc:ElectronicMail>` : ''}
      </cac:Contact>` : ''}
    </cac:Party>
  </cac:${label}>`;
}

// invoice: { id (string), fakturanr, fakturadato, forfaldsdato, periode_fra, periode_til, valuta, isCreditNote }
// supplier, customer: { navn, cvr, ean, email, telefon, adresse: {vej, husnr, postnr, by} }
// linjer: [{ beskrivelse, antal, enhed, enhedspris, belob_excl, moms_pct }]
// total: { belob_excl, moms, belob_incl }
function buildInvoiceXml({ invoice, supplier, customer, linjer, total }) {
  const valuta = invoice.valuta || 'DKK';
  const typeCode = invoice.isCreditNote ? '381' : '380';
  const ublUnit = (e) => {
    const map = { stk: 'EA', tomning: 'EA', m3: 'MTQ', kg: 'KGM', 'år': 'ANN' };
    return map[(e || '').toLowerCase()] || 'EA';
  };

  const linjeXml = linjer.map((l, i) => `
    <cac:InvoiceLine>
      <cbc:ID>${i + 1}</cbc:ID>
      <cbc:InvoicedQuantity unitCode="${ublUnit(l.enhed)}">${num(l.antal)}</cbc:InvoicedQuantity>
      <cbc:LineExtensionAmount currencyID="${valuta}">${num(l.belob_excl)}</cbc:LineExtensionAmount>
      <cac:Item>
        <cbc:Description>${esc(l.beskrivelse)}</cbc:Description>
        <cbc:Name>${esc(l.beskrivelse)}</cbc:Name>
        <cac:ClassifiedTaxCategory>
          <cbc:ID schemeID="urn:oioubl:id:taxcategoryid-1.1">StandardRated</cbc:ID>
          <cbc:Percent>${num(l.moms_pct)}</cbc:Percent>
          <cac:TaxScheme><cbc:ID>63</cbc:ID><cbc:Name>Moms</cbc:Name></cac:TaxScheme>
        </cac:ClassifiedTaxCategory>
      </cac:Item>
      <cac:Price>
        <cbc:PriceAmount currencyID="${valuta}">${num(l.enhedspris)}</cbc:PriceAmount>
      </cac:Price>
    </cac:InvoiceLine>`).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:UBLVersionID>2.0</cbc:UBLVersionID>
  <cbc:CustomizationID>OIOUBL-2.02</cbc:CustomizationID>
  <cbc:ProfileID schemeAgencyID="320" schemeID="urn:oioubl:id:profileid-1.2">Procurement-BilSim-1.0</cbc:ProfileID>
  <cbc:ID>${esc(invoice.fakturanr || invoice.id)}</cbc:ID>
  <cbc:IssueDate>${isoDate(invoice.fakturadato)}</cbc:IssueDate>
  <cbc:InvoiceTypeCode listAgencyID="320" listID="urn:oioubl:codelist:invoicetypecode-1.1">${typeCode}</cbc:InvoiceTypeCode>
  <cbc:Note>Periode: ${isoDate(invoice.periode_fra)} – ${isoDate(invoice.periode_til)}</cbc:Note>
  <cbc:DocumentCurrencyCode>${valuta}</cbc:DocumentCurrencyCode>
  ${partyXml('AccountingSupplierParty', supplier)}
  ${partyXml('AccountingCustomerParty', customer)}
  <cac:PaymentMeans>
    <cbc:ID>1</cbc:ID>
    <cbc:PaymentMeansCode listID="urn:oioubl:codelist:paymentmeanscode-1.1">31</cbc:PaymentMeansCode>
    <cbc:PaymentDueDate>${isoDate(invoice.forfaldsdato)}</cbc:PaymentDueDate>
  </cac:PaymentMeans>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="${valuta}">${num(total.moms)}</cbc:TaxAmount>
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="${valuta}">${num(total.belob_excl)}</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="${valuta}">${num(total.moms)}</cbc:TaxAmount>
      <cac:TaxCategory>
        <cbc:ID schemeID="urn:oioubl:id:taxcategoryid-1.1">StandardRated</cbc:ID>
        <cbc:Percent>25.00</cbc:Percent>
        <cac:TaxScheme><cbc:ID>63</cbc:ID><cbc:Name>Moms</cbc:Name></cac:TaxScheme>
      </cac:TaxCategory>
    </cac:TaxSubtotal>
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="${valuta}">${num(total.belob_excl)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="${valuta}">${num(total.belob_excl)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="${valuta}">${num(total.belob_incl)}</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="${valuta}">${num(total.belob_incl)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
  ${linjeXml}
</Invoice>`;
}

module.exports = { buildInvoiceXml };
