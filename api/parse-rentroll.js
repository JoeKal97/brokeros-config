// /api/parse-rentroll.js
// BrokerOS — server-side xlsx rent-roll parser (B1).
//
// OC stays thin: it uploads the .xlsx, gets clean tenants[] JSON back. The LLM never
// reads cells or converts date serials (the previous failure mode).
//
// TRANSPORT (form-urlencoded, WAF-safe — same discipline as generate-pdf):
//   POST /api/parse-rentroll
//   Content-Type: application/x-www-form-urlencoded
//   body: file_base64=<URL-encoded base64 of the .xlsx file>
//
// RESPONSE: { "tenants": [ {suite,name,size_sf,rent_psf,annual_rent,market_rent,
//             market_rent_psf,lease_start,lease_end}, ... ] }
//   Numbers RAW (no $/,/%). Dates ISO YYYY-MM-DD (or null). In-sheet TOTALS/AVERAGES
//   rows are skipped. generate-pdf still owns all formatting + math; this only extracts.

import * as XLSX from 'xlsx';

const VERSION = '2026-06-09-rr-a';

// Header text (normalized) -> tenant field. '% OF BUILDING' is intentionally NOT mapped
// (the server computes share). Mapping is by header NAME, never column position.
const HEADER_MAP = {
  'SUITE': 'suite',
  'TENANT NAME': 'name',
  'TENANT': 'name',
  'SIZE SF': 'size_sf',
  'PRICE/SF/YEAR': 'rent_psf',
  'PRICE/SF/YR': 'rent_psf',
  'MARKET RENT': 'market_rent',
  'MARKET RENT/SF': 'market_rent_psf',
  'ANNUAL RENT': 'annual_rent',
  'LEASE START': 'lease_start',
  'LEASE END': 'lease_end'
};
const DATE_FIELDS = new Set(['lease_start', 'lease_end']);
const NUM_FIELDS = new Set(['size_sf', 'rent_psf', 'market_rent', 'market_rent_psf', 'annual_rent']);

const norm = (s) => String(s == null ? '' : s).toUpperCase().replace(/\s+/g, ' ').trim();
const pad = (n) => String(n).padStart(2, '0');

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[$,%\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// Excel serial / Date / string -> ISO YYYY-MM-DD, UTC-stable (no timezone day-shift).
function toISODate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) {
    return v.getUTCFullYear() + '-' + pad(v.getUTCMonth() + 1) + '-' + pad(v.getUTCDate());
  }
  if (typeof v === 'number') {
    // Excel 1900 system: serial 0 == 1899-12-30. Compute in UTC to avoid drift.
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  }
  const d = new Date(v);
  return isNaN(d.getTime()) ? String(v).trim()
    : d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
}

function parseRentRoll(wb) {
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error('no worksheet');
  // Array-of-arrays; cellDates already applied at read time. blankrows kept so indexes align.
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, blankrows: true, defval: null });

  // Locate the header row dynamically (must contain SUITE and TENANT NAME).
  let headerRow = -1, colToField = {};
  for (let r = 0; r < rows.length; r++) {
    const cells = (rows[r] || []).map(norm);
    if (cells.includes('SUITE') && (cells.includes('TENANT NAME') || cells.includes('TENANT'))) {
      headerRow = r;
      (rows[r] || []).forEach((h, c) => {
        const f = HEADER_MAP[norm(h)];
        if (f) colToField[c] = f;
      });
      break;
    }
  }
  if (headerRow < 0) throw new Error('header row not found (need SUITE + TENANT NAME)');

  const suiteCol = Object.keys(colToField).find((c) => colToField[c] === 'suite');
  const nameCol = Object.keys(colToField).find((c) => colToField[c] === 'name');

  const tenants = [];
  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const suiteVal = suiteCol != null ? row[suiteCol] : null;
    const nameVal = nameCol != null ? row[nameCol] : null;
    // Skip TOTALS/AVERAGES and blank rows: aggregate rows have a totals label and/or no tenant name.
    if (/\b(TOTAL|TOTALS|AVERAGE|AVERAGES|SUBTOTAL)\b/.test(norm(suiteVal) + ' ' + norm(nameVal))) continue;
    if (nameVal == null || String(nameVal).trim() === '') continue;

    const t = {};
    for (const c of Object.keys(colToField)) {
      const field = colToField[c];
      const raw = row[c];
      if (DATE_FIELDS.has(field)) t[field] = toISODate(raw);
      else if (NUM_FIELDS.has(field)) t[field] = numOrNull(raw);
      else t[field] = raw == null ? null : String(raw).trim();
    }
    // Normalize the canonical generate-pdf tenant shape (stable key order).
    tenants.push({
      suite: t.suite ?? null,
      name: t.name ?? null,
      size_sf: t.size_sf ?? null,
      rent_psf: t.rent_psf ?? null,
      annual_rent: t.annual_rent ?? null,
      market_rent: t.market_rent ?? null,
      market_rent_psf: t.market_rent_psf ?? null,
      lease_start: t.lease_start ?? null,
      lease_end: t.lease_end ?? null
    });
  }
  return tenants;
}

export default async function handler(req, res) {
  if (req.method === 'GET' || (req.query && req.query.version !== undefined)) {
    return res.status(200).json({ version: VERSION, endpoint: 'parse-rentroll' });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};
  const b64 = body.file_base64;
  if (!b64) {
    return res.status(400).json({
      error: 'No file_base64 provided',
      detail: 'POST application/x-www-form-urlencoded with field file_base64=<base64 of the .xlsx>'
    });
  }
  try {
    const buf = Buffer.from(String(b64), 'base64');
    const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
    const tenants = parseRentRoll(wb);
    return res.status(200).json({ tenants });
  } catch (e) {
    return res.status(400).json({ error: 'Parse failed', detail: e.message });
  }
}
