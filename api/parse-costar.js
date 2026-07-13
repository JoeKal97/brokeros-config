// /api/parse-costar.js
// BrokerOS — CoStar comp report ingestion.
// Broker uploads a CoStar Sale/Rent comps PDF via Telegram; the webhook posts it here.
// Text is extracted with mupdf (same WASM pipeline as parse-comp-pdf — there is no
// pdftotext binary on Vercel), Claude structures the comps, rows land in Supabase
// keyed to (telegram_chat_id, property_key) for OM/Proposal generation to pull.
//
// TRANSPORT: form-urlencoded (repo convention; JSON bodies are WAF-blocked on api routes):
//   pdf_base64=<b64> & chat_id=<id> & property_key=<key> [& org_id=] [& report_type=sale|rent]

export const config = { maxDuration: 60 };

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const sbHeaders = () => ({ apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' });

// ---- text extraction: every page's structured text, joined ----
async function pdfToText(pdfBuf) {
  const mupdf = await import('mupdf');
  const doc = mupdf.Document.openDocument(new Uint8Array(pdfBuf), 'application/pdf');
  const n = doc.countPages();
  const out = [];
  for (let i = 0; i < n; i++) {
    try {
      const st = JSON.parse(doc.loadPage(i).toStructuredText('preserve-whitespace').asJSON());
      for (const block of (st.blocks || [])) {
        if (block.type !== 'text') continue;
        for (const line of (block.lines || [])) if (line.text) out.push(line.text);
      }
      out.push(''); // page break
    } catch { /* skip unreadable page */ }
  }
  return out.join('\n');
}

function detectReportType(text) {
  const lower = text.toLowerCase();
  const saleScore = (lower.match(/sale price|sale comps|sold date|sale comparables/g) || []).length;
  const rentScore = (lower.match(/asking rent|rent comps|vacancy|rent comparables|rent per unit/g) || []).length;
  return rentScore > saleScore ? 'rent' : 'sale';
}

async function extractCompsWithClaude(text, reportType) {
  const schema = reportType === 'sale' ? `
Extract all sale comparables as a JSON array. Each comp object:
{
  "comp_number": number (sequential position in report),
  "property_name": string or null,
  "address": string,
  "city_state_zip": string or null,
  "submarket": string or null,
  "property_type": string or null,
  "sale_date": string or null (e.g. "7/8/2026"),
  "sale_price": string or null (e.g. "$11,000,000"),
  "price_per_unit": string or null (e.g. "$144,737/Unit"),
  "price_per_sf": string or null (e.g. "$227.65/SF"),
  "units": string or null,
  "gba_sf": string or null,
  "cap_rate": string or null,
  "pro_forma_cap": string or null,
  "year_built": string or null,
  "land_area": string or null,
  "sale_comp_id": string or null,
  "sale_comp_status": string or null,
  "parcel_numbers": string or null
}` : `
Extract all rent comparables as a JSON array. Each comp object:
{
  "comp_number": number,
  "property_name": string or null,
  "address": string,
  "city_state_zip": string or null,
  "submarket": string or null,
  "property_type": string or null,
  "year_built": string or null,
  "units": string or null,
  "avg_sf": string or null,
  "vacancy_pct": string or null,
  "studio_rent": string or null,
  "one_br_rent": string or null,
  "two_br_rent": string or null,
  "asking_rent_per_unit": string or null,
  "rent_per_sf": string or null,
  "stories": string or null,
  "elevators": string or null
}`;

  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8000,
    messages: [{
      role: 'user',
      content: `You are extracting comparable property data from a CoStar report.
The report text is below. ${schema}

Return ONLY the JSON array, no preamble, no markdown, no backticks.
If a field is not present in the report, use null.
Extract every comparable you find. Do not invent data.

REPORT TEXT:
${text.slice(0, 30000)}`,
    }],
  });

  const raw = (response.content.find((b) => b.type === 'text') || {}).text || '[]';
  try {
    const arr = JSON.parse(raw.replace(/```json|```/g, '').trim());
    return Array.isArray(arr) ? arr : [];
  } catch {
    console.error('CoStar extraction parse error. Raw:', raw.slice(0, 300));
    return [];
  }
}

const SALE_COLS = ['comp_number', 'property_name', 'address', 'city_state_zip', 'submarket', 'property_type', 'sale_date', 'sale_price', 'price_per_unit', 'price_per_sf', 'units', 'gba_sf', 'cap_rate', 'pro_forma_cap', 'year_built', 'land_area', 'sale_comp_id', 'sale_comp_status', 'parcel_numbers'];
const RENT_COLS = ['comp_number', 'property_name', 'address', 'city_state_zip', 'submarket', 'property_type', 'year_built', 'units', 'avg_sf', 'vacancy_pct', 'studio_rent', 'one_br_rent', 'two_br_rent', 'asking_rent_per_unit', 'rent_per_sf', 'stories', 'elevators'];

export default async function handler(req, res) {
  if (req.method === 'GET') return res.status(200).json({ endpoint: 'parse-costar', ok: true });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};
  const pdfBase64 = body.pdf_base64;
  const chatId = body.chat_id;
  const propertyKey = body.property_key;
  const orgId = body.org_id || null;
  const hintType = body.report_type;

  if (!pdfBase64 || !chatId || !propertyKey) {
    return res.status(400).json({ error: 'Missing required fields: pdf_base64, chat_id, property_key' });
  }
  if (!SB_URL || !SB_KEY) return res.status(500).json({ error: 'Supabase not configured' });

  let text = '';
  try {
    text = await pdfToText(Buffer.from(pdfBase64, 'base64'));
  } catch (e) {
    return res.status(500).json({ error: 'PDF text extraction failed: ' + e.message });
  }
  if (!text.trim()) {
    return res.status(422).json({ error: 'No text extracted from PDF. Is it a scanned image PDF?' });
  }

  const reportType = (hintType === 'sale' || hintType === 'rent') ? hintType : detectReportType(text);

  let comps = [];
  try {
    comps = await extractCompsWithClaude(text, reportType);
  } catch (e) {
    return res.status(500).json({ error: 'Claude extraction failed: ' + e.message });
  }
  comps = comps.filter((c) => c && c.address);
  if (!comps.length) {
    return res.status(422).json({ error: 'No comparables found in PDF.' });
  }

  // Whitelist columns (Claude output -> known table cols only), stringify values.
  const cols = reportType === 'sale' ? SALE_COLS : RENT_COLS;
  const rows = comps.map((c, i) => {
    const row = { telegram_chat_id: String(chatId), org_id: orgId, property_key: propertyKey };
    for (const k of cols) {
      if (c[k] === undefined || c[k] === null) continue;
      row[k] = k === 'comp_number' ? (parseInt(c[k], 10) || i + 1) : String(c[k]);
    }
    if (!row.comp_number) row.comp_number = i + 1;
    return row;
  });

  const table = reportType === 'sale' ? 'costar_sale_comps' : 'costar_rent_comps';
  // Re-uploading a report for the same property replaces the prior extraction (no dupes).
  await fetch(`${SB_URL}/rest/v1/${table}?telegram_chat_id=eq.${encodeURIComponent(String(chatId))}&property_key=eq.${encodeURIComponent(propertyKey)}`, {
    method: 'DELETE', headers: { ...sbHeaders(), Prefer: 'return=minimal' },
  }).catch(() => {});
  const ins = await fetch(`${SB_URL}/rest/v1/${table}`, {
    method: 'POST', headers: { ...sbHeaders(), Prefer: 'return=minimal' },
    body: JSON.stringify(rows),
  });
  if (!ins.ok) {
    const detail = await ins.text().catch(() => '');
    const missing = /PGRST205|Could not find the table/i.test(detail);
    return res.status(500).json({
      error: missing
        ? `Supabase table "${table}" is missing — run docs/costar-docx-migration.sql in the SQL editor.`
        : 'Supabase insert failed: ' + detail.slice(0, 300),
    });
  }

  return res.status(200).json({
    success: true,
    reportType,
    compsExtracted: rows.length,
    table,
    comps: rows.map(({ telegram_chat_id, org_id, property_key, ...c }) => c),
  });
}
