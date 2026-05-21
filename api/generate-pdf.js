// /api/generate-pdf.js
// BrokerOS — PDF Generation Endpoint
// Receives HTML from OC, converts via PDFShift, returns PDF URL
// Deploy to Vercel — set PDFSHIFT_API_KEY in environment variables

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
  const { html_content, property_address, broker_id } = req.body;

  if (!html_content) {
    return res.status(400).json({ error: 'No HTML content provided' });
  }

  try {
    // Call PDFShift API
    const pdfResponse = await fetch('https://api.pdfshift.io/v3/convert/pdf', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + Buffer.from('api:' + apiKey).toString('base64'),
      },
      body: JSON.stringify({
        source: html_content,
        landscape: true,
        format: 'Letter',
        margin: '0',
        delay: 500,                // Wait 500ms for fonts to load (PDFShift v3 param)
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
