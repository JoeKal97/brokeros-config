# OM Payload Schema — `doc_type: "om"`

Contract for the Offering Memorandum pipeline. Sibling to `BPO-PAYLOAD-SCHEMA.md`.

**Same machine as the BPO.** Transport is form-urlencoded `payload=<url-encoded JSON>` to
`POST /api/generate-pdf` (never `application/json` — WAF-blocked). The endpoint loads the
bundled `brokeros-om-template.html`, fills `{{TOKENS}}`, suppresses optional pages, computes
**all** financial math server-side, calls PDFShift (portrait Letter), and returns the PDF.

The OC/agent sends **raw data + prose only**. The endpoint is the sole authority on every
derived number (caps, cap-rate sensitivity, debt service, cash-on-cash, DSCR, GRM, EGI/NOI
fallbacks) and on all HTML assembly. Never compute financials in the LLM.

---

## Top-level

| Field | Type | Notes |
|-------|------|-------|
| `doc_type` | string | **Must be `"om"`** to route to OM assembly. |
| `broker_id` | string | Must exist in the endpoint `BROKERS` registry (e.g. `"eagen"`). |
| `broker` | object | Optional overrides merged over the registry (see **Broker**). |
| `pending_label` | string | Text inside PENDING chips. Default `"TO CONFIRM"`. Palmer uses `"JESSIE TO CONFIRM"`. |
| `pending_chips` | string[] | Property-level keys to flag PENDING: `total_sf`, `site_acres`, `occupancy`. |
| `property` | object | See **Property**. |
| `description` | string \| string[] | Property-summary narrative. Blank-line-separated string → paragraphs. |
| `investment_highlights` | string[] | 6–8 bullets; split evenly across two columns. |
| `buildings` | object[] | Per-building rows (see **Buildings**). |
| `construction` | object \| array | Construction & systems table (see **Construction**). |
| `financials` | object | See **Financials** — inputs only; outputs computed server-side. |
| `market` | object | See **Market**. |
| `demographics` | object \| null | See **Demographics**. `null`/absent → Section 4 (pages 16–17) suppressed. |
| `photos` | object | See **Photos**. |
| `options` | object | `{ landscape, zoom, margin }`. OM defaults to `landscape:false` (portrait). |

## Broker (registry + optional payload overrides)

`name`, `phone`, `email`, `company`, `website`, `address`,
`address_block` (HTML, may contain `<br>`), `headshot_url` (public URL), `bio` (string or
string[] → paragraphs). Registry values are the default; any field in `payload.broker` wins.

## Property

`name`, `address_line1`, `city_state_zip`, `address` (full — else derived from line1+city),
`price` (display string, e.g. `"$47,500,000"`), `price_raw` (number — used for all math),
`total_sf` (display string), `site_acres` (string; `" acres"` appended), `buildings_desc`
or `num_buildings`, `year_built`, `parking_spaces`, `zoning`, `permitted_uses`,
`ownership_entity`, `occupancy`, `excluded_note`, `offering_note`, `construction_note`.

## Buildings

`[{ address, sf (number → "27,960 SF", or string), use, pending? }]`. `pending:true` adds a
chip on that row. `property.zoning` / `property.permitted_uses` render as lead rows; the
`excluded_note` renders as a closing italic line.

## Construction

Either an object `{ "Foundation": "Reinforced concrete", ... }` (order preserved) or an array
`[{ label, value }]`. Absent → "available upon request" line.

## Financials (inputs only — every output is computed)

```
current  / pro_forma : { gross_rents, other_income, egi?, operating_expenses, noi?, price_per_sf, grm? }
debt                 : { rate (default 6.5), amortization_years (default 25), ltvs (default [0.60,0.65]) }
note                 : optional override of the standard NDA/DD footnote
```

**Computed server-side, never trusted from the payload:**
- `EGI` = gross_rents + other_income (when not given); `NOI` = EGI − operating_expenses (when not given).
- `Cap rate` = NOI / price_raw. Current **and** pro-forma.
- **Cap-rate sensitivity** — value = NOI / rate over the ladder 5.0–8.0% + the actual current/pro-forma caps; the two actual-cap rows are highlighted.
- **Debt & cash flow** — per LTV: loan = price×LTV, equity = price−loan, annual debt service via standard amortization, cash flow = pro-forma NOI − ADS, cash-on-cash = CF/equity, DSCR = NOI/ADS.
- **GRM** = price / gross_rents (when not given).

## Market

`city`, `state`, `title` (else `"City, ST"`), `narrative` (string/array → paragraphs),
`photo_url`, `photo_caption`.

## Demographics

```
rings        : ["0.5 Miles","1 Mile","2.5 Miles"]   (ring labels; miles parsed for the ring map)
population   : { "Total Population":[v1,v2,v3], "Average Age":[...] }
households   : { "Total Households":[...], "Average HH Income":[...], ... }
source       : "2023 American Community Survey (ACS)"
```
Each metric is `label: [ring1, ring2, ring3]` (or `{label, values:[…]}`). Numbers are
comma-formatted; pass ages/ratios as strings (`"36.0"`) to preserve decimals. A ring map is
generated server-side from the property address + ring miles (needs `GOOGLE_MAPS_API_KEY`).

## Photos

`cover_url` (cover hero — falls back to `property_urls[0]`), `back_url` (back cover —
falls back to cover), `property_urls[]` (pages 7–8 grid; also cycled through the four
section dividers), `site_plan_url` (+ `site_plan_note`), `aerial_url` (+ `aerial_note`;
when absent a Google satellite map of the address is generated), `note`.

All photos are **public URLs** (Supabase Storage) — never base64 — to keep the inbound
`payload=` well under Vercel's ~4.5 MB body limit.

## Optional-page suppression (`<!--OPT:name-->`)

| Marker | Kept when |
|--------|-----------|
| `photos2` (page 8) | `property_urls.length >= 7` |
| `siteplan` (page 9) | `photos.site_plan_url` is a URL |
| `demographics` (pages 16–17) | `demographics` is present |

## 19-page map

1 Cover · 2 TOC+Disclaimer · 3 Sec-1 divider · 4 Property Summary · 5 Investment Highlights ·
6 Property Profile · 7–8 Photographs · 9 Site Plan · 10 Sec-2 divider · 11 Aerial ·
12 Market Overview · 13 Sec-3 divider · 14 Financial Summary · 15 Rent Roll (NDA) ·
16 Sec-4 divider · 17 Demographics · 18 Advisor Bio · 19 Back Cover.

---
*Render path: Option A — one unified `/api/generate-pdf` endpoint, branched on `doc_type`.
PDFShift, portrait Letter. Decided 2026-06-28; see `OM-Build-Brief.md` §2.*
