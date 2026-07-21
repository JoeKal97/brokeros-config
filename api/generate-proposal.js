// /api/generate-proposal.js
// BrokerOS — Seller Representation Proposal PDF endpoint.
//
// TRANSPORT: form-urlencoded only (matches /api/generate-pdf; application/json is
// WAF-blocked on these routes).
//   payload=<url-encoded JSON>  -> flat {{VARIABLE}} map from the agent's
//                                  GENERATE_PROPOSAL emission.
//
// The endpoint is the authority on boilerplate: broker fields arrive from the agent,
// everything Orion-static (brokers, office, marketing copy, notable transactions,
// sales list) is hardcoded here in ORION_DEFAULTS and merged UNDER the payload —
// the broker's values always win. Any template variable still unfilled after the
// merge renders as an empty string, never as a raw {{TOKEN}}.
//
// Template: templates/proposal-template-v3.html — 23-page landscape (11in x 8.5in),
// 315 {{VARIABLE}} placeholders, self-normalizing list/sales-row script (runs in
// PDFShift's headless Chrome before print). Rendered landscape, zoom 1, margin 0.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const config = { maxDuration: 60 };

const VERSION = '2026-07-21-proposal-1';

// Template ships inside the function bundle (vercel.json includeFiles); raw-URL fallback
// mirrors generate-pdf's safety net.
const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_RAW_URL = 'https://raw.githubusercontent.com/JoeKal97/brokeros-config/main/templates/proposal-template-v3.html';
let _tplCache;
function loadLocalTemplate() {
  if (_tplCache !== undefined) return _tplCache;
  try { _tplCache = readFileSync(join(__dirname, '..', 'templates', 'proposal-template-v3.html'), 'utf8'); }
  catch (_) { _tplCache = null; }
  return _tplCache;
}

// ---- Orion boilerplate defaults (never change per-deal) ---------------------
const ORION_DEFAULTS = {
  BROKER1_NAME: 'Scott Clements',
  BROKER1_PHONE: '206.793.1074',
  BROKER1_EMAIL: 'sclements@orioncp.com',
  BROKER1_TITLE: 'Partner, Vice President Investment Sales',
  BROKER1_BIO: 'Scott Clements is a commercial real estate professional with over 20 years of experience in the Puget Sound area. He specializes in investment and owner/user sales and has a proven track record of success. Scott began his career in 1999 with Leibsohn & Company and joined ORION Commercial Partners in 2012.',
  BROKER1_CREDENTIALS: 'BS, Department of Building Construction, University of Washington\nCommercial Brokers Association Member',
  BROKER2_NAME: 'David Butler',
  BROKER2_PHONE: '425.890.7919',
  BROKER2_EMAIL: 'dbutler@orioncp.com',
  BROKER2_TITLE: 'Partner, Vice President Investment Sales',
  BROKER2_BIO: 'David specializes exclusively in investment sales, representing both buyers and sellers throughout the Puget Sound region. Mr. Butler joined ORION in 2012 from Grubb & Ellis. He combines a strong work ethic with his passion for fly fishing and golfing.',
  BROKER2_CREDENTIALS: 'BA, Geography, University of Washington\nCommercial Brokers Association Member',
  OFFICE_ADDRESS: '1218 Third Avenue, Suite 2200, Seattle, WA 98101',
  WEBSITE: 'www.orioncp.com',
  TOC_SEC1_PAGE: '3', TOC_SEC2_PAGE: '8', TOC_SEC3_PAGE: '11',
  TOC_SEC4_PAGE: '15', TOC_SEC5_PAGE: '19',
  ORION_COMPANY_DESC: 'ORION Commercial Partners maximizes real estate value through comprehensive project acquisition/disposition, property/asset management, and leasing services. We are a progressive real estate services and investment firm constantly seeking a perfect alignment of interests between us as the service provider and our clients. ORION delivers a',
  ORION_UNIFIED_TEXT: "to fulfill our client's objectives. Creativity, accountability and focused attention are the hallmarks of our business.",
  DISCLAIMER_TEXT: 'The information supplied herein is from sources we deem reliable. It is provided without any representation, warranty or guarantee, expressed or implied, as to its accuracy. Prospective buyer or tenant should conduct an independent investigation and verification of all matters deemed to be material, including, but not limited to, statements of income and expenses.',
  ORION_TEAM_BODY_TEXT: 'The ORION team is successful not only because of the depth and breadth of our individual experience but also our collective experience selling and leasing properties in challenging submarkets. From pension funds, insurance companies, corporate owners, private funds and syndications to individual owners of single buildings, our success and negotiations on behalf of owners in the local market can be backed by case study and client testimonials. Our team’s daily interaction and “everyone reading from the',
  ORION_TEAM_BODY_P1: 'The ORION team is successful not only because of the depth and breadth of our individual experience but also our collective experience selling and leasing properties in challenging submarkets. From pension funds, insurance companies, corporate owners, private funds and syndications to individual owners of single buildings, our success and negotiations on behalf of owners in the local market can be backed by case study and client testimonials. Our team’s daily interaction and “everyone reading from the',
  ORION_TEAM_BODY_P2: 'same sheet” mentality sets the stage for effective representation. We fill a need for a new model in the industry—one where real estate service providers truly understand the client’s objectives and implement strategies focused on maximizing client returns and adding real estate value. We focus on quality, not volume.',
  ORION_TEAM_BODY_P2_PART1: 'same sheet” mentality sets the stage for effective representation. We fill a need for a new model in the industry—one where real estate service providers truly understand the client’s objectives and implement strategies focused on maximizing client returns and adding real estate value. We focus on quality, not volume.',
  ORION_TEAM_BODY_P2_PART2: 'From the first conversation, you will notice what truly differentiates us from other brokerages and gives us our competitive advantage: we listen. When your objectives are understood, you have the highest probability of meeting and exceeding your goals.',
  ORION_VALUE_TEXT_LEFT: 'Our clients reap the rewards of our experience and the wisdom we have gleaned from many years in the Investment Sales Market. Each broker at ORION has spent years in large national commercial real estate firms, but have matured to the point where relationships are more important than scale.',
  ORION_VALUE_TEXT_RIGHT: 'ORION investment brokers have sold over $1.5+ billion of property, including assets from all the major “food groups” in commercial real estate. Collectively, we draw on over 60 years of real estate experience when developing the best action plan for an acquisition.',
  MARKETING_PULLQUOTE: '“There is much more to marketing property than simply creating glossy marketing material, and we take pride in the fact that our marketing process begins on a strategic level.”',
  MARKETING_SELLING_STORY: 'We provide a strategic platform to create the highest value for the property on the open market, effectively creating “the story” or value proposition for the asset. By establishing an investment theme or story, we have a much better chance of prospective buyers forming a similar underwriting belief versus drawing their own conclusions without any guidance. We view ourselves as the market experts and want to positively impact the buyers’ underwriting process. Developing a logical story for the asset will generate market excitement and “value” for the seller.',
  MARKETING_CAMPAIGN_TEXT: 'The marketing campaign will include both direct promotion to pre-qualified buyers and market-wide promotion to maximize contact with prospective buyers and agents.',
  MARKETING_DATABASE_TEXT: 'Our Buyer database includes contact information and acquisition criteria for all prospective Buyers in the Northwest region.',
  MARKETING_MATERIALS_ITEMS: 'Property description\nPhotographs of the property\nLocation and area maps\nSite plans/parcel maps\nIncome and expense analysis\nSales Comparables\nInformation & demographics for the area\nArticles of interest',
  MARKETING_DIRECT_MAIL_TEXT: 'The property flyer and summary investment offering will be mailed to anyone that has bought or sold similar property throughout Washington State.',
  MARKETING_EMAIL_TEXT: 'An HTML email blast will be emailed to all Northwest regional brokers and prospective Buyers on a bi-weekly basis.',
  MARKETING_INTERNET_TEXT: 'The property will be posted to LoopNet, CBA, CoStar, CREXi and VerticalEmail.',
  MARKETING_PHONE_TEXT: 'All prospective Purchasers expressing interest receive direct phone follow-up from the Listing Team.',
  MARKETING_DD_INTRO: 'Upon entering into a purchase agreement, ORION Commercial Partners will coordinate all closing and escrow activities. These activities will be provided as requested and include:',
  MARKETING_DD_ITEMS: 'Recommendations of inspection services, attorneys, certified public accountants\nPreparation and delivery of Due Diligence materials\nCoordinate Title and Escrow materials\nAssist the purchaser in locating and securing financing\nPreparation of all documents required for closing\nCoordinate and schedule on-site inspections\nDeliver contingency documents\nAssist purchaser during due diligence period',
  MARKETING_SUMMARY_TEXT: 'Well-planned, highly organized and discreetly controlled exposure to the maximum number of qualified buyers in a short period of time is the heart of our marketing strategy.',
  PRICING_LOW_SF: '', PRICING_LOW_VALUE: '', PRICING_LOW_BASIS: '',
  PRICING_HIGH_SF: '', PRICING_HIGH_VALUE: '', PRICING_HIGH_BASIS: '',
  PRICING_INV_LOW_CAP: '', PRICING_INV_LOW_VALUE: '', PRICING_INV_LOW_BASIS: '',
  PRICING_INV_REC_CAP: '', PRICING_INV_REC_VALUE: '', PRICING_INV_REC_BASIS: '',
  PRICING_INV_HIGH_CAP: '', PRICING_INV_HIGH_VALUE: '', PRICING_INV_HIGH_BASIS: '',
  PRICING_INV_NOI_ASSUMPTION: '', PRICING_NARRATIVE_LEFT: '', PRICING_NARRATIVE_RIGHT: '',
  INVEST_ASSUMPTION_HEADER: '', INVEST_PURCHASE_PRICE: '', INVEST_DOWN_PAYMENT: '',
  INVEST_LOAN_AMOUNT: '', INVEST_INTEREST_RATE: '', INVEST_AMORTIZATION: '',
  INVEST_DEBT_SERVICE: '', INVEST_NOI: '', INVEST_CAP_RATE: '',
  INVEST_LESS_DEBT_SERVICE: '', INVEST_PRETAX_CASH: '', INVEST_COC_RETURN: '',
  INVEST_DSCR: '', INVEST_PRINCIPAL_PAYDOWN: '', INVEST_PRETAX_PLUS_PRINCIPAL: '',
  INVEST_TOTAL_RETURN: '',
  COMPS_INTRO_TEXT: '', COMPS_FOOTER_TEXT: '',
  COMPS_AVG_PRICE: '', COMPS_AVG_PRICE_SF: '', COMPS_AVG_LAND_PRICE_SF: '',
  COMPETITION_INTRO: '', COMPETITION_CONTEXT_NOTE: '',
  TRANS_1_NAME: 'Centerpoint Corporate Park', TRANS_1_CITY: 'Kent, WA', TRANS_1_TYPE: 'Office', TRANS_1_PRICE: '$54,200,000',
  TRANS_2_NAME: 'Lake City Mini Storage', TRANS_2_CITY: 'Seattle, WA', TRANS_2_TYPE: 'Specialty / Redevelopment', TRANS_2_PRICE: '$18,500,000',
  TRANS_3_NAME: '3101 Northup Way', TRANS_3_CITY: 'Bellevue, WA', TRANS_3_TYPE: 'Medical Office', TRANS_3_PRICE: '$10,200,000',
  TRANS_4_NAME: 'Display & Costume', TRANS_4_CITY: 'Seattle, WA', TRANS_4_TYPE: 'Redevelopment / Retail', TRANS_4_PRICE: '$14,100,000',
  TRANS_5_NAME: 'Elliott Ave W', TRANS_5_CITY: 'Seattle, WA', TRANS_5_TYPE: 'Redevelopment', TRANS_5_PRICE: '$8,325,000',
  TRANS_6_NAME: '101 Nickerson', TRANS_6_CITY: 'Seattle, WA', TRANS_6_TYPE: 'Retail', TRANS_6_PRICE: '$4,850,000',
  SALES_LIST: 'Lake City Mini Storage, Seattle, WA|Specialty / Redevelopment|$18,500,000\nDisplay & Costume, Seattle, WA|Redevelopment / Retail|$14,100,000\nThe Franciscan Medical Pavilion, Auburn, WA|Medical|$12,089,000\nSeattle Veterinary Specialists, Kirkland, WA|Medical|$10,400,000\nLakewood Colonial Center East, Lakewood, WA|Retail|$10,375,000\n3101 Northup Way, Bellevue, WA|Office|$10,200,000\nWalgreens, Tacoma, WA|Retail|$10,052,000',
};

// Gray box SVG for all photo/map placeholders (demo-safe: no broken-image icons).
const GRAY_BOX = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="100%" height="100%" fill="#c8d0d0"/></svg>').toString('base64');

const PHOTO_KEYS = [
  'PHOTO_AERIAL', 'PHOTO_AERIAL_2', 'PHOTO_STREET', 'PHOTO_COMPS_SECTION', 'PHOTO_STRATEGIC',
  'PHOTO_MARKETING', 'PHOTO_TEAM', 'PHOTO_TEAM_HEADSHOTS', 'PHOTO_BACK_COVER',
  'BROKER1_PHOTO', 'BROKER2_PHOTO', 'MAP_AMENITIES', 'MAP_DEMOGRAPHICS', 'MAP_COMPS',
  'MAP_INVESTMENT_AERIAL', 'COMP_1_PHOTO', 'COMP_2_PHOTO', 'COMP_3_PHOTO', 'COMP_4_PHOTO',
  'COMP_5_PHOTO', 'COMP_6_PHOTO', 'TRANS_1_PHOTO', 'TRANS_2_PHOTO', 'TRANS_3_PHOTO',
  'TRANS_4_PHOTO', 'TRANS_5_PHOTO', 'TRANS_6_PHOTO', 'MARKETING_SAMPLE_FLYER',
  'MARKETING_SAMPLE_EMAIL', 'MARKETING_SAMPLE_MAILER', 'QR_CODE'
];
PHOTO_KEYS.forEach((k) => { ORION_DEFAULTS[k] = GRAY_BOX; });

// ---- fill: exact string-replace per variable, then blank every leftover token ----
function fillTemplate(tpl, vars) {
  let out = tpl;
  for (const k of Object.keys(vars)) {
    out = out.split('{{' + k + '}}').join(vars[k] == null ? '' : String(vars[k]));
  }
  out = out.replace(/\{\{[A-Z0-9_]+\}\}/g, '');
  return out;
}

export default async function handler(req, res) {
  if (req.method === 'GET' || (req.query && req.query.version !== undefined)) {
    return res.status(200).json({ version: VERSION, templateSource: loadLocalTemplate() ? 'bundle' : 'raw-fallback' });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.PDFSHIFT_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'PDF service not configured' });

  const body = req.body || {};
  if (body.payload === undefined || body.payload === '') {
    return res.status(400).json({ error: 'No payload provided', detail: 'POST form-urlencoded payload=<JSON>' });
  }
  let payload;
  try { payload = JSON.parse(body.payload); }
  catch { return res.status(400).json({ error: 'Invalid payload', detail: 'payload must be a URL-encoded JSON string' }); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return res.status(400).json({ error: 'Invalid payload', detail: 'payload must be a JSON object of template variables' });
  }

  try {
    let tpl = loadLocalTemplate();
    if (!tpl) {
      const tplResp = await fetch(TEMPLATE_RAW_URL);
      if (!tplResp.ok) return res.status(502).json({ error: 'Template fetch failed', detail: 'HTTP ' + tplResp.status });
      tpl = await tplResp.text();
    }

    // Broker payload wins over boilerplate; empty-string payload values fall back to the
    // default so a skipped question never blanks Orion's static copy. doc_type / broker_id
    // are routing metadata, not template variables — never string-replace them in.
    const vars = { ...ORION_DEFAULTS };
    for (const [k, v] of Object.entries(payload)) {
      if (k === 'doc_type' || k === 'broker_id' || k === 'options' || k === 'org') continue;
      if (v === null || v === undefined) continue;
      if (v === '' && k in ORION_DEFAULTS && ORION_DEFAULTS[k] !== '') continue;
      vars[k] = v;
    }
    const source = fillTemplate(tpl, vars);

    // Template is authored at exact 11x8.5in landscape CSS with its own page-break rules:
    // landscape true, zoom 1, margin 0. delay lets the list-normalizer script run pre-print.
    const pdfResponse = await fetch('https://api.pdfshift.io/v3/convert/pdf', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + Buffer.from('api:' + apiKey).toString('base64')
      },
      body: JSON.stringify({ source, landscape: true, zoom: 1, format: 'Letter', margin: '0', delay: 500 })
    });

    if (!pdfResponse.ok) {
      const errorText = await pdfResponse.text();
      console.error('PDFShift error:', errorText);
      return res.status(500).json({ error: 'PDF generation failed', detail: errorText });
    }

    const pdfBuffer = Buffer.from(await pdfResponse.arrayBuffer());
    const seed = String(vars.PROPERTY_ADDRESS_SHORT || 'proposal').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="proposal-${seed || 'document'}.pdf"`);
    return res.status(200).send(pdfBuffer);
  } catch (e) {
    console.error('generate-proposal error:', e);
    return res.status(500).json({ error: 'Internal error', detail: String((e && e.message) || e) });
  }
}
