// /api/generate-pdf.js
// BrokerOS — PDF Generation Endpoint (server-side assembly)
// Deploy to Vercel — set PDFSHIFT_API_KEY in environment variables.
//
// TRANSPORT: form-urlencoded only (application/json is WAF-blocked on this route).
//   New model:  payload=<url-encoded JSON>   -> endpoint fetches template, fills,
//               builds rows, computes ALL math, calls PDFShift, returns the PDF.
//   Legacy:     html_content=<full HTML>      -> still supported (pre-filled HTML).
//
// Contract: docs/BPO-PAYLOAD-SCHEMA.md  (OC sends raw data + prose only; the endpoint
// is the sole authority on every derived value and all HTML assembly.)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Maps (geocode + static-map fetches) add a few seconds before the PDFShift render.
export const config = { maxDuration: 60 };

// ---- Deploy marker (GET / ?version returns this) ---------------------------
const VERSION = '2026-06-28-om-2';

// The template ships INSIDE the function bundle (vercel.json includeFiles) and is read from the local
// filesystem so every render uses the just-deployed version — no GitHub-raw CDN cache window (which once
// made a deployed template change look "not applied"). Falls back to fetching the raw URL if the local
// file is unreadable for any reason, preserving the previous behavior as a safety net.
const __dirname = dirname(fileURLToPath(import.meta.url));
let _tplCache;
function loadLocalTemplate() {
  if (_tplCache !== undefined) return _tplCache;
  try { _tplCache = readFileSync(join(__dirname, '..', 'brokeros-template.html'), 'utf8'); }
  catch (_) { _tplCache = null; }
  return _tplCache;
}

// ---- Per-broker registry (identity + branding + template) -------------------
const BROKERS = {
  eagen: {
    name: 'Jessie Eagen',
    phone: '406.542.1811',
    email: 'jessie@jessieeagen.com',
    template_url: 'https://raw.githubusercontent.com/JoeKal97/brokeros-config/main/brokeros-template.html',
    // Bio-page headshot (pilot: hardcoded public URL in the brokeros-photos bucket). Empty -> the
    // grey avatar placeholder renders, unchanged. Per-broker branding record comes with onboarding.
    headshot_url: 'https://rnswcjeqbnmuretlukvw.supabase.co/storage/v1/object/public/brokeros-photos/broker-branding/Jessie%20Eagen%20Headshot.jpg',
    branding: {
      primary_color: '#E8702A',
      secondary_color: '#000000',
      heading_font: 'Playfair Display',
      body_font: 'Barlow'
    }
  }
};

const PUBLIC_FUNDING_DEFAULT =
  'Eligibility for public incentive programs should be verified with the City of Missoula Planning Department.';

const PAGINATION_CSS =
  '<style id="brokeros-pagination-fix">' +
  '.page-wrapper{display:block;padding:0;}' +
  '.page{margin:0 auto;break-after:page;page-break-after:always;break-inside:avoid;page-break-inside:avoid;}' +
  '.page:last-child{break-after:auto;page-break-after:auto;}' +
  '.page-label{display:none !important;}' +  // dev-only "Page N — Section" markers must never print on a client doc
  '.exec-photo-num,.section-num{display:none !important;}' +  // option B: no page/section numbers anywhere, incl. decorative in-image badges ("06", "Section N")
  '</style>';

// ---- Formatting + math helpers (endpoint is the authority) ------------------
const DASH = '\u2014';
const isNum = (n) => typeof n === 'number' && isFinite(n);
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const money = (n) => isNum(n) ? '$' + Math.round(n).toLocaleString('en-US') : DASH;
const psf   = (n) => isNum(n) ? '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : DASH;
const sfNum = (n) => isNum(n) ? Math.round(n).toLocaleString('en-US') : DASH;
const sfUnit= (n) => isNum(n) ? Math.round(n).toLocaleString('en-US') + ' SF' : DASH;
const pct   = (n, dp = 1) => isNum(n) ? n.toFixed(dp) + '%' : DASH;
const intf  = (n) => isNum(n) ? Math.round(n).toLocaleString('en-US') : DASH;
const yearf = (n) => isNum(n) ? String(Math.round(n)) : DASH;  // A7: years must NOT be thousands-formatted (1968, not 1,968)
const MON_S = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MON_L = ['January','February','March','April','May','June','July','August','September','October','November','December'];
function dateFmt(iso, short = false) {
  if (!iso) return DASH;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return esc(iso);
  return (short ? MON_S : MON_L)[d.getUTCMonth()] + ' ' + d.getUTCDate() + ', ' + d.getUTCFullYear();
}
const num = (v) => isNum(v) ? v : null;
const perSf = (v, bldg) => (isNum(v) && isNum(bldg) && bldg > 0) ? v / bldg : null;

// ---- Row builders (Bucket 2) ------------------------------------------------
function buildRentRoll(tenants, building_sf) {
  const list = Array.isArray(tenants) ? tenants : [];
  let rows = '';
  let totSf = 0, totAnnual = 0, totMarket = 0, anyMarket = false, n = 0;
  for (const t of list) {
    const size = num(t.size_sf), annual = num(t.annual_rent), mkt = num(t.market_rent);
    const share = (isNum(size) && isNum(building_sf) && building_sf > 0) ? size / building_sf * 100 : null;
    const mktPsf = (isNum(mkt) && isNum(size) && size > 0) ? mkt / size : null;
    rows +=
      '<tr>' +
      '<td>' + esc(t.suite) + '</td>' +
      '<td>' + esc(t.name) + '</td>' +
      '<td class="right">' + sfNum(size) + '</td>' +
      '<td class="right">' + pct(share, 1) + '</td>' +
      '<td class="right">' + psf(num(t.rent_psf)) + '</td>' +
      '<td class="right">' + money(mkt) + '</td>' +
      '<td class="right">' + psf(mktPsf) + '</td>' +
      '<td class="right">' + money(annual) + '</td>' +
      '<td class="right">' + dateFmt(t.lease_start, true) + '</td>' +
      '<td class="right">' + dateFmt(t.lease_end, true) + '</td>' +
      '</tr>';
    if (isNum(size)) totSf += size;
    if (isNum(annual)) totAnnual += annual;
    if (isNum(mkt)) { totMarket += mkt; anyMarket = true; }
    n++;
  }
  const totShare = (isNum(building_sf) && building_sf > 0) ? totSf / building_sf * 100 : null;
  const avgSf = n ? totSf / n : null;
  const avgShare = (n && isNum(totShare)) ? totShare / n : null;
  const avgPsf = (totSf > 0) ? totAnnual / totSf : null;
  const avgAnnual = n ? totAnnual / n : null;
  // A4: market-rent AVERAGES. RR_AVG_MKT = total market rent / number of tenants.
  //     RR_AVG_MKTSF = WEIGHTED = total market rent / total SF (matches RR_AVG_PSF).
  //     The per-SF TOTALS cells (RR_TOTAL_PSF, RR_TOTAL_MKTSF) stay blank by design.
  const avgMarket = (anyMarket && n) ? totMarket / n : null;
  const avgMktSf  = (anyMarket && totSf > 0) ? totMarket / totSf : null;
  return {
    RENT_ROLL_ROWS: rows,
    RR_TOTAL_SF: sfNum(totSf || null), RR_TOTAL_PCT: pct(totShare, 1), RR_TOTAL_PSF: DASH,
    RR_TOTAL_MKT: anyMarket ? money(totMarket) : DASH, RR_TOTAL_MKTSF: DASH,
    RR_TOTAL_ANNUAL: money(totAnnual || null),
    RR_AVG_SF: sfNum(avgSf), RR_AVG_PCT: pct(avgShare, 1), RR_AVG_PSF: psf(avgPsf),
    RR_AVG_MKT: anyMarket ? money(avgMarket) : DASH,
    RR_AVG_MKTSF: anyMarket ? psf(avgMktSf) : DASH,
    RR_AVG_ANNUAL: money(avgAnnual)
  };
}

function statusBadge(status) {
  const map = {
    sold: ['sold', 'Sold'], on_market: ['on-market', 'On Market'], 'on-market': ['on-market', 'On Market'],
    active: ['on-market', 'On Market'], contract: ['contract', 'Under Contract'],
    under_contract: ['contract', 'Under Contract']
  };
  return map[String(status || '').toLowerCase()] || ['sold', 'Sale Comp'];
}

function compBlock(c, idx, mapUri) {
  const [cls, label] = statusBadge(c.status);
  const miniMap = mapUri ? '<img src="' + mapUri + '" alt="map" />' : '';
  const photo = c.photo_url
    ? '<div class="comp-photo"><img src="' + esc(c.photo_url) + '" alt="comp" /></div>'
    : '<div class="comp-photo"><div class="comp-photo-ph">Comp Photo</div></div>';
  return (
    '<div class="comp-row">' +
    '<div class="comp-num">' + idx + '</div>' +
    photo +
    '<div class="comp-info">' +
    '<div class="comp-name">' + esc(c.address) + '</div>' +
    '<div class="comp-address-text">' + esc(c.city_state) + '</div>' +
    '<span class="comp-badge ' + cls + '">' + esc(label) + '</span>' +
    '<div class="comp-specs">' +
    '<div class="comp-spec-item">Price: <span>' + money(num(c.price)) + '</span></div>' +
    '<div class="comp-spec-item">Bldg Size: <span>' + sfUnit(num(c.building_sf)) + '</span></div>' +
    '<div class="comp-spec-item">Lot Size: <span>' + sfUnit(num(c.lot_sf)) + '</span></div>' +
    '<div class="comp-spec-item">No. Units: <span>' + intf(num(c.units)) + '</span></div>' +
    '<div class="comp-spec-item">Cap Rate: <span>' + pct(num(c.cap_rate), 2) + '</span></div>' +
    '<div class="comp-spec-item">Year Built: <span>' + yearf(num(c.year_built)) + '</span></div>' +
    '</div></div><div class="comp-mini-map">' + miniMap + '</div></div>'
  );
}

function buildComps(comps, compMaps = []) {
  const list = Array.isArray(comps) ? comps.slice(0, 6) : [];
  const out = {};
  for (let i = 0; i < 6; i++) out['COMP_' + (i + 1) + '_ROW'] = list[i] ? compBlock(list[i], i + 1, compMaps[i]) : '';
  let summary = '', sp = 0, sb = 0, sl = 0, np = 0, nb = 0, nl = 0;
  for (const c of list) {
    summary +=
      '<tr><td>' + esc(c.address) + (c.city_state ? ', ' + esc(c.city_state) : '') + '</td>' +
      '<td>' + money(num(c.price)) + '</td><td>' + sfNum(num(c.building_sf)) + '</td>' +
      '<td>' + sfNum(num(c.lot_sf)) + '</td><td>' + intf(num(c.units)) + '</td>' +
      '<td>' + pct(num(c.cap_rate), 2) + '</td></tr>';
    if (isNum(c.price)) { sp += c.price; np++; }
    if (isNum(c.building_sf)) { sb += c.building_sf; nb++; }
    if (isNum(c.lot_sf)) { sl += c.lot_sf; nl++; }
  }
  out.COMPS_SUMMARY_ROWS = summary;
  out.COMP_AVG_PRICE = np ? money(sp / np) : DASH;
  out.COMP_AVG_BLDG = nb ? sfNum(sb / nb) : DASH;
  out.COMP_AVG_LOT = nl ? sfNum(sl / nl) : DASH;
  return out;
}

// Subject photos: an <img> when a photo URL is present, else the ORIGINAL grey placeholder for
// that slot so a no-photo BPO still renders unchanged. PDFShift fetches the public URLs.
const COVER_PLACEHOLDER =
  '<div class="cover-photo-placeholder">' +
  '<svg width="60" height="60" viewBox="0 0 24 24" fill="currentColor"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>' +
  '<span>Property Photo</span></div>';
// Per-slot placeholders — must match the template's original markup so no-photo BPOs are identical.
const SLOT_PLACEHOLDERS = {
  exec: '<div class="exec-photo-placeholder">Property Photo — Aerial View</div>',
  val: '<div class="val-col-right-photo-placeholder">Property Photo</div>',
  divider: '<div class="divider-photo-placeholder">Property Photo</div>',
  comps: '<div class="comp-photo-ph">Subject Photo</div>',
};
// Bio-page headshot placeholder — identical to the template's original grey avatar so a broker
// with no headshot_url renders exactly as before.
const HEADSHOT_PLACEHOLDER =
  '<div style="width:100%;height:100%;background:linear-gradient(135deg,#555,#333);display:flex;align-items:center;justify-content:center;">' +
  '<svg width="40" height="40" viewBox="0 0 24 24" fill="rgba(255,255,255,0.2)"><path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z"/></svg></div>';
function slotPhoto(url, placeholder) {
  return (url && /^https?:\/\//i.test(String(url)))
    ? '<img src="' + esc(url) + '" alt="Subject property" style="width:100%;height:100%;object-fit:cover;display:block;" />'
    : placeholder;
}
// Collect the subject photo URLs from the payload (photo_urls[] preferred; photo_url is the
// single-photo back-compat). Returns http(s) URLs only, in order (index 0 = the cover hero).
function subjectPhotoUrls(s) {
  let urls = Array.isArray(s.photo_urls) ? s.photo_urls : (s.photo_url ? [s.photo_url] : []);
  return urls.filter((u) => u && /^https?:\/\//i.test(String(u)));
}
// Distribute the uploaded subject photos across the 9 subject-photo slots. cover = hero (index 0);
// the other 8 slots cycle through the photos (starting at index 1 so extras get showcased, then
// REUSING photos so a photo'd BPO never shows grey boxes). No photos -> every slot placeholders.
function distributeSubjectPhotos(urls) {
  const slot = { cover: null, exec: null, val: null, div: [null, null, null, null, null], comps: null };
  if (!urls.length) return slot;
  slot.cover = urls[0];
  let i = urls.length > 1 ? 1 : 0;
  const next = () => urls[i++ % urls.length];
  slot.exec = next();
  slot.val = next();
  for (let d = 0; d < 5; d++) slot.div[d] = next();
  slot.comps = next();
  return slot;
}

// ---- Build the full {{VARIABLE}} map from the payload -----------------------
function buildVars(payload, broker, maps = {}) {
  const s = payload.subject || {};
  const nar = payload.narratives || {};
  const sp = distributeSubjectPhotos(subjectPhotoUrls(s)); // subject photos across the 9 slots
  const demo = cityDemographics(s); // static per-city demographics (null -> section suppressed)
  const building_sf = num(s.building_sf);
  const asking = num(s.asking_price);
  const list = isNum(num(s.list_price)) ? num(s.list_price) : asking;
  const noi = num(s.noi);
  const capRate = (isNum(noi) && isNum(asking) && asking > 0) ? noi / asking * 100 : null;
  const lot_sf = isNum(num(s.lot_sf)) ? num(s.lot_sf) : (isNum(num(s.acreage)) ? num(s.acreage) * 43560 : null);
  const acreage = isNum(num(s.acreage)) ? num(s.acreage) : (isNum(num(s.lot_sf)) ? num(s.lot_sf) / 43560 : null);
  const full_address = [s.address_line1, s.city_state_zip].filter(Boolean).map(esc).join(', ');
  const considerations = Array.isArray(nar.value_considerations)
    ? nar.value_considerations.map((x) => '<li>' + esc(x) + '</li>').join('')
    : '';

  const vars = {
    PROPERTY_ADDRESS_LINE1: esc(s.address_line1), CITY_STATE_ZIP: esc(s.city_state_zip),
    BROKER_NAME: esc(broker.name), BROKER_PHONE: esc(broker.phone), BROKER_EMAIL: esc(broker.email),
    BROKER_HEADSHOT: slotPhoto(broker.headshot_url, HEADSHOT_PLACEHOLDER),
    CLIENT_NAME: esc(s.client_name), FULL_ADDRESS: full_address, MARKET_NAME: esc(s.market_name),
    ASSET_TYPE: esc(s.asset_type), BUILDING_SF: sfNum(building_sf),
    ACREAGE: isNum(acreage) ? acreage.toFixed(2) : DASH, TOUR_DATE: dateFmt(s.tour_date || new Date().toISOString()),
    VALUE_LOW: money(num(s.value_low)), VALUE_HIGH: money(num(s.value_high)),
    VALUE_LOW_PSF: psf(perSf(num(s.value_low), building_sf)), VALUE_HIGH_PSF: psf(perSf(num(s.value_high), building_sf)),
    LIST_PRICE: money(list), LIST_PRICE_PSF: psf(perSf(list, building_sf)),
    MARKET_DURATION: esc(s.market_duration),
    TARGET_BUYER_NARRATIVE: esc(nar.target_buyer), VALUE_CONSIDERATIONS_LIST: considerations,
    HIGHEST_BEST_USE: esc(nar.highest_best_use), OPTIMAL_BUYER: esc(nar.optimal_buyer),
    RISKS_CONSIDERATIONS: esc(nar.risks), MARKET_OUTLOOK: esc(nar.market_outlook),
    COMP_OVERVIEW_1: esc(nar.comp_overview_1), COMP_OVERVIEW_2: esc(nar.comp_overview_2),
    PUBLIC_FUNDING: nar.public_funding ? esc(nar.public_funding) : PUBLIC_FUNDING_DEFAULT,
    FINANCING_OUTLOOK: esc(nar.financing_outlook),
    PROPERTY_ENTITY_NAME: esc(s.address_line1),
    FIN_PRICE: money(asking), FIN_PRICE_PSF: psf(perSf(asking, building_sf)),
    FIN_CAP_RATE: pct(capRate, 2), FIN_TOTAL_RETURN: money(noi), FIN_OPEX: money(num(s.opex)), FIN_NOI: money(noi),
    SUBJECT_ADDRESS: esc(s.address_line1), SUBJECT_CITY_STATE: esc(s.city_state_zip),
    SUBJECT_PRICE: money(asking), SUBJECT_BLDG_SF: sfUnit(building_sf), SUBJECT_LOT_SF: sfUnit(lot_sf),
    SUBJECT_UNITS: intf(num(s.units)), SUBJECT_CAP: pct(capRate, 2), SUBJECT_YEAR: yearf(num(s.year_built)),
    SUBJECT_PHOTO: slotPhoto(sp.cover, COVER_PLACEHOLDER),
    EXEC_PHOTO: slotPhoto(sp.exec, SLOT_PLACEHOLDERS.exec),
    VAL_PHOTO: slotPhoto(sp.val, SLOT_PLACEHOLDERS.val),
    DIVIDER_PHOTO_1: slotPhoto(sp.div[0], SLOT_PLACEHOLDERS.divider),
    DIVIDER_PHOTO_2: slotPhoto(sp.div[1], SLOT_PLACEHOLDERS.divider),
    DIVIDER_PHOTO_3: slotPhoto(sp.div[2], SLOT_PLACEHOLDERS.divider),
    DIVIDER_PHOTO_4: slotPhoto(sp.div[3], SLOT_PLACEHOLDERS.divider),
    DIVIDER_PHOTO_5: slotPhoto(sp.div[4], SLOT_PLACEHOLDERS.divider),
    COMPS_SUBJECT_PHOTO: slotPhoto(sp.comps, SLOT_PLACEHOLDERS.comps),
    REGIONAL_MAP: maps.regional ? mapImg(maps.regional) : ('Map ' + DASH + ' ' + full_address),
    COMPS_MAP: maps.compsMap ? mapImg(maps.compsMap) : COMPS_MAP_FALLBACK,
    SUBJECT_MINI_MAP: maps.subjectMini ? '<img src="' + maps.subjectMini + '" alt="map" />' : '',
    RING_MAP: maps.ringMap ? mapImg(maps.ringMap) : BULLSEYE_FALLBACK,
    DEMOGRAPHICS_ROWS: demo ? demo.demographics_rows : DEMO_FALLBACK,
    POPULATION_ROWS: demo ? demo.population_rows : POP_FALLBACK,
    HOUSEHOLD_ROWS: demo ? demo.household_rows : HH_FALLBACK,
    INCOME_ROWS: demo ? demo.income_rows : INCOME_FALLBACK
  };
  Object.assign(vars, buildRentRoll(payload.tenants, building_sf));
  Object.assign(vars, buildComps(payload.comps, maps.compMaps || []));
  return vars;
}

function fillTemplate(tpl, vars) {
  let out = tpl;
  for (const k of Object.keys(vars)) {
    out = out.split('{{' + k + '}}').join(vars[k] == null ? '' : String(vars[k]));
  }
  out = out.replace(/\{\{[A-Z0-9_]+\}\}/g, '');
  return out;
}

// ---- Per-city static demographics (no live feed) ---------------------------
// Add a city = drop in an entry keyed by the normalized city name; the subject's city is matched
// against this map. A city WITHOUT an entry SUPPRESSES the demographics section (pages 16-17)
// instead of rendering an empty page. All rings are 1/3/5-mile. Each entry supplies four row
// bodies built with the helpers below:
//   demographics_rows -> page 11 overview table (dRow: <tr>)
//   population_rows / household_rows / income_rows -> page 17 sections (aRow: .analytics-row)
// Cities to come: Kalispell, Helena, Great Falls, Bozeman, Butte, Billings.
const dRow = (label, v1, v3, v5) => `<tr><td>${label}</td><td>${v1}</td><td>${v3}</td><td>${v5}</td></tr>`;
const aRow = (label, v1, v3, v5) =>
  `<div class="analytics-row"><span class="a-label">${label}</span><span class="a-cols"><span class="r">${v1}</span><span class="r">${v3}</span><span class="r">${v5}</span></span></div>`;
const CITY_DEMOGRAPHICS = {
  // Missoula — CoStar (ACS-derived), 1/3/5-mile rings centered on the 819 S Higgins corridor.
  missoula: {
    demographics_rows: [
      dRow('2025 Population', '17,936', '69,118', '95,256'),
      dRow('2025 Households', '8,309', '31,809', '42,211'),
      dRow('Median Age', '32.6', '35.7', '37.1'),
      dRow('Avg HH Income', '$81,453', '$84,573', '$91,511'),
      dRow('Median HH Income', '$56,766', '$62,767', '$70,024'),
      dRow("Bachelor's Degree+", '50%', '43%', '43%'),
    ].join(''),
    population_rows: [
      aRow('2025 Population', '17,936', '69,118', '95,256'),
      aRow('2030 Projection', '18,948', '71,959', '99,272'),
      aRow("Growth '25–'30", '1.1%', '0.8%', '0.8%'),
      aRow('Median Age', '32.6', '35.7', '37.1'),
      aRow("Bachelor's Degree+", '50%', '43%', '43%'),
    ].join(''),
    household_rows: [
      aRow('2025 Households', '8,309', '31,809', '42,211'),
      aRow('Owner Occupied', '3,062', '14,116', '22,116'),
      aRow('Renter Occupied', '5,724', '19,032', '21,915'),
      aRow('Avg HH Size', '1.9', '2.0', '2.1'),
      aRow('Avg Vehicles', '2', '2', '2'),
      aRow('Consumer Spend', '$234.4M', '$930M', '$1.3B'),
    ].join(''),
    income_rows: [
      aRow('Avg HH Income', '$81,453', '$84,573', '$91,511'),
      aRow('Median HH Income', '$56,766', '$62,767', '$70,024'),
      aRow('&lt; $25K', '2,162', '6,238', '7,408'),
      aRow('$25–50K', '1,597', '6,736', '8,465'),
      aRow('$50–75K', '1,223', '5,388', '6,437'),
      aRow('$75–100K', '932', '4,443', '5,807'),
      aRow('$100–125K', '929', '2,956', '4,384'),
      aRow('$125–150K', '261', '1,641', '2,774'),
      aRow('$150–200K', '595', '2,193', '3,634'),
      aRow('$200K+', '608', '2,213', '3,301'),
    ].join(''),
  },
};
const DEMO_FALLBACK = "<tr><td colspan='4'>Demographic data available upon request.</td></tr>";
const POP_FALLBACK = "<div class='analytics-row'><span class='a-label'>Population data available upon request.</span></div>";
const HH_FALLBACK = "<div class='analytics-row'><span class='a-label'>Household data available upon request.</span></div>";
const INCOME_FALLBACK = "<div class='analytics-row'><span class='a-label'>Income data available upon request.</span></div>";

function cityKey(subject) {
  return String((subject && subject.city_state_zip) || '').split(',')[0].trim().toLowerCase();
}
function cityDemographics(subject) {
  return CITY_DEMOGRAPHICS[cityKey(subject)] || null;
}

// Optional-page suppression: any page wrapped in <!--OPT:name-->...<!--/OPT:name--> is kept only if
// keep[name] !== false. Generalizes "render only if the data is present" — comp page 2 (>3 comps),
// the demographics section (a city page exists). Run AFTER fillTemplate (markers are HTML comments,
// untouched by var-filling). Unknown marker names default to KEEP (never silently drop a page).
function applyOptionalPages(html, keep) {
  return html.replace(/<!--OPT:([a-z0-9_]+)-->([\s\S]*?)<!--\/OPT:\1-->/gi,
    (_m, name, body) => (keep[name] === false ? '' : body));
}
function optionalPages(payload) {
  const comps = Array.isArray(payload.comps) ? payload.comps.slice(0, 6) : [];
  return {
    comps_page_2: comps.length > 3,                       // 2nd comp page only when comps 4-6 exist
    demographics: !!cityDemographics(payload.subject || {}), // only when the city has a static page
  };
}

// ---- Google Maps (Geocoding + Static Maps) ---------------------------------
// SECURITY: the API key is read from env and used ONLY in server-side fetches here. The fetched
// map images are embedded as base64 data-URIs, so the key NEVER appears in the HTML/PDF output or
// reaches PDFShift. Any geocode/fetch failure returns null and the slot keeps its placeholder.
const GMAPS_GEOCODE = 'https://maps.googleapis.com/maps/api/geocode/json';
const GMAPS_STATIC = 'https://maps.googleapis.com/maps/api/staticmap';
const MAP_ORANGE = '0xE8702A';

async function geocode(address, key) {
  if (!address) return null;
  try {
    const r = await fetch(`${GMAPS_GEOCODE}?address=${encodeURIComponent(address)}&key=${key}`);
    if (!r.ok) return null;
    const j = await r.json();
    const loc = j && j.status === 'OK' && j.results && j.results[0] && j.results[0].geometry && j.results[0].geometry.location;
    return loc ? `${loc.lat},${loc.lng}` : null;
  } catch { return null; }
}
async function staticMap(params, key) {
  try {
    const r = await fetch(`${GMAPS_STATIC}?${params.join('&')}&key=${key}`);
    if (!r.ok) return null;
    if (!(r.headers.get('content-type') || '').includes('image')) return null; // Google returns text on error
    return 'data:image/png;base64,' + Buffer.from(await r.arrayBuffer()).toString('base64');
  } catch { return null; }
}
const mk = (color, label, loc) => `markers=${encodeURIComponent('color:' + color + (label ? '|label:' + label : '') + '|' + loc)}`;
const parseLoc = (s) => { const a = String(s || '').split(',').map(Number); return (a.length === 2 && a.every(Number.isFinite)) ? a : null; };
// Padded bounding-box `visible=` so Static Maps frames EVERY point with margin (markers alone fit
// tight and clip edge pins). points = ["lat,lng", ...].
function fitVisible(points, padFrac = 0.18) {
  const pts = points.map(parseLoc).filter(Boolean);
  if (!pts.length) return null;
  let minLa = Infinity, maxLa = -Infinity, minLn = Infinity, maxLn = -Infinity;
  for (const [la, ln] of pts) { minLa = Math.min(minLa, la); maxLa = Math.max(maxLa, la); minLn = Math.min(minLn, ln); maxLn = Math.max(maxLn, ln); }
  const pLa = ((maxLa - minLa) || 0.01) * padFrac, pLn = ((maxLn - minLn) || 0.01) * padFrac;
  const sw = `${(minLa - pLa).toFixed(6)},${(minLn - pLn).toFixed(6)}`, ne = `${(maxLa + pLa).toFixed(6)},${(maxLn + pLn).toFixed(6)}`;
  return `visible=${encodeURIComponent(sw + '|' + ne)}`;
}
// A geographic circle as a closed many-point polygon `path` (Static Maps has no circle primitive).
// fill = 0xRRGGBBAA (translucent). radiusMi around (lat,lng). ~1deg lat = 69mi; lng scaled by cos(lat).
function circlePath(lat, lng, radiusMi, fill) {
  const N = 44, pts = [];
  const dLatBase = radiusMi / 69, dLngBase = radiusMi / (69 * Math.cos(lat * Math.PI / 180));
  for (let i = 0; i <= N; i++) {
    const a = 2 * Math.PI * i / N;
    pts.push((lat + dLatBase * Math.cos(a)).toFixed(5) + ',' + (lng + dLngBase * Math.sin(a)).toFixed(5));
  }
  return `path=${encodeURIComponent(`fillcolor:${fill}|color:0xE8702A66|weight:1|` + pts.join('|'))}`;
}

// Geocode the subject + comps once, then build the regional map, the all-comps map, and per-comp
// thumbnails in parallel. Returns { regional, compsMap, compMaps[] } as data-URIs (or null each).
async function buildMaps(payload, key) {
  const empty = { regional: null, compsMap: null, compMaps: [] };
  if (!key) return empty;
  const s = payload.subject || {};
  const comps = Array.isArray(payload.comps) ? payload.comps.slice(0, 6) : [];
  const subjAddr = [s.address_line1, s.city_state_zip].filter(Boolean).join(', ');
  // Comp geocode: if a comp has no city of its own, fall back to the subject's city/state (comps are
  // in the same market) so a street-only comp still geocodes and gets a marker.
  const [subjLoc, ...compLocs] = await Promise.all([
    geocode(subjAddr, key),
    ...comps.map((c) => geocode([c.address, c.city_state || s.city_state_zip].filter(Boolean).join(', '), key)),
  ]);
  const validCompLocs = compLocs.filter(Boolean);

  const regionalP = subjLoc
    ? staticMap([`center=${encodeURIComponent(subjLoc)}`, 'zoom=13', 'size=640x400', 'scale=2', mk(MAP_ORANGE, '', subjLoc)], key)
    : Promise.resolve(null);

  // Sale Comps Map: subject (S) + every comp (numbered) framed by a PADDED bounding box that
  // includes all of them (explicit visible= so no pin is clipped at the edge).
  const compMarkers = [];
  if (subjLoc) compMarkers.push(mk('red', 'S', subjLoc));
  compLocs.forEach((loc, i) => { if (loc) compMarkers.push(mk(MAP_ORANGE, String(i + 1), loc)); });
  const fit = fitVisible([subjLoc, ...validCompLocs].filter(Boolean));
  const compsMapP = compMarkers.length
    ? staticMap(['size=640x400', 'scale=2', ...(fit ? [fit] : []), ...compMarkers], key)
    : Promise.resolve(null);

  // Demographics RING map: real street map of the subject area with 1/3/5-mile rings overlaid as
  // translucent circle polygons; framed to the 5-mile ring. Largest ring first so smaller draw on top.
  let ringMapP = Promise.resolve(null);
  const sloc = parseLoc(subjLoc);
  if (sloc) {
    const [la, ln] = sloc;
    const ringVisible = fitVisible([
      `${la + 5 / 69},${ln}`, `${la - 5 / 69},${ln}`,
      `${la},${ln + 5 / (69 * Math.cos(la * Math.PI / 180))}`, `${la},${ln - 5 / (69 * Math.cos(la * Math.PI / 180))}`,
    ], 0.06);
    ringMapP = staticMap([
      'size=600x520', 'scale=2', ...(ringVisible ? [ringVisible] : []),
      circlePath(la, ln, 5, '0xE8702A14'), circlePath(la, ln, 3, '0xE8702A1F'), circlePath(la, ln, 1, '0xE8702A33'),
      mk(MAP_ORANGE, '', subjLoc),
    ], key);
  }

  // subject thumbnail for the comps-page subject row (same size as the comp thumbnails)
  const subjectMiniP = subjLoc
    ? staticMap([`center=${encodeURIComponent(subjLoc)}`, 'zoom=15', 'size=200x130', 'scale=2', mk(MAP_ORANGE, '', subjLoc)], key)
    : Promise.resolve(null);

  const compMapsP = compLocs.map((loc) => loc
    ? staticMap([`center=${encodeURIComponent(loc)}`, 'zoom=15', 'size=200x130', 'scale=2', mk(MAP_ORANGE, '', loc)], key)
    : Promise.resolve(null));

  const [regional, compsMap, ringMap, subjectMini, ...compMaps] = await Promise.all([regionalP, compsMapP, ringMapP, subjectMiniP, ...compMapsP]);
  return { regional, compsMap, ringMap, subjectMini, compMaps };
}
const mapImg = (uri) => '<img src="' + uri + '" alt="Map" style="width:100%;height:100%;object-fit:cover;display:block;" />';
const COMPS_MAP_FALLBACK = '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:rgba(0,0,0,0.15);font-family:\'Barlow Condensed\',sans-serif;font-size:13px;letter-spacing:0.1em;text-transform:uppercase;">Comps Map</div>';
// Ring-map fallback = the original decorative bullseye, so a no-key/failed render looks unchanged.
const BULLSEYE_FALLBACK =
  '<div class="analytics-map-placeholder"><div style="width:340px;height:340px;position:relative;display:flex;align-items:center;justify-content:center;">' +
  '<div style="width:340px;height:340px;border-radius:50%;background:rgba(212,89,10,0.12);position:absolute;"></div>' +
  '<div style="width:220px;height:220px;border-radius:50%;background:rgba(212,89,10,0.18);position:absolute;"></div>' +
  '<div style="width:110px;height:110px;border-radius:50%;background:rgba(212,89,10,0.28);position:absolute;"></div>' +
  '<div style="width:10px;height:10px;border-radius:50%;background:var(--orange);position:absolute;"></div>' +
  '</div></div>';

// ============================================================================
// OM (Offering Memorandum) ASSEMBLY  —  doc_type === "om"
// Same machine as the BPO: bundled template, {{TOKEN}} fill, <!--OPT--> pages,
// form-urlencoded payload=, server-side math. Portrait 8.5x11.
// Contract: docs/OM-PAYLOAD-SCHEMA.md
// ============================================================================

// OM template ships in the function bundle (vercel.json includeFiles), same pattern as the BPO.
const OM_TEMPLATE_URL = 'https://raw.githubusercontent.com/JoeKal97/brokeros-config/main/brokeros-om-template.html';
let _omTplCache;
function loadLocalOmTemplate() {
  if (_omTplCache !== undefined) return _omTplCache;
  try { _omTplCache = readFileSync(join(__dirname, '..', 'brokeros-om-template.html'), 'utf8'); }
  catch (_) { _omTplCache = null; }
  return _omTplCache;
}

// --- OM small helpers --------------------------------------------------------
const omParas = (txt) => {
  const arr = Array.isArray(txt) ? txt : String(txt == null ? '' : txt).split(/\n\s*\n/);
  return arr.map((p) => String(p).trim()).filter(Boolean).map((p) => '<p class="body">' + esc(p) + '</p>').join('');
};
const httpUrl = (u) => (u && /^https?:\/\//i.test(String(u))) ? String(u) : null;
// Cover/divider/back full-bleed background: a CSS value, or '' (template's dark gradient fallback shows).
const omBg = (u) => httpUrl(u) ? "background-image:url('" + esc(httpUrl(u)) + "')" : '';
// Content <img> for a URL (or a grey placeholder of the same footprint when absent).
function omImg(u, { style = '', cls = 'full-img', phCls = 'img-ph-lg', phText = 'Image' } = {}) {
  const url = httpUrl(u);
  return url
    ? '<img class="' + cls + '" src="' + esc(url) + '"' + (style ? ' style="' + style + '"' : '') + '>'
    : '<div class="' + phCls + '"' + (style ? ' style="' + style + '"' : '') + '>' + esc(phText) + '</div>';
}
// Photo grid cells: <img> per URL; pad with grey cells so a sparse page still reads as a grid.
function omGrid(urls, min = 0) {
  const list = (urls || []).map(httpUrl).filter(Boolean);
  let cells = list.map((u) => '<img src="' + esc(u) + '">').join('');
  for (let i = list.length; i < min; i++) cells += '<div class="photo-ph">Photo</div>';
  return cells || '<div class="photo-ph">Photo</div>';
}
const omNote = (txt) => txt ? '<p class="note">' + esc(txt) + '</p>' : '';
const liList = (arr) => (Array.isArray(arr) ? arr : []).map((x) => {
  // allow an optional **bold lead** — text before " — " (em or hyphen) renders bold
  const s = String(x);
  return '<li>' + esc(s) + '</li>';
}).join('');

// --- OM static demographics ring map (rings come from the payload, e.g. 0.5/1/2.5) ----
async function omRingMap(addressFull, ringMiles, key) {
  if (!key || !addressFull || !ringMiles || !ringMiles.length) return null;
  const loc = await geocode(addressFull, key);
  const sloc = parseLoc(loc);
  if (!sloc) return null;
  const [la, ln] = sloc;
  const maxR = Math.max(...ringMiles);
  const visible = fitVisible([
    `${la + maxR / 69},${ln}`, `${la - maxR / 69},${ln}`,
    `${la},${ln + maxR / (69 * Math.cos(la * Math.PI / 180))}`, `${la},${ln - maxR / (69 * Math.cos(la * Math.PI / 180))}`,
  ], 0.08);
  const fills = ['0xE8702A14', '0xE8702A1F', '0xE8702A33'];
  const sorted = [...ringMiles].sort((a, b) => b - a); // largest first so smaller draw on top
  const rings = sorted.map((r, i) => circlePath(la, ln, r, fills[i] || '0xE8702A33'));
  return staticMap(['size=600x540', 'scale=2', ...(visible ? [visible] : []), ...rings, mk(MAP_ORANGE, '', loc)], key);
}
// Satellite aerial (only when no broker-supplied aerial image is given).
async function omSatelliteAerial(addressFull, key) {
  if (!key || !addressFull) return null;
  const loc = await geocode(addressFull, key);
  if (!loc) return null;
  return staticMap([`center=${encodeURIComponent(loc)}`, 'zoom=16', 'size=640x520', 'scale=2', 'maptype=satellite', mk(MAP_ORANGE, '', loc)], key);
}

// --- OM financial math (the endpoint is the sole authority on every number) ---
const capValue = (noi, ratePct) => (isNum(noi) && isNum(ratePct) && ratePct > 0) ? noi / (ratePct / 100) : null;
function amortAnnual(principal, ratePct, years) {
  if (!isNum(principal) || !isNum(years) || years <= 0) return null;
  const r = (ratePct || 0) / 100 / 12, n = years * 12;
  if (!r) return principal / years;
  const f = Math.pow(1 + r, n);
  return principal * r * f / (f - 1) * 12;
}

function omFinanceVars(fin, priceRaw) {
  const cur = (fin && fin.current) || {};
  const pf = (fin && fin.pro_forma) || {};
  const v = {};
  // EGI / NOI fall back to computed values when not explicitly provided.
  const egi = (o) => isNum(num(o.egi)) ? num(o.egi) : (isNum(num(o.gross_rents)) ? num(o.gross_rents) + (num(o.other_income) || 0) : null);
  const noi = (o) => isNum(num(o.noi)) ? num(o.noi) : (isNum(egi(o)) && isNum(num(o.operating_expenses)) ? egi(o) - num(o.operating_expenses) : null);
  const curNoi = noi(cur), pfNoi = noi(pf);
  const curCap = (isNum(curNoi) && isNum(priceRaw) && priceRaw > 0) ? curNoi / priceRaw * 100 : num(cur.cap_rate);
  const pfCap = (isNum(pfNoi) && isNum(priceRaw) && priceRaw > 0) ? pfNoi / priceRaw * 100 : num(pf.cap_rate);
  const grm = (o, n) => isNum(num(o.grm)) ? num(o.grm) : (isNum(priceRaw) && isNum(n) && n > 0 ? priceRaw / n : null);
  const curGrm = grm(cur, num(cur.gross_rents)), pfGrm = grm(pf, num(pf.gross_rents));

  const row3 = (lbl, a, b, hl) => `<tr${hl ? ' class="hl"' : ''}><td>${lbl}</td><td class="r">${a}</td><td class="r">${b}</td></tr>`;
  v.FIN_INCOME_ROWS = [
    row3('Scheduled Gross Rents', money(num(cur.gross_rents)), money(num(pf.gross_rents))),
    row3('Other Income / Recoveries', money(num(cur.other_income)), money(num(pf.other_income))),
    row3('Effective Gross Income', money(egi(cur)), money(egi(pf))),
    row3('Operating Expenses', money(num(cur.operating_expenses)), money(num(pf.operating_expenses))),
    row3('Net Operating Income', money(curNoi), money(pfNoi), true),
  ].join('');
  v.FIN_METRICS_ROWS = [
    row3('Offering Price', money(priceRaw), money(priceRaw)),
    row3('Price / SF', psf(num(cur.price_per_sf)), psf(num(pf.price_per_sf))),
    row3('Cap Rate', pct(curCap, 2), pct(pfCap, 2), true),
    row3('GRM', isNum(curGrm) ? curGrm.toFixed(2) : DASH, isNum(pfGrm) ? pfGrm.toFixed(2) : DASH),
    row3('NOI', money(curNoi), money(pfNoi)),
  ].join('');

  // Cap-rate sensitivity: a standard ladder plus the actual current/pro-forma caps, computed from NOI.
  const ladder = new Set([5.0, 5.5, 6.0, 6.5, 7.0, 7.5, 8.0]);
  if (isNum(curCap)) ladder.add(Math.round(curCap * 100) / 100);
  if (isNum(pfCap)) ladder.add(Math.round(pfCap * 100) / 100);
  const rates = [...ladder].sort((a, b) => a - b);
  const isCap = (r) => (isNum(curCap) && Math.abs(r - curCap) < 0.005) || (isNum(pfCap) && Math.abs(r - pfCap) < 0.005);
  v.CAP_SENSITIVITY_ROWS = rates.map((r) =>
    `<tr${isCap(r) ? ' class="hl"' : ''}><td>${pct(r, 2)}</td><td class="r">${money(capValue(curNoi, r))}</td><td class="r">${money(capValue(pfNoi, r))}</td></tr>`
  ).join('');

  // Debt & cash flow: compute each LTV column from price, rate, amortization, and pro-forma NOI.
  const debt = (fin && fin.debt) || {};
  const ltvs = Array.isArray(debt.ltvs) && debt.ltvs.length ? debt.ltvs : [0.60, 0.65];
  const rate = isNum(num(debt.rate)) ? num(debt.rate) : 6.5;
  const amYears = isNum(num(debt.amortization_years)) ? num(debt.amortization_years) : 25;
  const dNoi = isNum(pfNoi) ? pfNoi : curNoi; // stabilized cash flow
  const cols = ltvs.slice(0, 2).map((ltv) => {
    const loan = isNum(priceRaw) ? priceRaw * ltv : null;
    const equity = (isNum(priceRaw) && isNum(loan)) ? priceRaw - loan : null;
    const ads = amortAnnual(loan, rate, amYears);
    const cf = (isNum(dNoi) && isNum(ads)) ? dNoi - ads : null;
    const coc = (isNum(cf) && isNum(equity) && equity > 0) ? cf / equity * 100 : null;
    const dscr = (isNum(dNoi) && isNum(ads) && ads > 0) ? dNoi / ads : null;
    return { ltv, loan, equity, ads, cf, coc, dscr };
  });
  const drow = (lbl, fn) => `<tr><td>${lbl}</td>` + cols.map((c) => `<td class="r">${fn(c)}</td>`).join('') + '</tr>';
  // header LTV labels are filled by the template; here we just emit body rows
  v.DEBT_ROWS = [
    drow('Loan Amount', (c) => money(c.loan)),
    drow('Equity Required', (c) => money(c.equity)),
    drow('Interest Rate', () => pct(rate, 2)),
    drow('Amortization', () => amYears + ' yrs'),
    drow('Annual Debt Service', (c) => money(c.ads)),
    drow('Cash Flow After Debt Service', (c) => money(c.cf)),
    drow('Cash-on-Cash Return', (c) => pct(c.coc, 2)),
    drow('Debt Coverage Ratio', (c) => isNum(c.dscr) ? c.dscr.toFixed(2) : DASH),
  ].join('');
  // If the payload only supplies 60/65 the template's static "60% LTV / 65% LTV" headers are correct;
  // when other LTVs are supplied we rewrite those header cells later via DEBT_COL headers.
  v.DEBT_COL_1 = (ltvs[0] != null) ? Math.round(ltvs[0] * 100) + '% LTV' : '60% LTV';
  v.DEBT_COL_2 = (ltvs[1] != null) ? Math.round(ltvs[1] * 100) + '% LTV' : '65% LTV';

  v.VALUATION_SUMMARY_ROWS = [
    `<tr class="hl"><th>Offering Price</th><th class="r">${money(priceRaw)}</th></tr>`,
    `<tr><td>Price / SF</td><td class="r">${psf(num(cur.price_per_sf))}</td></tr>`,
    `<tr><td>Current NOI</td><td class="r">${money(curNoi)}</td></tr>`,
    `<tr><td>Current Cap Rate</td><td class="r">${pct(curCap, 2)}</td></tr>`,
    `<tr><td>Pro Forma NOI</td><td class="r">${money(pfNoi)}</td></tr>`,
    `<tr><td>Pro Forma Cap Rate</td><td class="r">${pct(pfCap, 2)}</td></tr>`,
    `<tr><td>GRM (Current)</td><td class="r">${isNum(curGrm) ? curGrm.toFixed(2) : DASH}</td></tr>`,
  ].join('');
  return v;
}

// --- Build the full OM {{TOKEN}} map ----------------------------------------
function buildOmVars(payload, broker, maps = {}) {
  const p = payload.property || {};
  const photos = payload.photos || {};
  const fin = payload.financials || {};
  const market = payload.market || {};
  const demo = payload.demographics || null;
  const pend = new Set(Array.isArray(payload.pending_chips) ? payload.pending_chips : []);
  const pLabel = payload.pending_label || 'TO CONFIRM';
  const chip = (key) => pend.has(key) ? ' <span class="pending">PENDING — ' + esc(pLabel) + '</span>' : '';

  const priceRaw = num(p.price_raw);
  const priceStr = p.price ? esc(p.price) : money(priceRaw);
  const addrFull = p.address || [p.address_line1, p.city_state_zip].filter(Boolean).join(', ');
  // address split: prefer explicit line1/city, else split a combined string on the last comma group
  let line1 = p.address_line1, cityZip = p.city_state_zip;
  if (!line1 && p.address) {
    const parts = String(p.address).split(',');
    line1 = parts.shift().trim();
    cityZip = parts.join(',').trim();
  }

  // photo distribution: cover hero, then property photos cycle through the four section dividers + back.
  const propUrls = (Array.isArray(photos.property_urls) ? photos.property_urls : []).map(httpUrl).filter(Boolean);
  const coverUrl = httpUrl(photos.cover_url) || propUrls[0] || null;
  const pick = (i) => propUrls.length ? propUrls[i % propUrls.length] : null;

  const offeringRows = [
    ['Sale Price', '<b>' + priceStr + '</b>', null],
    ['Address', esc(addrFull), null],
    ['Total Building Area', (p.total_sf ? esc(p.total_sf) : DASH) + chip('total_sf'), null],
    ['Buildings', p.buildings_desc ? esc(p.buildings_desc) : (isNum(num(p.num_buildings)) ? num(p.num_buildings) + ' buildings' : DASH), null],
    ['Site Size', (p.site_acres ? esc(p.site_acres) + ' acres' : DASH).replace(' acres acres', ' acres') + chip('site_acres'), null],
    ['Occupancy', (p.occupancy ? esc(p.occupancy) : DASH) + chip('occupancy'), null],
    ['Parking', p.parking_spaces ? esc(p.parking_spaces) + ' spaces' : DASH, null],
    ['Year Built', p.year_built ? esc(p.year_built) : DASH, null],
    ['Zoning', p.zoning ? esc(p.zoning) : DASH, null],
    ['Ownership Entity', p.ownership_entity ? esc(p.ownership_entity) : DASH, null],
  ].map(([l, val]) => `<tr><td>${l}:</td><td class="r">${val}</td></tr>`).join('');

  // Property profile — buildings list + construction/systems
  const blds = Array.isArray(payload.buildings) ? payload.buildings : [];
  let buildingRows = '';
  if (p.zoning) buildingRows += `<tr><td>Zoning:</td><td class="r">${esc(p.zoning)}</td></tr>`;
  if (p.permitted_uses) buildingRows += `<tr><td>Permitted Uses:</td><td class="r">${esc(p.permitted_uses)}</td></tr>`;
  buildingRows += blds.map((b) => {
    const sf = isNum(num(b.sf)) ? sfNum(num(b.sf)) + ' SF' : (b.sf ? esc(b.sf) : DASH);
    const use = b.use ? ' ' + esc(b.use) : '';
    const c = b.pending ? ' <span class="pending">PENDING — ' + esc(pLabel) + '</span>' : '';
    return `<tr><td>${esc(b.address)}:</td><td class="r">${sf}${use}${c}</td></tr>`;
  }).join('');
  if (p.excluded_note) buildingRows += `<tr><td colspan="2" style="border-bottom:none;padding-top:8px;font-style:italic;color:#777;font-size:9.5px;">${esc(p.excluded_note)}</td></tr>`;

  const constr = payload.construction;
  let constrRows;
  if (Array.isArray(constr) && constr.length) {
    constrRows = constr.map((c) => `<tr><td>${esc(c.label || c[0])}:</td><td class="r">${esc(c.value != null ? c.value : c[1])}</td></tr>`).join('');
  } else if (constr && typeof constr === 'object') {
    constrRows = Object.entries(constr).map(([k, val]) => `<tr><td>${esc(k)}:</td><td class="r">${esc(val)}</td></tr>`).join('');
  } else {
    constrRows = `<tr><td colspan="2">Construction &amp; systems detail available upon request.</td></tr>`;
  }

  // Investment highlights — split across two columns
  const hls = Array.isArray(payload.investment_highlights) ? payload.investment_highlights : [];
  const mid = Math.ceil(hls.length / 2);

  const vars = {
    // identity / branding
    COMPANY: esc(broker.company || broker.name || ''),
    BROKER_NAME: esc(broker.name), BROKER_PHONE: esc(broker.phone), BROKER_EMAIL: esc(broker.email),
    BROKER_WEBSITE: esc(broker.website || ''),
    BROKER_ADDRESS_BLOCK: (broker.address_block || esc(broker.address || '')),
    BROKER_HEADSHOT: omImg(broker.headshot_url, { style: 'width:100%;max-height:4.6in;object-fit:cover;object-position:top', cls: '', phCls: 'photo-ph', phText: 'Headshot' }),
    BROKER_BIO: omParas(broker.bio || payload.broker_bio || ''),
    FOOTER_RIGHT: [broker.address, broker.phone, broker.website ? '<b>' + esc(broker.website) + '</b>' : ''].filter(Boolean)
      .map((x, i) => i === 2 ? x : esc(x)).join(' &nbsp;|&nbsp; '),

    // cover / back
    PRICE: priceStr,
    PROPERTY_NAME: esc(p.name || ''),
    PROPERTY_NAME_BR: esc(p.name || '').replace(/ /g, '<br>'),
    ADDRESS_LINE1: esc(line1 || ''), CITY_STATE_ZIP: esc(cityZip || ''), ADDRESS_FULL: esc(addrFull),
    COVER_PHOTO_STYLE: omBg(coverUrl),
    BACK_PHOTO_STYLE: omBg(httpUrl(photos.back_url) || coverUrl),
    DIVIDER_PHOTO_1_STYLE: omBg(pick(0)), DIVIDER_PHOTO_2_STYLE: omBg(pick(1)),
    DIVIDER_PHOTO_3_STYLE: omBg(pick(2)), DIVIDER_PHOTO_4_STYLE: omBg(pick(3)),

    // property summary
    PROPERTY_DESCRIPTION: omParas(payload.description || p.description || ''),
    OFFERING_SUMMARY_ROWS: offeringRows,
    OFFERING_SUMMARY_NOTE: omNote(p.offering_note),

    // highlights
    HIGHLIGHTS_COL1: liList(hls.slice(0, mid)),
    HIGHLIGHTS_COL2: liList(hls.slice(mid)),
    HIGHLIGHT_PHOTOS: omGrid(propUrls.slice(0, 3), 3),

    // profile
    BUILDING_ROWS: buildingRows,
    CONSTRUCTION_ROWS: constrRows,
    CONSTRUCTION_NOTE: omNote(p.construction_note),

    // photographs
    PHOTO_GRID_1: omGrid(propUrls.slice(0, 9), 3),
    PHOTO_GRID_2: omGrid(propUrls.slice(9, 15)),
    PHOTOS_NOTE: omNote(photos.note),

    // site plan / aerial
    SITE_PLAN_IMG: omImg(httpUrl(photos.site_plan_url), { style: 'max-height:7.2in;max-width:100%', phText: 'Site Plan' }),
    SITE_PLAN_NOTE: omNote(photos.site_plan_note),
    AERIAL_IMG: omImg(httpUrl(photos.aerial_url) || maps.aerial, { style: 'max-height:7.2in;max-width:100%', phText: 'Aerial' }),
    AERIAL_NOTE: omNote(photos.aerial_note),

    // market
    MARKET_TITLE: esc(market.title || (market.city ? market.city + (market.state ? ', ' + market.state : '') : 'Market Overview')),
    MARKET_NARRATIVE: omParas(market.narrative || ''),
    MARKET_PHOTO: omImg(httpUrl(market.photo_url) || pick(4), { style: 'width:100%;height:5.6in;object-fit:cover', cls: '', phCls: 'photo-ph', phText: 'Market Photo' }),
    MARKET_PHOTO_NOTE: omNote(market.photo_caption),

    // financial summary (all server-side math)
    ...omFinanceVars(fin, priceRaw),

    // demographics
    RING_1: demo && demo.rings ? esc(demo.rings[0] || '') : '',
    RING_2: demo && demo.rings ? esc(demo.rings[1] || '') : '',
    RING_3: demo && demo.rings ? esc(demo.rings[2] || '') : '',
    DEMO_MAP_IMG: omImg(httpUrl(photos.demographics_map_url) || maps.demoRing, { style: 'max-height:6.8in;max-width:100%', phText: 'Demographics Map' }),
    DEMO_POP_ROWS: demo ? omDemoRows(demo.population) : '',
    DEMO_HH_ROWS: demo ? omDemoRows(demo.households) : '',
    DEMO_SOURCE: demo && demo.source ? esc(demo.source) : '',

    FIN_NOTE: omNote(fin.note || 'A detailed operating statement, normalized pro forma, and trailing financials will be made available to qualified purchasers upon execution of a confidentiality agreement. All figures are subject to verification in due diligence.'),
  };
  return vars;
}

// Demographics section rows. Accepts either:
//   { labels:[...], "0.5 mi":[...] } style  -> not used; we use the labeled-metric form below.
//   { metric_key: { label, values:[v1,v2,v3] }, ... } OR { label: [v1,v2,v3] }
function omDemoRows(section) {
  if (!section) return '';
  const rows = Array.isArray(section) ? section : Object.entries(section).map(([k, v]) =>
    (v && typeof v === 'object' && !Array.isArray(v)) ? { label: v.label || k, values: v.values || [] } : { label: k, values: v });
  const fmt = (x) => (typeof x === 'number' && isFinite(x)) ? x.toLocaleString('en-US') : esc(x);
  return rows.map((r) => {
    const vals = Array.isArray(r.values) ? r.values : [];
    return `<tr><td>${esc(r.label)}</td>` + [0, 1, 2].map((i) => `<td class="r">${vals[i] != null ? fmt(vals[i]) : DASH}</td>`).join('') + '</tr>';
  }).join('');
}

async function buildOmMaps(payload, key) {
  const p = payload.property || {};
  const photos = payload.photos || {};
  const demo = payload.demographics || null;
  const addrFull = p.address || [p.address_line1, p.city_state_zip].filter(Boolean).join(', ');
  // Geocodable address: a multi-building range like "2673–2687 Palmer St" won't geocode, so collapse
  // the range to its first number (or use an explicit property.geocode_address override).
  const cityZip = p.city_state_zip || (p.address ? String(p.address).split(',').slice(1).join(',').trim() : '');
  const geoAddr = p.geocode_address
    || [String(p.address_line1 || addrFull).replace(/(\d+)\s*[–—-]\s*\d+/, '$1'), cityZip].filter(Boolean).join(', ');
  // Aerial: only generate a satellite map if the broker did NOT supply an aerial image.
  const aerialP = httpUrl(photos.aerial_url) ? Promise.resolve(null) : omSatelliteAerial(geoAddr, key);
  // Demographics ring map: parse ring miles from the ring labels ("0.5 Miles" -> 0.5).
  const ringMiles = demo && Array.isArray(demo.rings)
    ? demo.rings.map((s) => parseFloat(String(s))).filter((n) => isFinite(n)) : [];
  const ringP = demo ? omRingMap(geoAddr, ringMiles, key) : Promise.resolve(null);
  const [aerial, demoRing] = await Promise.all([aerialP, ringP]);
  return { aerial, demoRing };
}

function omOptionalPages(payload) {
  const photos = payload.photos || {};
  const propUrls = (Array.isArray(photos.property_urls) ? photos.property_urls : []).filter((u) => /^https?:\/\//i.test(String(u)));
  return {
    photos2: propUrls.length >= 7,                 // page 8 only when 7+ property photos exist
    siteplan: !!httpUrl(photos.site_plan_url),     // page 9 only when a site plan image is supplied
    demographics: !!payload.demographics,          // pages 16-17 only when demographics data is supplied
  };
}

// Assemble the full OM HTML from a payload. Returns { source, filenameSeed, options }.
async function assembleOm(payload, broker) {
  let tpl = loadLocalOmTemplate();
  if (!tpl) {
    const r = await fetch(OM_TEMPLATE_URL);
    if (!r.ok) throw new Error('OM template fetch failed: HTTP ' + r.status);
    tpl = await r.text();
  }
  const maps = await buildOmMaps(payload, process.env.GOOGLE_MAPS_API_KEY);
  const vars = buildOmVars(payload, broker, maps);
  let source = fillTemplate(tpl, vars);
  // patch the two debt-column headers if non-default LTVs were supplied
  source = source.replace('>60% LTV<', '>' + (vars.DEBT_COL_1 || '60% LTV') + '<')
                 .replace('>65% LTV<', '>' + (vars.DEBT_COL_2 || '65% LTV') + '<');
  source = applyOptionalPages(source, omOptionalPages(payload));
  const p = payload.property || {};
  // OM is portrait by default (landscape:false) unless the payload overrides options.
  const options = Object.assign({ landscape: false }, payload.options || {});
  return { source, filenameSeed: p.name || p.address_line1 || 'offering-memorandum', options };
}

export default async function handler(req, res) {
  // Deploy marker: GET (or ?version) returns the running version + which template source is live
  // (bundle = read from the function bundle, no cache window; raw-fallback = bundled file unreadable).
  if (req.method === 'GET' || req.query && req.query.version !== undefined) {
    return res.status(200).json({ version: VERSION, templateSource: loadLocalTemplate() ? 'bundle' : 'raw-fallback' });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.PDFSHIFT_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'PDF service not configured' });

  const body = req.body || {};
  let source = null;
  let filenameSeed = body.property_address || 'bpo-document';
  let filePrefix = 'bpo';
  let options = {};

  try {
    if (body.payload !== undefined && body.payload !== '') {
      let payload;
      try { payload = JSON.parse(body.payload); }
      catch { return res.status(400).json({ error: 'Invalid payload', detail: 'payload must be a URL-encoded JSON string' }); }

      const baseBroker = BROKERS[payload.broker_id];
      if (!baseBroker) return res.status(400).json({ error: 'Unknown broker_id', detail: String(payload.broker_id) });
      // OM payloads may carry a full broker object (company/website/address/bio); merge it over the registry.
      const broker = payload.broker ? { ...baseBroker, ...payload.broker } : baseBroker;

      if (payload.doc_type === 'om') {
        const om = await assembleOm(payload, broker);   // portrait, OM template, server-side math
        source = om.source;
        filenameSeed = om.filenameSeed;
        filePrefix = 'om';
        options = om.options;
      } else {
        let tpl = loadLocalTemplate();
        if (!tpl) {  // safety net: bundled file unreadable -> fall back to the raw URL (previous behavior)
          const tplResp = await fetch(broker.template_url);
          if (!tplResp.ok) return res.status(502).json({ error: 'Template fetch failed', detail: 'HTTP ' + tplResp.status });
          tpl = await tplResp.text();
        }

        const maps = await buildMaps(payload, process.env.GOOGLE_MAPS_API_KEY); // server-side; null slots keep placeholders
        const vars = buildVars(payload, broker, maps);
        source = fillTemplate(tpl, vars);
        source = applyOptionalPages(source, optionalPages(payload)); // drop unused pages (blank comp page 2, no-city demographics)
        filenameSeed = (payload.subject && payload.subject.address_line1) || 'bpo-document';
        options = payload.options || {};
      }
    } else if (body.html_content !== undefined) {
      source = String(body.html_content);
    } else {
      return res.status(400).json({ error: 'No payload or html_content provided' });
    }

    source = source.replace(/^\uFEFF/, '').trimStart();
    if (!/^(<!doctype|<html|https?:\/\/)/i.test(source)) {
      return res.status(400).json({ error: 'Invalid HTML', detail: 'Rendered source must start with <!DOCTYPE or <html.' });
    }
    if (/<\/head>/i.test(source)) source = source.replace(/<\/head>/i, PAGINATION_CSS + '</head>');
    else if (/<\/body>/i.test(source)) source = source.replace(/<\/body>/i, PAGINATION_CSS + '</body>');
    else source = source + PAGINATION_CSS;

    const lsRaw = options.landscape !== undefined ? options.landscape : body.landscape;
    const landscape = (lsRaw === false || lsRaw === 'false') ? false : true;
    const zRaw = parseFloat(options.zoom !== undefined ? options.zoom : body.zoom);
    const zoom = (!isNaN(zRaw) && zRaw >= 0.1 && zRaw <= 2) ? zRaw : 0.88;
    const margin = (options.margin !== undefined && options.margin !== '') ? options.margin
                 : (body.margin !== undefined && body.margin !== '') ? body.margin : '0';

    const pdfResponse = await fetch('https://api.pdfshift.io/v3/convert/pdf', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + Buffer.from('api:' + apiKey).toString('base64')
      },
      body: JSON.stringify({ source, landscape, zoom, format: 'Letter', margin, delay: 500 })
    });

    if (!pdfResponse.ok) {
      const errorText = await pdfResponse.text();
      console.error('PDFShift error:', errorText);
      return res.status(500).json({ error: 'PDF generation failed', detail: errorText });
    }

    const pdfBuffer = await pdfResponse.arrayBuffer();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${sanitizeFilename(filenameSeed, filePrefix)}.pdf"`);
    res.setHeader('Content-Length', pdfBuffer.byteLength);
    return res.send(Buffer.from(pdfBuffer));

  } catch (error) {
    console.error('Endpoint error:', error);
    return res.status(500).json({ error: 'Something went wrong', message: error.message });
  }
}

function sanitizeFilename(address, prefix = 'bpo') {
  if (!address) return prefix + '-document';
  return prefix + '-' + address.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').substring(0, 60);
}

// Named exports for local testing (the default export remains the Vercel handler).
export { assembleOm, buildOmVars, fillTemplate };
