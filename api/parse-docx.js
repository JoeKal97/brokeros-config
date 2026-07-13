// /api/parse-docx.js
// BrokerOS — Word-doc (OM / Seller Proposal draft) ingestion.
// Broker uploads their existing .docx via Telegram; the webhook posts it here. The doc's
// text is extracted IN-PROCESS (a .docx is a ZIP of XML — parsed with a minimal central-
// directory reader + zlib.inflateRawSync; there is no LibreOffice on Vercel), Claude
// structures it against the OM or Proposal schema, and the draft lands in docx_drafts
// keyed to (telegram_chat_id, property_key).
//
// TRANSPORT: form-urlencoded (repo convention; JSON bodies are WAF-blocked on api routes):
//   docx_base64=<b64> & chat_id=<id> [& org_id=]

import { inflateRawSync } from 'node:zlib';

export const config = { maxDuration: 60 };

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const sbHeaders = () => ({ apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' });

// ---- minimal ZIP: locate a file via the central directory, inflate it ----
function unzipEntry(buf, wantedName) {
  // End Of Central Directory: scan back for signature 0x06054b50
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65536); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a ZIP (.docx) file');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    if (name === wantedName) {
      // local header: sig(4) ver(2) flags(2) method(2) time(4) crc(4) sizes(8) nameLen(2) extraLen(2)
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const data = buf.subarray(dataStart, dataStart + compSize);
      return method === 0 ? Buffer.from(data) : inflateRawSync(data);
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(wantedName + ' not found in archive');
}

// ---- word/document.xml -> readable plain text ----
function xmlToText(xml) {
  let s = xml
    .replace(/<w:tab[^>]*\/>/g, '\t')
    .replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<\/w:tc>/g, '\t')      // table cell boundary
    .replace(/<\/w:tr>/g, '\n')      // table row boundary
    .replace(/<\/w:p>/g, '\n')       // paragraph boundary
    .replace(/<[^>]+>/g, '');
  s = s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
  // Cells contain their own paragraph breaks — collapse "newline then cell-tab" so a
  // table ROW stays on one line ("Year Built\t1928" instead of "Year Built\n\t1928").
  return s.replace(/\n+\t/g, '\t').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function docxToText(base64) {
  const xml = unzipEntry(Buffer.from(base64, 'base64'), 'word/document.xml').toString('utf8');
  return xmlToText(xml);
}

function detectDocType(text) {
  const lower = text.toLowerCase();
  if (lower.includes('offering memorandum') && lower.includes('rent roll')) return 'om';
  if (lower.includes('seller representation') || lower.includes('representation services')) return 'proposal';
  if (lower.includes('offering memorandum')) return 'om';
  return 'proposal'; // default
}

const OM_SCHEMA = `
Extract the following fields as JSON. Use null for any field not found.
Do not invent data. Extract only what is explicitly present in the document.

{
  "property_name": string,
  "address": string,
  "city_state_zip": string,
  "county_submarket": string,
  "parcel_number": string,
  "year_built": string,
  "number_of_stories": string,
  "construction_type": string,
  "total_residential_units": string,
  "commercial_units": string,
  "total_net_rentable_sf": string,
  "parking": string,
  "site_area": string,
  "zoning": string,
  "current_occupancy": string,
  "t12_noi": string,
  "offering_price": string,
  "tour_process": string,
  "bid_deadline": string,
  "executive_summary": string,
  "investment_highlights": [
    { "number": int, "title": string, "body": string }
  ],
  "building_specs": [
    { "element": string, "specification": string }
  ],
  "unit_mix": [
    { "type": string, "count": string, "pct_mix": string, "avg_sf": string, "in_place_rent": string, "rent_per_sf": string }
  ],
  "investment_thesis_narrative": string,
  "strategy_tiers": [
    { "tier": string, "investment": string, "timeline": string, "outcome": string }
  ],
  "loss_to_lease_rows": [
    { "unit_type": string, "units": string, "in_place_rent": string, "market_rent": string, "loss_to_lease": string }
  ],
  "renovation_scope": [
    { "item": string, "cost": string, "rent_premium": string, "yield_on_cost": string }
  ],
  "stabilized_projection": [
    { "line": string, "today": string, "year1": string, "year3": string, "year5": string }
  ],
  "financial_summary": [
    { "line_item": string, "col1": string, "col2": string, "pct_change": string }
  ],
  "financial_summary_col1_label": string,
  "financial_summary_col2_label": string,
  "rent_roll": [
    { "unit": string, "type": string, "sf": string, "in_place_rent": string, "rent_per_sf": string, "status": string, "move_in": string, "notes": string }
  ],
  "offering_process_narrative": string,
  "broker_names": [string],
  "firm_name": string,
  "firm_address": string,
  "firm_website": string
}`;

const PROPOSAL_SCHEMA = `
Extract the following fields as JSON. Use null for any field not found.

{
  "property_name": string,
  "address": string,
  "city_state_zip": string,
  "property_type": string,
  "building_size_sf": string,
  "land_size_sf": string,
  "year_built": string,
  "zoning": string,
  "county": string,
  "parcel": string,
  "taxable_value": string,
  "legal_description": string,
  "intro_narrative": string,
  "strengths": [string],
  "weaknesses": [string],
  "comp_analysis_narrative": string,
  "year1_snapshot": [
    { "label": string, "value": string }
  ],
  "purchase_price_assumption": string,
  "noi_assumption": string,
  "on_market_competition": [
    { "address": string, "status": string, "days_on_market": string, "sf": string, "asking_price": string, "price_per_sf": string, "cap_rate": string }
  ],
  "competition_narrative": string,
  "pricing_primary_low": string,
  "pricing_primary_recommended": string,
  "pricing_primary_high": string,
  "pricing_primary_recommended_basis": string,
  "pricing_alternate_cap_low": string,
  "pricing_alternate_cap_recommended": string,
  "pricing_alternate_cap_high": string,
  "pricing_narrative": string,
  "broker_names": [string],
  "firm_name": string,
  "firm_address": string,
  "firm_website": string
}`;

async function extractPayload(text, docType) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8000,
    messages: [{
      role: 'user',
      content: `You are extracting structured data from a commercial real estate ${docType === 'om' ? 'Offering Memorandum' : 'Seller Representation Proposal'} Word document.

Extract exactly what is present. Do not invent, infer, or fill in data that isn't explicitly in the document.
Photo placeholder markers like "PHOTO PLACEHOLDER" should be ignored.
Internal notes or comments in brackets like "[need to re-do]" should be ignored.

${docType === 'om' ? OM_SCHEMA : PROPOSAL_SCHEMA}

Return ONLY valid JSON, no preamble, no markdown backticks, no explanation.

DOCUMENT TEXT:
${text.slice(0, 32000)}`,
    }],
  });
  const raw = (response.content.find((b) => b.type === 'text') || {}).text || '{}';
  try {
    return JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch {
    console.error('docx extraction parse error:', raw.slice(0, 500));
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method === 'GET') return res.status(200).json({ endpoint: 'parse-docx', ok: true });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};
  const docxBase64 = body.docx_base64;
  const chatId = body.chat_id;
  const orgId = body.org_id || null;
  if (!docxBase64 || !chatId) return res.status(400).json({ error: 'Missing required: docx_base64, chat_id' });
  if (!SB_URL || !SB_KEY) return res.status(500).json({ error: 'Supabase not configured' });

  let text;
  try {
    text = docxToText(docxBase64);
  } catch (e) {
    return res.status(422).json({ error: 'docx conversion failed: ' + e.message });
  }
  if (!text.trim()) return res.status(422).json({ error: 'No text extracted from document.' });

  const docType = detectDocType(text);
  const photoSlots = (text.match(/PHOTO PLACEHOLDER/gi) || []).length;

  const payload = await extractPayload(text, docType);
  if (!payload) return res.status(500).json({ error: 'Extraction failed (invalid JSON from model).' });

  const propertyKey = String(payload.property_name || payload.address || 'unknown')
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'unknown';

  // Upsert the draft (unique on chat+property_key — re-uploading a revised doc replaces it).
  const up = await fetch(`${SB_URL}/rest/v1/docx_drafts?on_conflict=telegram_chat_id,property_key`, {
    method: 'POST',
    headers: { ...sbHeaders(), Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({
      telegram_chat_id: String(chatId),
      org_id: orgId,
      property_key: propertyKey,
      doc_type: docType,
      property_name: payload.property_name || null,
      property_address: payload.address || null,
      payload_json: payload,
      photo_slots: photoSlots,
      status: 'draft',
      updated_at: new Date().toISOString(),
    }),
  });
  if (!up.ok) {
    const detail = await up.text().catch(() => '');
    const missing = /PGRST205|Could not find the table/i.test(detail);
    return res.status(500).json({
      error: missing
        ? 'Supabase table "docx_drafts" is missing — run docs/costar-docx-migration.sql in the SQL editor.'
        : 'Supabase upsert failed: ' + detail.slice(0, 300),
    });
  }

  const extractedFields = Object.keys(payload).filter((k) => {
    const v = payload[k];
    return v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length);
  }).length;

  return res.status(200).json({
    success: true,
    docType,
    propertyKey,
    photoSlots,
    extractedFields,
    payload,
  });
}
