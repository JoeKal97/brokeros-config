// /api/generate-pdf.js
// BrokerOS — PDF Generation Endpoint
// Receives HTML from OC, converts via PDFShift, returns the PDF.
// Deploy to Vercel — set PDFSHIFT_API_KEY in environment variables.
//
// Accepts BOTH application/json and application/x-www-form-urlencoded bodies
// (Vercel parses either into req.body). OC currently posts form-urlencoded to
// bypass a JSON-body firewall block; no code change is needed for that.

export default async function handler(req, res) {

  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Pull API key from environment — never hardcode
  const apiKey = process.env.PDFSHIFT_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'PDF service not configured' });
  }

  // Extract payload from OC
  const { html_content, property_address, broker_id } = req.body || {};

  // --- FIX 1: BOM / leading-whitespace guard -------------------------------
  // Strip a leading UTF-8 BOM (U+FEFF) and any leading whitespace. PDFShift
  // rejects a source that doesn't START with <!DOCTYPE / <html / http(s),
  // and a stray BOM or newline silently breaks it.
  let source = (html_content || '').replace(/^\uFEFF/, '').trimStart();

  if (!source) {
    return res.status(400).json({ error: 'No HTML content provided' });
  }

  // --- FIX 2: prefix validation --------------------------------------------
  // Turn PDFShift's cryptic "source must start by..." 400 into a clear,
  // self-explaining error before we ever call the API.
  if (!/^(<!doctype|<html|https?:\/\/)/i.test(source)) {
    return res.status(400).json({
      error: 'Invalid HTML',
      detail: 'html_content must start with "<!DOCTYPE", "<html", or "http(s)://". '
            + 'Check for stray leading text, BOM, or chat/log prefixes.'
    });
  }

  // --- FIX 3: orientation ---------------------------------------------------
  // Default to PORTRAIT. The BPO/CMA/OM templates are portrait (8.5in x 11in);
  // the old hardcoded landscape:true rotated and broke their layout.
  // Optional per-request override: send landscape=true (bool or "true" string).
  const landscape = (req.body.landscape === true || req.body.landscape === 'true');

  try {
    // Call PDFShift API
    const pdfResponse = await fetch('https://api.pdfshift.io/v3/convert/pdf', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + Buffer.from('api:' + apiKey).toString('base64'),
      },
      body: JSON.stringify({
        source: source,
        landscape: landscape,      // default false (portrait)
        format: 'Letter',
        margin: '0',
        delay: 500,                // wait 500ms for fonts to load (PDFShift v3 param)
      }),
    });

    if (!pdfResponse.ok) {
      const errorText = await pdfResponse.text();
      console.error('PDFShift error:', errorText);
      return res.status(500).json({
        error: 'PDF generation failed',
        detail: errorText
      });
    }

    // PDFShift returns the PDF as binary — get it as a buffer
    const pdfBuffer = await pdfResponse.arrayBuffer();

    // Return PDF directly as download
    const filename = sanitizeFilename(property_address) + '.pdf';

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', pdfBuffer.byteLength);

    return res.send(Buffer.from(pdfBuffer));

  } catch (error) {
    console.error('Endpoint error:', error);
    return res.status(500).json({
      error: 'Something went wrong',
      message: error.message
    });
  }
}

// Clean up address for use as filename
function sanitizeFilename(address) {
  if (!address) return 'bpo-document';
  return 'bpo-' + address
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')   // Remove special chars
    .replace(/\s+/g, '-')            // Spaces to hyphens
    .replace(/-+/g, '-')             // Collapse multiple hyphens
    .substring(0, 60);               // Max 60 chars
}
