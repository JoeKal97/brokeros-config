// /api/generate-pdf.js
// BrokerOS — PDF Generation Endpoint
// Receives HTML from OC, converts via PDFShift, returns the PDF.
// Deploy to Vercel — set PDFSHIFT_API_KEY in environment variables.
//
// Accepts BOTH application/json and application/x-www-form-urlencoded bodies
// (Vercel parses either into req.body). OC posts form-urlencoded to bypass a
// JSON-body firewall block; no code change is needed for that.
//
// Defaults are tuned for the BrokerOS template family (landscape 11x8.5 pages
// authored at 1100x850px): landscape orientation + zoom 0.88, and an injected
// pagination stylesheet so every broker's template breaks at its .page
// boundaries. All are overridable per-request.

// Pagination safety-net CSS (Option B): forces each .page onto its own physical
// page for ANY template using the house .page / .page-wrapper convention.
// Injected last (before </head>) so it overrides the template's own rules.
const PAGINATION_CSS =
  '<style id="brokeros-pagination-fix">' +
  '.page-wrapper{display:block;padding:0;}' +
  '.page{margin:0 auto;break-after:page;page-break-after:always;break-inside:avoid;page-break-inside:avoid;}' +
  '.page:last-child{break-after:auto;page-break-after:auto;}' +
  '</style>';

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

  // --- BOM / leading-whitespace guard --------------------------------------
  // PDFShift rejects a source that doesn't START with <!DOCTYPE / <html /
  // http(s); a stray BOM or newline silently breaks it.
  let source = (html_content || '').replace(/^\uFEFF/, '').trimStart();

  if (!source) {
    return res.status(400).json({ error: 'No HTML content provided' });
  }

  // --- Prefix validation ----------------------------------------------------
  if (!/^(<!doctype|<html|https?:\/\/)/i.test(source)) {
    return res.status(400).json({
      error: 'Invalid HTML',
      detail: 'html_content must start with "<!DOCTYPE", "<html", or "http(s)://". '
            + 'Check for stray leading text, BOM, or chat/log prefixes.'
    });
  }

  // --- Pagination injection (Option B; default on) -------------------------
  // Insert the safety-net CSS so .page divs break at their boundaries even if a
  // template forgets the rules. Opt out with paginate=false.
  const injectPagination = !(req.body.paginate === false || req.body.paginate === 'false');
  if (injectPagination) {
    if (/<\/head>/i.test(source)) {
      source = source.replace(/<\/head>/i, PAGINATION_CSS + '</head>');
    } else if (/<\/body>/i.test(source)) {
      source = source.replace(/<\/body>/i, PAGINATION_CSS + '</body>');
    } else {
      source = source + PAGINATION_CSS;
    }
  }

  // --- Layout controls (per-request; defaults tuned for the template) ------
  // landscape: DEFAULT TRUE. The BrokerOS templates author pages at 1100x850px
  //   (= Letter LANDSCAPE, 11x8.5in). Send landscape=false to override.
  // zoom: DEFAULT 0.88. Absorbs the 100px/in design vs 96px/in render oversize,
  //   fits 1100x850 within Letter-landscape with margins, and keeps each .page
  //   under one physical page (above ~0.92 a page can overflow). Range 0.1-2.
  // margin: page margin; '0' lets the design's own padding + zoom set the margins.
  const landscape = (req.body.landscape === false || req.body.landscape === 'false')
    ? false
    : true;

  const zoomRaw = parseFloat(req.body.zoom);
  const zoom = (!isNaN(zoomRaw) && zoomRaw >= 0.1 && zoomRaw <= 2) ? zoomRaw : 0.88;

  const margin = (req.body.margin !== undefined && req.body.margin !== '')
    ? req.body.margin
    : '0';

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
        landscape: landscape,
        zoom: zoom,
        format: 'Letter',
        margin: margin,
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
