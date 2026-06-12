// /api/parse-comp-pdf.js
// BrokerOS — server-side MLS Matrix comp-PDF parser (B2 / Part N).
//
// The bridge stays thin: it uploads the Matrix comp PDF, gets back a clean comp{} + the
// cropped property photo. The LLM never sees the PDF, runs OCR, or reads pixels.
//
// PIPELINE (all pure JS / WASM — no native binaries, Vercel-safe):
//   render page 1 @300dpi (mupdf, WASM)  ->  locate the property photo (largest image block)
//   -> crop it to a PNG  ->  white-out the photo rect on the page so it can't inject OCR noise
//   -> OCR the masked page (tesseract.js, WASM)  ->  parse the FIXED Matrix "360 Property View"
//      field map (label-anchored; status-dependent price branch).
//
// TRANSPORT (form-urlencoded, WAF-safe — same discipline as parse-rentroll/generate-pdf):
//   POST /api/parse-comp-pdf
//   Content-Type: application/x-www-form-urlencoded
//   body: file_base64=<URL-encoded base64 of the .pdf>
//
// RESPONSE: { comp: {...}, photo_base64: <cropped PNG base64> | null, photo_mime, timings_ms, ocr_conf }
//   The bridge uploads photo_base64 to Supabase (its existing uploadPhoto path) and injects the
//   resulting photo_url with the comp. Numbers RAW; OCR is CONFIRMED BACK to the broker before use.
//   Matrix-specific by design (other MLS systems = a later field map — the N3 boundary).

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { deflateSync } from 'zlib';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

export const config = { maxDuration: 60 }; // single comp: render+mask ~2s + OCR ~7-8s; ample headroom

const VERSION = '2026-06-11-comp-a';
const DPI = 300;

// ----------------------------- minimal RGB PNG encoder (for the cropped photo) ----------------
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); }
  return (~c) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePNG(rgb, w, h) {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; // RGB
  const stride = w * 3;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw, { level: 6 })), pngChunk('IEND', Buffer.alloc(0))]);
}

// ----------------------------- Matrix "360 Property View" field map -----------------------------
const STOP = String.raw`MLS\s*#|Prop\s*Type|Sub\s*Type|Close\s*Price|List\s*Price|Orig\s*List\s*Price|Price|Status|DOM\/CDOM|DOM|Geocode|County|Subdiv|Unit|City\s*Limits|Yr\s*Built|Lot\s*Size|\$\s*\/\s*S\w*Ft|Tot\s*Bldg\s*S\w*Ft|Zoning|SID\s+Annual\s+Amt|SID\s+Est|SID\s+Features|SID\s+Perpetual|SID\s+Included|SID|Assessor|Taxes|Tax\s*Year|Tax\s*Assessed|Covenant|School\s*Dist|Road\s*Frontage|Road\s*Surface|Foundation|Construction|Waterfront|Heating|Water|Year\s*Built\s*Source|Remodel`;
const NEXT = String.raw`(?=\s*(?:${STOP})\s*:|\s*$)`;

const num = (s) => { if (s == null) return null; const n = Number(String(s).replace(/[^0-9.]/g, '')); return Number.isFinite(n) ? n : null; };
const clean = (s) => s == null ? null
  : String(s).replace(/^[\s|i!.,:_»«-]+/, '').replace(/[\s|i!.,:_»«-]+$/, '').replace(/\s+/g, ' ').trim() || null;
function grab(text, labelSrc) {
  const m = text.match(new RegExp(String.raw`(?:^|\s)${labelSrc}\s*:\s*([\s\S]*?)` + NEXT, 'im'));
  return m ? clean(m[1]) : null;
}

function parseMatrixComp(text) {
  const t = text.replace(/\r/g, '');

  let address = null, city = null, state = null, zip = null;
  const addrLine = (t.split('\n').find((l) => /,\s*[A-Z]{2}\s+\d{5}/.test(l)) || '').trim();
  if (addrLine) {
    const parts = addrLine.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length >= 3) {
      address = clean(parts[0]); city = clean(parts[1]);
      const sz = parts[2].match(/([A-Z]{2})\s+(\d{5})/);
      if (sz) { state = sz[1]; zip = sz[2]; }
    }
  }

  const mls = (t.match(/MLS\s*#\s*:\s*([0-9]+)/i) || [])[1] || null;
  const prop_type = grab(t, String.raw`Prop\s*Type`);
  const sub_type = grab(t, String.raw`Sub\s*Type`);
  const statusRaw = grab(t, String.raw`Status`);

  // STATUS-DEPENDENT PRICE BRANCH (the #1 correctness item):
  //   Closed/Sold  -> Close Price is the sale price; also capture List Price.
  //   else (Active/Expired/Pending) -> a single "Price:" (asking), no sale price.
  const closeM = t.match(/Close\s*Price\s*:\s*\$?\s*([\d.,]+)/i);
  const listM = t.match(/List\s*Price\s*:\s*\$?\s*([\d.,]+)/i);
  let sale, price, list_price = null;
  if (closeM) { sale = true; price = num(closeM[1]); list_price = listM ? num(listM[1]) : null; }
  else { const g = t.match(/(?<![A-Za-z])(?<!List )(?<!Close )Price\s*:\s*\$?\s*([\d.,]+)/i); sale = false; price = g ? num(g[1]) : null; }

  const sR = (statusRaw || '').toLowerCase();
  let status;
  if (/closed|sold/.test(sR)) status = 'sold';
  else if (/pending|under\s*contract|contingent/.test(sR)) status = 'contract';
  else status = 'on_market';

  const building_sf = num(grab(t, String.raw`Tot\s*Bldg\s*S\w*Ft`));
  const price_psf = num(grab(t, String.raw`\$\s*\/\s*S\w*Ft`));
  const year_built = num((t.match(/Yr\s*Built\s*:\s*(\d{4})/i) || [])[1]);
  const zoning = (t.match(/Zoning\s*:\s*([A-Za-z0-9][A-Za-z0-9\/\-]*)/i) || [])[1] || null;
  const county = grab(t, String.raw`County`);
  const lotRaw = grab(t, String.raw`Lot\s*Size`);
  const lot_acres = num((lotRaw || '').match(/([\d.]+)\s*ac/i)?.[1]);
  const lot_sf = num((t.match(/([\d,]+)\s*s[aq]ft\b(?!\s*:)/i) || [])[1]);

  return {
    address, city_state: city && state ? `${city}, ${state}` : (city || null), city, state, zip,
    mls, prop_type, sub_type: sub_type || null, status, status_raw: statusRaw,
    price, list_price, sale, building_sf, price_psf,
    lot_sf, lot_acres, lot_size_raw: lotRaw, year_built, zoning, county,
    units: null, cap_rate: null, // NOT present in this Matrix template — never fabricated
  };
}

// ----------------------------- render + photo + OCR -----------------------------
let _tessWorker = null;
async function getWorker() {
  if (_tessWorker) return _tessWorker;
  const { createWorker } = await import('tesseract.js');
  const corePath = dirname(require.resolve('tesseract.js-core/package.json'));
  const langPath = join(__dirname, 'tessdata');       // bundled eng.traineddata.gz (no CDN fetch)
  const cachePath = process.env.TESS_CACHE || '/tmp/tesscache'; // /tmp is the only writable dir on Vercel
  _tessWorker = await createWorker('eng', 1, { corePath, langPath, cachePath, gzip: true });
  await _tessWorker.setParameters({ tessedit_pageseg_mode: '6' });
  return _tessWorker;
}

async function parseCompPdf(pdfBuf) {
  const T = {}; let t = Date.now(); const lap = (k) => { T[k] = Date.now() - t; t = Date.now(); };
  const mupdf = await import('mupdf');

  const doc = mupdf.Document.openDocument(new Uint8Array(pdfBuf), 'application/pdf');
  if (doc.countPages() < 1) throw new Error('empty PDF');
  const page = doc.loadPage(0);
  const scale = DPI / 72;
  const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
  const W = pix.getWidth(), H = pix.getHeight();
  const px = pix.getPixels();
  const N = Math.round(px.length / (W * H));
  lap('render');

  // locate the property photo: largest image block (filter out tiny UI icons by area, pt^2)
  let photo = null;
  try {
    const blocks = (JSON.parse(page.toStructuredText('preserve-images').asJSON()).blocks || [])
      .filter((b) => b.type === 'image' && b.bbox);
    blocks.sort((a, b) => (b.bbox.w * b.bbox.h) - (a.bbox.w * a.bbox.h));
    if (blocks.length && (blocks[0].bbox.w * blocks[0].bbox.h) > 2000) photo = blocks[0].bbox;
  } catch { /* photo optional */ }

  let photo_base64 = null;
  let pr = null;
  if (photo) {
    pr = {
      x0: Math.max(0, Math.floor(photo.x * scale)), y0: Math.max(0, Math.floor(photo.y * scale)),
      x1: Math.min(W, Math.ceil((photo.x + photo.w) * scale)), y1: Math.min(H, Math.ceil((photo.y + photo.h) * scale)),
    };
    const cw = pr.x1 - pr.x0, ch = pr.y1 - pr.y0;
    if (cw > 0 && ch > 0) {
      const crop = Buffer.alloc(cw * ch * 3);
      let o = 0;
      for (let y = pr.y0; y < pr.y1; y++) {
        let src = (y * W + pr.x0) * N;
        for (let x = pr.x0; x < pr.x1; x++) { crop[o++] = px[src]; crop[o++] = px[src + 1]; crop[o++] = px[src + 2]; src += N; }
      }
      photo_base64 = encodePNG(crop, cw, ch).toString('base64');
    }
  }
  lap('photo');

  // white-out the photo rect (+2px pad) so its pixels can't inject noise into adjacent labels
  if (pr) {
    const x0 = Math.max(0, pr.x0 - 2), y0 = Math.max(0, pr.y0 - 2), x1 = Math.min(W, pr.x1 + 2), y1 = Math.min(H, pr.y1 + 2);
    for (let y = y0; y < y1; y++) { let off = (y * W + x0) * N; for (let x = x0; x < x1; x++) { for (let c = 0; c < N; c++) px[off++] = 255; } }
  }
  const maskedPng = Buffer.from(pix.asPNG());
  lap('mask');

  const worker = await getWorker();
  lap('ocrInit');
  const { data } = await worker.recognize(maskedPng);
  lap('ocr');

  const comp = parseMatrixComp(data.text);
  return { comp, photo_base64, photo_mime: photo_base64 ? 'image/png' : null, ocr_conf: Math.round(data.confidence), timings_ms: T };
}

export default async function handler(req, res) {
  if (req.method === 'GET' || (req.query && req.query.version !== undefined)) {
    return res.status(200).json({ version: VERSION, endpoint: 'parse-comp-pdf' });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const b64 = (req.body || {}).file_base64;
  if (!b64) {
    return res.status(400).json({ error: 'No file_base64 provided', detail: 'POST application/x-www-form-urlencoded with field file_base64=<base64 of the Matrix comp .pdf>' });
  }
  try {
    const buf = Buffer.from(String(b64), 'base64');
    const out = await parseCompPdf(buf);
    return res.status(200).json(out);
  } catch (e) {
    return res.status(400).json({ error: 'Parse failed', detail: (e && e.message) || String(e) });
  }
}
