// /api/telegram-webhook.js
// BrokerOS — Telegram bridge, INCREMENT 3 of 3: multi-turn stateful BPO + real PDF delivery.
//
// A broker runs a full typed BPO over Telegram and gets the PDF back.
//
// PART A — SESSION STATE (multi-turn memory):
//   Supabase table `telegram_sessions` maps telegram_chat_id -> a persisted Managed Agent
//   session_id. Each incoming text reuses that SAME stateful session (so the agent remembers
//   earlier turns, exactly like the Path B PoC). No active session -> a new one is created.
//
//   LIFECYCLE (v1):
//     START  : a "new BPO" / "/new" / "/start" message, OR simply the first message when no
//              active session exists, begins a fresh session.
//     END    : successful PDF delivery ends the session; so does an explicit
//              "/cancel" / "/done" / "/reset" / "stop". Ending clears the chat's mapping.
//
// PART B — REAL DELIVERY (brain/bridge separation):
//   The agent is text/payload-only. When the broker says generate, the agent emits
//   `GENERATE_BPO` + a JSON payload (production delivery contract — the PoC "harness will
//   POST" override was removed and the agent rebuilt). The BRIDGE then owns delivery:
//   POST payload (form-urlencoded) -> /api/generate-pdf -> receive PDF bytes -> sendDocument
//   to the chat -> THEN the confirmation line (attach-then-confirm).
//
// TIMEOUT HANDLING (unchanged from tg-2): respond 200 to Telegram immediately, do the agent
//   turn + any PDF delivery in the background via Vercel `waitUntil`. Telegram never retries,
//   so no duplicate runs / messages. Bounded by maxDuration below.
//
// CONFIG (Vercel env, server-side only, never logged):
//   TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY,
//   BROKEROS_AGENT_ID (optional override of the persisted agent id).

// NOTE: @anthropic-ai/sdk is heavy; it is lazy-loaded (dynamic import) inside the agent-call
// path only, so it stays OUT of cold-start module init — the webhook 200 + ack fire first.
import { waitUntil } from '@vercel/functions';

// The generate turn (agent writes the full payload, then PDFShift renders 19 pages) is the
// heaviest (full payload + 19-page PDFShift render). 300s (Vercel Pro) gives the generate
// turn ample headroom so it never times out from the broker's view.
export const config = { maxDuration: 300 };

const VERSION = '2026-06-17-tg-20-batch';

// --- latency diagnostics (observability only; read via GET ?selftest=timing) ---
const MODULE_LOADED_AT = Date.now();
let instanceServed = 0;            // requests handled by this (warm) instance
let lastTiming = null;             // breakdown of the most recent turn
function newTiming(kind, chatId) {
  instanceServed += 1;
  return { kind, chat: String(chatId), t0: Date.now(), uptime_ms: Math.round(process.uptime() * 1000), instanceServed, marks: {} };
}
function mark(tm, label) { if (tm) tm.marks[label] = Date.now() - tm.t0; }
function commitTiming(tm) { if (tm) { tm.total_ms = Date.now() - tm.t0; delete tm.t0; lastTiming = tm; } }

// A chat marked "generating" within this window blocks a second generation (double-gen
// guard). Beyond it the mark is treated as stale (a truly dead run) and generation may retry.
const GENERATING_TTL_MS = 240000;

// A delivered BPO stays correctable (post-gen edits) only for this window after delivery/last
// activity. After it, the session is closed; a new message starts fresh — so e.g. typing "BPO"
// the next day begins a new BPO instead of resurfacing the old one.
const DELIVERED_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
function deliveredAgeMs(row) {
  const t = row && row.last_active ? Date.parse(row.last_active) : NaN;
  return Number.isFinite(t) ? Date.now() - t : Infinity; // missing timestamp => treat as expired
}
// Single source of truth for what an inbound message does relative to a (possibly delivered) row:
//   'new'      -> start a fresh BPO  (bare "BPO" / "new BPO" / "start a BPO" / "/new")
//   'closed'   -> correction to a delivered BPO past the window -> honest "session closed"
//   'continue' -> edit a non-expired delivered BPO, or a normal in-progress turn
function deliveredDecision(row, text) {
  const wantStart = START_RE.test(text) || NEWBPO_RE.test(text);
  if (wantStart) return 'new';
  if (row && row.status === 'delivered' && deliveredAgeMs(row) > DELIVERED_TTL_MS) return 'closed';
  return 'continue';
}

// Rebuilt agent governed by base workflow + agents/telegram-delivery-contract.md.
const AGENT_ID = process.env.BROKEROS_AGENT_ID || 'agent_0158kmQA7nKFSB6xRdTSfJ2C';
const GENERATE_PDF_URL = 'https://brokeros-config.vercel.app/api/generate-pdf';
const PARSE_RENTROLL_URL = 'https://brokeros-config.vercel.app/api/parse-rentroll';
const PARSE_COMP_URL = 'https://brokeros-config.vercel.app/api/parse-comp-pdf';

const TERMINAL = new Set(['session.status_idle', 'session.status_terminated', 'session.error']);
const TG_API = (token, m) => `https://api.telegram.org/bot${token}/${m}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const START_RE = /^\s*\/?(start|new|bpo)\b/i;       // "/start", "/new", "new bpo", "start a bpo", bare "BPO"
const NEWBPO_RE = /\bnew\s*bpo\b/i;
const END_RE = /^\s*\/?(cancel|done|reset|stop)\b/i;
const RETRY_RE = /^\s*\/?(retry|resend|try\s*again|again|yes|yep|yeah|yup|ok(ay)?|sure|go|please)\b/i; // after a failed generation

// Explicit "make the BPO now" intent -> acknowledge the BUILD immediately (don't wait ~1 min for
// the agent to decide). Deliberately narrow (clear generate verbs) to avoid firing on plain confirms.
const GENERATE_INTENT_RE = /\b(generate|build|create|produce|finali[sz]e)\b[^.!?]*\b(bpo|report|pdf|it|this|that)\b|^\s*\/?(generate|build\s*it|make\s*it|create\s*it|generate\s+(the\s+)?bpo|build\s+(the\s+)?bpo|make\s+(the\s+)?bpo|run\s*it|send\s*it|go\s*for\s*it|let'?s\s*go|fire\s*away)\s*$/i;

// STATUS check-in ("you there?", "where's my PDF", "any update", "done yet?") -> answer with
// real status, not a generic ack.
const STATUS_RE = /\b(still (coming|building|there|working|waiting)|you (there|up|alive)|are you (there|alive|working)|where('?s| is)?\s+(my\s+|the\s+)?(pdf|bpo|report|doc(ument)?|it|that)|how('?s| is)\s+(it|that|this)\s+(going|coming|looking)|any\s+update|done\s+yet|ready\s+yet|finished\s+yet|did\s+(it|that|you)\s+(send|go|work|get)|hello\??|you\s+working)\b/i;

// Short confirmation/answer ("looks good", "go ahead", "correct", "all missoula") -> the agent
// reply lands fast; no separate "working on that" ack (typing carries it).
const CONFIRM_RE = /^\s*(looks?\s+good|that'?s?\s+(right|correct|it|good)|correct|confirm(ed)?|yes|yep|yeah|yup|ok(ay)?|sure|sounds?\s+good|perfect|great|all\s+good|that\s+works|works(\s+for\s+me)?|go\s+ahead|go|run\s+with\s+it|just\s+run.*|do\s+it|please\s+do|fine|good|right)\b/i;

// FILE receipt check ("did you get the file?", "you get it?", "did it come through?") -> answer
// from what we actually received, not a generic status line.
const FILE_STATUS_RE = /(did|do)\s+you\s+(get|got|have|receive|see)\b|\byou\s+(get|got|receive)\s+(it|that|the|my)\b|\b(get|got)\s+(the|my)\s+(file|upload|spreadsheet|rent\s*roll|doc|sheet)\b|\bcome\s+through\b/i;

// Neutral, non-assertive acks for HEAVY data turns only (rotated, no back-to-back repeat).
// Warm acknowledgment, no claim of work-in-progress ("working on that" overstated the machinery).
const DATA_ACKS = ['Got it…', 'Got it — one sec…', 'Thanks — give me a moment…', 'Got that…', 'One moment…'];
let lastAckIdx = -1;
function pickAck() {
  let i = Math.floor(Math.random() * DATA_ACKS.length);
  if (DATA_ACKS.length > 1 && i === lastAckIdx) i = (i + 1) % DATA_ACKS.length;
  lastAckIdx = i;
  return DATA_ACKS[i];
}
// INFORMATIONAL / holding messages — the broker is telling us something or asking us to wait,
// NOT requesting work ("I have 2 more comps", "more coming", "give me a sec", "hold on"). These
// must NOT get a canned work-ack — the typing indicator + the agent's real reply carry it.
const INFO_RE = new RegExp([
  '^\\s*(hold\\s*(on|up)|hang\\s*on|one\\s*(sec|second|moment|min(ute)?)|just\\s*a\\s*(sec(ond)?|moment|min(ute)?)|give\\s*me\\s*(a\\s*)?(sec(ond)?|min(ute)?|moment)|bear\\s*with(\\s*me)?|stand\\s*by|wait\\b|almost\\s+(done|ready|there))',
  '\\b((a\\s+)?(few|couple|some|\\d+)\\s+more|more)\\s+(comps?|photos?|pics?|pictures?|docs?|files?|coming|to\\s+(come|send|follow)|on\\s+the\\s+way)\\b',
  '\\bmore\\s+(coming|to\\s+(come|send|follow)|on\\s+the\\s+way)\\b',
  '\\b\\d+\\s+more\\b',
].join('|'), 'i');

// Classify the inbound text for ACK purposes only: 'status' (answered directly) | 'data' (heavy
// turn -> a neutral canned ack helps) | 'info' (everything else -> typing indicator only; the
// agent's real reply does the talking). A misfit canned ack reads more robotic than honest typing.
function classifyAck(text) {
  const t = String(text || '').trim();
  if (STATUS_RE.test(t) || FILE_STATUS_RE.test(t)) return 'status';
  if (INFO_RE.test(t) || CONFIRM_RE.test(t)) return 'info';
  // Canned ack ONLY for a genuinely heavy data turn (long / multi-line paste the agent takes real
  // time on). Short and medium messages ride the typing indicator + the agent's fast reply.
  const words = t.split(/\s+/).filter(Boolean).length;
  const heavy = t.length > 140 || /\n/.test(t) || words > 24;
  return heavy ? 'data' : 'info';
}

// Remember the most recent inbound file per chat (module scope persists across warm
// invocations) so an immediate "did you get the file?" gets a real answer.
const recentUploads = new Map(); // chatId -> { name, kind, supported, readable, at }
const UPLOAD_TTL_MS = 600000;
function recordUpload(chatId, info) { recentUploads.set(String(chatId), { ...info, at: Date.now() }); }
function getRecentUpload(chatId) {
  const u = recentUploads.get(String(chatId));
  return u && (Date.now() - u.at) < UPLOAD_TTL_MS ? u : null;
}
// Human label for an unsupported upload type.
function readableType(kind) {
  return ({ document: 'documents', photo: 'images', voice: 'voice notes', audio: 'audio',
    video: 'videos', video_note: 'video notes', sticker: 'stickers' })[kind] || kind;
}
function isXlsxDoc(doc) {
  return /\.xlsx?$/i.test(doc.file_name || '') || /spreadsheetml|ms-excel/i.test(doc.mime_type || '');
}
// A PDF document is treated as an MLS Matrix comp PDF (parse-comp-pdf). Other doc types fall
// through to the actionable "type it instead" fallback.
function isCompPdf(doc) {
  return /\.pdf$/i.test(doc.file_name || '') || /application\/pdf/i.test(doc.mime_type || '');
}

// ---- message-type routing (unchanged) ----
function classify(msg) {
  if (!msg) return 'none';
  if (typeof msg.text === 'string') return 'text';
  if (msg.voice) return 'voice';
  if (msg.audio) return 'audio';
  if (msg.document) return 'document';
  if (msg.photo) return 'photo';
  if (msg.video) return 'video';
  if (msg.video_note) return 'video_note';
  if (msg.sticker) return 'sticker';
  if (msg.location) return 'location';
  if (msg.contact) return 'contact';
  return 'other';
}

// ---- Telegram senders ----
async function sendMessage(token, chatId, text) {
  const resp = await fetch(TG_API(token, 'sendMessage'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: String(text).slice(0, 4096) }),
  });
  let info = null; try { info = await resp.json(); } catch { /* ignore */ }
  return info ? !!info.ok : resp.ok;
}

async function sendDocument(token, chatId, bytes, filename) {
  const fd = new FormData();
  fd.append('chat_id', String(chatId));
  fd.append('document', new Blob([bytes], { type: 'application/pdf' }), filename);
  const resp = await fetch(TG_API(token, 'sendDocument'), { method: 'POST', body: fd });
  let info = null; try { info = await resp.json(); } catch { /* ignore */ }
  return info ? !!info.ok : resp.ok;
}

// ---- inbound file retrieval (getFile -> download bytes). Prerequisite for xlsx/photo/voice. ----
async function tgGetFile(token, fileId) {
  // getFile resolves a file_id to a file_path (works for files up to ~20 MB via the bot API).
  const resp = await fetch(`${TG_API(token, 'getFile')}?file_id=${encodeURIComponent(fileId)}`);
  let info = null; try { info = await resp.json(); } catch { /* ignore */ }
  return info && info.ok ? info.result : null; // { file_id, file_unique_id, file_size, file_path }
}
async function tgDownloadFile(token, filePath) {
  const resp = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
  if (!resp.ok) return null;
  return Buffer.from(await resp.arrayBuffer());
}
function humanSize(n) {
  if (n == null || !Number.isFinite(n)) return 'unknown size';
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  if (n >= 1024) return Math.round(n / 1024) + ' KB';
  return n + ' bytes';
}

// "typing" chat action (broker sees the bot is active). Expires ~5s, so we pulse it.
async function sendChatAction(token, chatId, action = 'typing') {
  try {
    await fetch(TG_API(token, 'sendChatAction'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, action }),
    });
  } catch { /* ignore */ }
}
// Start a background "typing" pulse; returns a stopper. Re-sends every 4s for long turns.
function startTyping(token, chatId) {
  let active = true;
  (async () => { while (active) { await sendChatAction(token, chatId, 'typing'); await sleep(4000); } })();
  return () => { active = false; };
}

// ---- Supabase session mapping (PostgREST + service key) ----
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const sbConfigured = () => !!(SB_URL && SB_KEY);
const sbHeaders = () => ({ apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' });

async function sbGet(chatId) {
  const r = await fetch(`${SB_URL}/rest/v1/telegram_sessions?telegram_chat_id=eq.${chatId}&select=*`, { headers: sbHeaders() });
  if (!r.ok) return null;
  const rows = await r.json();
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}
async function sbUpsert(chatId, sessionId, envId) {
  await fetch(`${SB_URL}/rest/v1/telegram_sessions?on_conflict=telegram_chat_id`, {
    method: 'POST',
    headers: { ...sbHeaders(), Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ telegram_chat_id: chatId, session_id: sessionId, environment_id: envId, last_active: new Date().toISOString() }),
  });
}
async function sbTouch(chatId) {
  await fetch(`${SB_URL}/rest/v1/telegram_sessions?telegram_chat_id=eq.${chatId}`, {
    method: 'PATCH', headers: { ...sbHeaders(), Prefer: 'return=minimal' },
    body: JSON.stringify({ last_active: new Date().toISOString() }),
  });
}
async function sbDelete(chatId) {
  await fetch(`${SB_URL}/rest/v1/telegram_sessions?telegram_chat_id=eq.${chatId}`, { method: 'DELETE', headers: { ...sbHeaders(), Prefer: 'return=minimal' } });
}
// Generation state (requires status + generating_since + last_payload columns; degrades to
// no-guard / no-retry-memory if the ALTER TABLE hasn't been run — PATCH no-ops on unknown cols).
async function sbPatch(chatId, fields) {
  await fetch(`${SB_URL}/rest/v1/telegram_sessions?telegram_chat_id=eq.${chatId}`, {
    method: 'PATCH', headers: { ...sbHeaders(), Prefer: 'return=minimal' },
    body: JSON.stringify(fields),
  });
}
// Mark a chat as actively generating and stash the exact payload so a retry can re-POST it
// without another agent round trip.
const sbMarkGenerating = (chatId, payload) => sbPatch(chatId, { status: 'generating', generating_since: new Date().toISOString(), last_payload: payload });
const sbMarkFailed = (chatId) => sbPatch(chatId, { status: 'generate_failed', generating_since: null }); // keep last_payload for retry
const sbMarkDelivered = (chatId) => sbPatch(chatId, { status: 'delivered', generating_since: null, last_active: new Date().toISOString() }); // keep session + last_payload for post-delivery edits; stamp the window start
// Clear BPO state on a fresh start / failed-clear. MUST NOT touch generating_since — that field
// is the per-chat TURN LOCK (owned by sbAcquireLock/sbReleaseLock); nulling it mid-turn would
// release the lock early and reopen the double-fire window.
const sbClearState = (chatId) => sbPatch(chatId, { status: null, last_payload: null });

function isGeneratingActive(row) {
  if (!row || row.status !== 'generating') return false;
  const since = row.generating_since ? Date.parse(row.generating_since) : 0;
  return Number.isFinite(since) && since > 0 && (Date.now() - since) < GENERATING_TTL_MS;
}

// ---- PER-CHAT TURN LOCK (serializes in-flight turns) ----
// The triple-fire bug: the old guard only tripped once a PDF build STARTED, but the agent turn
// that DECIDES to generate runs 10-30s earlier — an unguarded window where several messages each
// passed the guard and each reached runGeneration. The lock now covers the WHOLE turn (thinking +
// building). It is `generating_since` recency, taken at TURN START, auto-expiring after
// GENERATING_TTL_MS so a crashed/failed turn never leaves the chat permanently "busy".
// Varied, context-aware "busy"/queued lines (rotated, no back-to-back repeat) so a chat under
// poking doesn't echo one robotic string. building = a PDF is rendering; working = a turn is
// mid-flight (deciding); queued = a file arrived while busy and will be processed next.
const _rotLast = {};
function rotate(key, arr) {
  let i = Math.floor(Math.random() * arr.length);
  if (arr.length > 1 && i === _rotLast[key]) i = (i + 1) % arr.length;
  _rotLast[key] = i;
  return arr[i];
}
const BUSY_BUILDING = ['Still building your BPO — about 30 seconds…', 'Putting your BPO together now — nearly there…', 'Still rendering the BPO — just a moment…'];
const BUSY_WORKING = ['One sec — just finishing your last message…', 'Hang tight — wrapping up the last thing…', 'Almost through the previous step — a moment…'];
const FILE_QUEUED = ['Got that — I’ll add it right after this…', 'Got it — I’ll grab this once the last one’s done…', 'Received — I’ll process it in a moment…'];
function busyLine(row) {
  return (row && row.status === 'generating') ? rotate('build', BUSY_BUILDING) : rotate('work', BUSY_WORKING);
}
const pickFileQueued = () => rotate('file', FILE_QUEUED);

function lockHeld(row) {
  const since = row && row.generating_since ? Date.parse(row.generating_since) : 0;
  return Number.isFinite(since) && since > 0 && (Date.now() - since) < GENERATING_TTL_MS;
}
// Atomically take the lock via a CONDITIONAL update — acquire only if the lock is free or expired.
// Postgres re-checks the WHERE clause on the row it locks, so exactly one of N concurrent callers
// wins (the rest get 0 rows back = busy). Requires the row to exist. On an unexpected error it
// degrades to "acquired" so the bot never hangs on a lock it can't read.
async function sbAcquireLock(chatId) {
  const now = new Date().toISOString();
  const cutoff = new Date(Date.now() - GENERATING_TTL_MS).toISOString();
  const url = `${SB_URL}/rest/v1/telegram_sessions?telegram_chat_id=eq.${chatId}&or=(generating_since.is.null,generating_since.lt.${encodeURIComponent(cutoff)})`;
  let r;
  try { r = await fetch(url, { method: 'PATCH', headers: { ...sbHeaders(), Prefer: 'return=representation' }, body: JSON.stringify({ generating_since: now }) }); }
  catch { return true; }          // network error -> don't hard-block the broker
  if (!r.ok) return true;         // unexpected -> degrade to no-lock rather than a stuck "busy"
  const rows = await r.json().catch(() => []);
  return Array.isArray(rows) && rows.length > 0;
}
const sbReleaseLock = (chatId) => sbPatch(chatId, { generating_since: null });

// File-handler gate: ensure the session row exists, then take the turn lock — but QUEUE (wait) if
// another turn is in flight, so a BATCH of comp PDFs / photos all get processed instead of being
// rejected. File ingest never generates, so serializing it (one turn at a time, in arrival order)
// is safe and keeps the Managed Agent session consistent while still accumulating every file.
// Sends the right ack: the normal instant ack if the lock is free now, or a "queued" ack if it had
// to wait. Returns true if the lock is held (caller processes + releases), false on timeout
// (already told the broker to resend).
const FILE_QUEUE_WAIT_MS = 120000;
async function fileGateAcquire(token, chatId, instantAck) {
  let row = await sbGet(chatId);
  if (!row) { try { const s = await newSession(); await sbUpsert(chatId, s.id, s.envId); } catch { /* ignore */ } }
  if (await sbAcquireLock(chatId)) {                 // free now -> normal instant ack, process immediately
    await Promise.all([sendChatAction(token, chatId, 'typing'), sendMessage(token, chatId, instantAck)]);
    return true;
  }
  // Busy: a turn is in flight. Tell the broker this file is queued, then WAIT for the lock so it
  // gets processed next (not dropped). The lock auto-expires (TTL) so this can't wait forever.
  await sendMessage(token, chatId, pickFileQueued());
  const deadline = Date.now() + FILE_QUEUE_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(2500);
    if (await sbAcquireLock(chatId)) return true;
  }
  await sendMessage(token, chatId, 'Still tied up finishing the last one — send that file again in a moment and I’ll grab it.');
  return false;
}

// ---- BATCH SETTLE / DEBOUNCE (one consolidated confirmation per batch) ----
// When a broker forwards N comps (or N photos) at once, each arrives as its own webhook. Without
// debounce the agent emits a separate, growing confirmation after EVERY file ("comp 1?" → "comps 1-2?"
// → "comps 1-2-3?"), which reads like files were lost. Instead each file APPENDS its parsed item to a
// per-chat buffer (cross-instance, in Supabase) under the turn lock (so appends can't clobber), then
// the LAST file to land (none newer for BATCH_SETTLE_MS) drains the buffer and emits ONE consolidated
// confirmation. Buffer = `pending_batch jsonb`, shaped { comp:{items,token}, photo:{items,token} } so
// the two kinds never clobber each other. Each append stamps a fresh token; the settler is whoever's
// token is still latest after the wait. REQUIRES `pending_batch jsonb` (ALTER TABLE) — if absent, the
// write 400s and we fall back to the previous per-file inject+confirm (so it's safe to ship pre-migration).
const BATCH_SETTLE_MS = 2500;
// PATCH the buffer; returns true on success, false if the column doesn't exist (-> fallback path).
async function sbWriteBatch(chatId, pendingBatch) {
  let r;
  try {
    r = await fetch(`${SB_URL}/rest/v1/telegram_sessions?telegram_chat_id=eq.${chatId}`, {
      method: 'PATCH', headers: { ...sbHeaders(), Prefer: 'return=minimal' },
      body: JSON.stringify({ pending_batch: pendingBatch }),
    });
  } catch { return false; }
  return r.ok;
}
// Append one parsed item to the buffer for `kind`. Caller MUST hold the turn lock (serializes the
// read-modify-write). Returns { myToken } on success or { fallback:true } if the column is missing.
async function batchAppend(chatId, kind, item) {
  const myToken = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const row = await sbGet(chatId);
  const pb = (row && row.pending_batch && typeof row.pending_batch === 'object') ? row.pending_batch : {};
  const cur = (pb[kind] && Array.isArray(pb[kind].items)) ? pb[kind] : { items: [] };
  cur.items.push(item);
  cur.token = myToken;
  pb[kind] = cur;
  return (await sbWriteBatch(chatId, pb)) ? { myToken } : { fallback: true };
}
// Wait the settle window, then claim the batch IFF no newer file landed (our token still latest).
// Returns the drained items array if THIS call is the settler, else null (a later file will settle).
async function batchSettle(chatId, kind, myToken) {
  await sleep(BATCH_SETTLE_MS);
  const row = await sbGet(chatId);
  const pb = (row && row.pending_batch && typeof row.pending_batch === 'object') ? row.pending_batch : null;
  if (!pb || !pb[kind] || pb[kind].token !== myToken) return null; // superseded -> a later file settles
  const items = Array.isArray(pb[kind].items) ? pb[kind].items : [];
  delete pb[kind];
  await sbWriteBatch(chatId, Object.keys(pb).length ? pb : null); // clear our slice; keep the other kind
  return items;
}
// Re-take the turn lock for the settler's single consolidated turn (no ack; the file acks already fired).
async function lockWait(chatId, maxMs = FILE_QUEUE_WAIT_MS) {
  if (await sbAcquireLock(chatId)) return true;
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) { await sleep(2000); if (await sbAcquireLock(chatId)) return true; }
  return false;
}

// Answer a STATUS check-in with the real state — never a generic ack. (Mid-generation is
// caught earlier by the guard; this covers failed / active-idle / no-session.)
async function answerStatus(token, chatId, row) {
  if (isGeneratingActive(row)) return sendMessage(token, chatId, 'Still building your BPO — about 30 seconds…');
  if (row && row.status === 'generate_failed') return sendMessage(token, chatId, "That last build didn’t go through — reply \"retry\" and I’ll finish it.");
  if (row && row.status === 'delivered') return sendMessage(token, chatId, "Your BPO is delivered. Tell me any fix and I’ll update it, or say \"new BPO\" to start another.");
  if (row && row.session_id) return sendMessage(token, chatId, "I’m here — still on your BPO. Send the next detail whenever you’re ready.");
  return sendMessage(token, chatId, "I’m here. Send \"new BPO\" to start one.");
}

// ---- Managed Agent session ----
// Lazy SDK: imported + client constructed only on first agent call, never at module init.
let _anthropic = null;
async function getAnthropic() {
  if (!_anthropic) {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _anthropic;
}
let cachedEnvId = null; // one cloud env reused across sessions on a warm instance

async function ensureEnv() {
  if (cachedEnvId) return cachedEnvId;
  const anthropic = await getAnthropic();
  const env = await anthropic.beta.environments.create({ name: 'bpo-tg-env', config: { type: 'cloud' } });
  cachedEnvId = env.id;
  return cachedEnvId;
}
async function newSession() {
  const anthropic = await getAnthropic();
  let envId;
  try { envId = await ensureEnv(); return { ...(await anthropic.beta.sessions.create({ agent: AGENT_ID, environment_id: envId })), envId }; }
  catch (e) { cachedEnvId = null; envId = await ensureEnv(); return { ...(await anthropic.beta.sessions.create({ agent: AGENT_ID, environment_id: envId })), envId }; }
}
async function collectEvents(sessionId) {
  const anthropic = await getAnthropic();
  const evs = [];
  for await (const e of anthropic.beta.sessions.events.list(sessionId, { order: 'asc' })) evs.push(e);
  return evs;
}
// Send one user turn into an existing session; return only the NEW agent text for this turn.
async function sendTurn(sessionId, text, deadlineMs) {
  const anthropic = await getAnthropic();
  const baseline = (await collectEvents(sessionId)).length;
  await anthropic.beta.sessions.events.send(sessionId, { events: [{ type: 'user.message', content: [{ type: 'text', text }] }] });
  while (Date.now() < deadlineMs) {
    const tail = (await collectEvents(sessionId)).slice(baseline);
    if (tail.some((e) => TERMINAL.has(e.type))) {
      return tail.filter((e) => e.type === 'agent.message').flatMap((e) => (e.content || []).map((b) => b.text || '')).join('').trim();
    }
    await sleep(2500);
  }
  return '';
}

// ---- generate signal + PDF delivery ----
function extractGenerate(reply) {
  if (!/GENERATE_BPO/.test(reply)) return null;
  const fenced = reply.match(/```(?:json|JSON)?\s*(\{[\s\S]*?\})\s*```/);
  const jtxt = fenced ? fenced[1] : (reply.match(/\{[\s\S]*\}/) || [])[0];
  if (!jtxt) return null;
  try { return JSON.parse(jtxt); } catch { return null; }
}
// Call /api/generate-pdf with the payload. Returns a structured result; NO Telegram messaging
// here (the bridge owns all broker-facing wording, based on the actual outcome).
async function generatePdf(payload) {
  const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  let r;
  try {
    r = await fetch(GENERATE_PDF_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  } catch (e) {
    return { ok: false, status: 0, kind: 'network', detail: String((e && e.message) || e) };
  }
  const ct = (r.headers.get('content-type') || '').toLowerCase();
  if (r.ok && ct.includes('application/pdf')) {
    return { ok: true, bytes: Buffer.from(await r.arrayBuffer()) };
  }
  const detail = await r.text().catch(() => '');
  // Classify the failure so the broker sees a meaningful message (PDFShift credits exhausted is
  // a service/billing issue, not "your data is bad").
  const kind = /no remaining credits|credits left|\b402\b|\b403\b/i.test(detail) ? 'credits' : 'service';
  return { ok: false, status: r.status, kind, detail };
}

// Bridge owns ALL "building / sent / failed" messaging, driven by real results. The agent
// never speaks to delivery. On failure we keep the stashed payload so a retry can re-run.
async function runGeneration(token, chatId, payload, opts = {}) {
  await sbMarkGenerating(chatId, payload);                 // stash payload + extend the turn lock
  if (!opts.ackedBuilding) await sendMessage(token, chatId, 'Building your BPO now ⏳'); // skip if already acked on generate-intent
  const result = await generatePdf(payload);

  if (result.ok) {
    const addr = (payload.subject && payload.subject.address_line1) || 'BPO';
    const fname = `Eagen_BPO_${String(addr).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}.pdf`;
    if (await sendDocument(token, chatId, result.bytes, fname)) {  // attach FIRST
      await sendMessage(token, chatId, '✅ Your BPO is ready. Spot an error? Tell me the fix (e.g. “change the asking price to 1.6M”) and I’ll update it — or say “new BPO” to start another.');
      await sbMarkDelivered(chatId);                               // keep the session for post-delivery edits
      return true;
    }
    console.error('sendDocument failed for chat', chatId);
    await sendMessage(token, chatId, '⚠️ I built your BPO but couldn’t attach it. Reply "retry" to resend.');
    await sbMarkFailed(chatId);
    return false;
  }

  console.error('generate-pdf failed:', result.status, result.kind, result.detail);
  const msg = result.kind === 'credits'
    ? '⚠️ The PDF service is temporarily unavailable. Your BPO is saved — reply "retry" and I’ll finish it as soon as it’s back.'
    : '⚠️ Hit a snag building the PDF. Reply "retry" to try again.';
  await sendMessage(token, chatId, msg);
  await sbMarkFailed(chatId);
  return false;
}

// ---- xlsx rent-roll: bridge parses, then injects the tenants into the agent session ----
async function parseRentRoll(bytes) {
  const body = new URLSearchParams({ file_base64: bytes.toString('base64') }).toString();
  let r;
  try { r = await fetch(PARSE_RENTROLL_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }); }
  catch (e) { return { ok: false, detail: String((e && e.message) || e) }; }
  const j = await r.json().catch(() => null);
  if (r.ok && j && Array.isArray(j.tenants)) return { ok: true, tenants: j.tenants };
  return { ok: false, detail: (j && (j.detail || j.error)) || ('HTTP ' + r.status) };
}

// An xlsx arrived: download -> parse -> inject parsed tenants into the chat's session so the
// agent goes straight to the per-suite confirmation (broker never types an uploaded rent roll).
async function handleXlsx(token, chatId, doc) {
  const stop = startTyping(token, chatId);
  let lockTaken = false;
  try {
    // Queue behind any in-flight turn (don't reject) so batched uploads all process. fileGateAcquire
    // sends the instant ack (free now) or a "queued" ack (waited). File ingest never generates.
    lockTaken = await fileGateAcquire(token, chatId, 'Got it — let me look that over…');
    if (!lockTaken) return;
    const meta = await tgGetFile(token, doc.file_id);
    const bytes = meta && meta.file_path ? await tgDownloadFile(token, meta.file_path) : null;
    if (!bytes) {
      recordUpload(chatId, { name: doc.file_name || 'your spreadsheet', kind: 'document', supported: false, readable: 'that file' });
      await sendMessage(token, chatId, `Got ${doc.file_name || 'your file'}, but couldn’t download it from Telegram. Type the rent roll and I’ll take it from there.`);
      return;
    }
    const parsed = await parseRentRoll(bytes);
    if (!parsed.ok || !parsed.tenants.length) {
      console.error('parse-rentroll failed:', parsed.detail);
      recordUpload(chatId, { name: doc.file_name || 'your spreadsheet', kind: 'document', supported: false, readable: 'that spreadsheet' });
      await sendMessage(token, chatId, `Got ${doc.file_name || 'your spreadsheet'}, but I couldn’t read a rent roll from it${parsed.detail ? ` (${parsed.detail})` : ''}. You can type the rent roll instead.`);
      return;
    }
    recordUpload(chatId, { name: doc.file_name || 'your spreadsheet', kind: 'xlsx', supported: true, readable: 'spreadsheet' });

    // Resolve/continue the chat's BPO session.
    let row = await sbGet(chatId);
    let sessionId;
    if (!row) { const s = await newSession(); sessionId = s.id; await sbUpsert(chatId, sessionId, s.envId); }
    else sessionId = row.session_id;

    const injection =
      `[The broker uploaded a rent-roll spreadsheet "${doc.file_name || 'rent_roll.xlsx'}". It has already been parsed for you — do NOT ask them to type it. Use these tenants EXACTLY as given (carry odd values through), and go straight to the RENT-ROLL CONFIRMATION step now.]\n` +
      `Parsed tenants (JSON):\n${JSON.stringify(parsed.tenants)}`;

    const deadline = Date.now() + 200000;
    let reply;
    try { reply = await sendTurn(sessionId, injection, deadline); }
    catch (e) {
      const s = await newSession(); sessionId = s.id; await sbUpsert(chatId, sessionId, s.envId);
      reply = await sendTurn(sessionId, injection, deadline);
    }
    if (!reply) { await sendMessage(token, chatId, `Read ${parsed.tenants.length} tenants from ${doc.file_name || 'your spreadsheet'}, but couldn’t get the confirmation back in time. Send it again.`); return; }

    const payload = extractGenerate(reply);
    if (payload) { await runGeneration(token, chatId, payload); return; }
    await sbTouch(chatId);
    await sendMessage(token, chatId, reply);
  } catch (e) {
    console.error('handleXlsx error:', (e && e.message) || e);
    try { await sendMessage(token, chatId, `Got ${doc.file_name || 'your file'}, but hit an error processing it. Type the rent roll and I’ll continue.`); } catch { /* ignore */ }
  } finally {
    if (lockTaken) await sbReleaseLock(chatId);
    stop();
  }
}

// ---- MLS Matrix comp PDF: bridge parses (parse-comp-pdf), uploads the photo, injects the comp ----
async function parseCompPdf(bytes) {
  const body = new URLSearchParams({ file_base64: bytes.toString('base64') }).toString();
  let r;
  try { r = await fetch(PARSE_COMP_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }); }
  catch (e) { return { ok: false, detail: String((e && e.message) || e) }; }
  const j = await r.json().catch(() => null);
  if (r.ok && j && j.comp) return { ok: true, comp: j.comp, photo_base64: j.photo_base64 || null };
  return { ok: false, detail: (j && (j.detail || j.error)) || ('HTTP ' + r.status) };
}

// Inject one OR a whole batch of parsed comps in a SINGLE agent turn -> ONE COMP CONFIRMATION block.
// Caller holds the turn lock. Used both for the settled batch (N comps) and the no-column fallback (1).
async function injectCompsAndReply(token, chatId, comps) {
  let row = await sbGet(chatId);
  let sessionId;
  if (!row || !row.session_id) { const s = await newSession(); sessionId = s.id; await sbUpsert(chatId, sessionId, s.envId); }
  else sessionId = row.session_id;
  const n = comps.length, many = n > 1;
  const injection =
    `[The broker uploaded ${n} MLS Matrix comp PDF${many ? 's together (a batch)' : ''}. The system has already parsed ${many ? 'them' : 'it'} — do NOT ask them to type anything. ADD ${many ? 'these comps' : 'this comp'} to any comps you already have for this BPO (accumulate). Each comp photo is uploaded; use its photo_url EXACTLY as given. Then run the COMP CONFIRMATION step ONCE: show ALL comps captured so far in the comp-confirmation block format and ask the broker to confirm before you use them. Do NOT modify, recompute, or invent any field — OCR can slip a digit, which is exactly why the broker confirms.]\n` +
    `Parsed comp${many ? 's' : ''} (JSON${many ? ' array' : ''}):\n${JSON.stringify(many ? comps : comps[0])}`;
  const deadline = Date.now() + 200000;
  let reply;
  try { reply = await sendTurn(sessionId, injection, deadline); }
  catch (e) {
    const s = await newSession(); sessionId = s.id; await sbUpsert(chatId, sessionId, s.envId);
    reply = await sendTurn(sessionId, injection, deadline);
  }
  if (!reply) { await sendMessage(token, chatId, `Read the comp${many ? 's' : ''}, but couldn’t get the confirmation back in time. Send ${many ? 'them' : 'it'} again.`); return; }
  const payload = extractGenerate(reply);
  if (payload) { await runGeneration(token, chatId, payload); return; }
  await sbTouch(chatId);
  await sendMessage(token, chatId, reply.replace(/^\s*GENERATE_BPO\s*/i, '').trim() || reply);
}

// A comp PDF arrived: download -> parse-comp-pdf -> upload the extracted photo to Supabase ->
// append it to the batch buffer. Agent accumulates comps and runs the A6-style COMP CONFIRMATION
// (ONCE per batch) before any generation. Bridge does ALL file work; agent only places the confirmed
// comp data + photo_url into the payload (same pattern as xlsx/subject photo).
async function handleCompPdf(token, chatId, doc) {
  const stop = startTyping(token, chatId);
  let lockTaken = false;
  try {
    // Queue behind any in-flight turn (don't reject) so a batch of comp PDFs all accumulate.
    lockTaken = await fileGateAcquire(token, chatId, `Reading ${doc.file_name || 'that comp PDF'}…`);
    if (!lockTaken) return;
    const meta = await tgGetFile(token, doc.file_id);
    const bytes = meta && meta.file_path ? await tgDownloadFile(token, meta.file_path) : null;
    if (!bytes) {
      recordUpload(chatId, { name: doc.file_name || 'that PDF', kind: 'document', supported: false, readable: 'that file' });
      await sendMessage(token, chatId, `Got ${doc.file_name || 'your PDF'}, but couldn’t download it from Telegram. Send it again.`);
      return;
    }
    const parsed = await parseCompPdf(bytes);
    if (!parsed.ok || !parsed.comp) {
      console.error('parse-comp-pdf failed:', parsed.detail);
      recordUpload(chatId, { name: doc.file_name || 'that PDF', kind: 'document', supported: false, readable: 'that PDF' });
      await sendMessage(token, chatId, `Got ${doc.file_name || 'your PDF'}, but I couldn’t read a comp from it${parsed.detail ? ` (${parsed.detail})` : ''}. You can type the comp details instead.`);
      return;
    }

    // Upload the extracted photo (if any) -> public URL. Bridge owns file work; agent gets a URL.
    let photo_url = null;
    if (parsed.photo_base64) {
      try { photo_url = await uploadPhoto(Buffer.from(parsed.photo_base64, 'base64'), `${chatId}/comp_${Date.now()}.png`, 'png'); }
      catch (e) { console.error('comp photo upload error:', (e && e.message) || e); }
    }
    const comp = { ...parsed.comp, photo_url };
    recordUpload(chatId, { name: doc.file_name || 'that comp PDF', kind: 'comp_pdf', supported: true, readable: 'MLS comp PDF' });

    // Debounce a BATCH of comps into ONE confirmation: append under the held lock (atomic), release so
    // the rest of the batch can land, then only the settler (no newer comp for BATCH_SETTLE_MS) emits.
    const appended = await batchAppend(chatId, 'comp', comp);
    if (appended.fallback) { await injectCompsAndReply(token, chatId, [comp]); return; } // no column -> per-file
    await sbReleaseLock(chatId); lockTaken = false;          // let the rest of the batch append
    const items = await batchSettle(chatId, 'comp', appended.myToken);
    if (!items) return;                                       // a later comp will emit the consolidated confirmation
    if (!(await lockWait(chatId))) return;                    // re-take the lock for the single consolidated turn
    lockTaken = true;
    await injectCompsAndReply(token, chatId, items);
  } catch (e) {
    console.error('handleCompPdf error:', (e && e.message) || e);
    try { await sendMessage(token, chatId, `Got ${doc.file_name || 'your PDF'}, but hit an error reading it. You can type the comp details instead.`); } catch { /* ignore */ }
  } finally {
    if (lockTaken) await sbReleaseLock(chatId);
    stop();
  }
}

// ---- VOICE memo: transcribe (Whisper) and feed the transcript to the agent as if typed --------
// One-way: voice IN, text OUT. The brain stays text-only — it never sees audio, only the transcript.
// Mis-transcriptions (esp. numbers) are caught by the agent's existing confirmation/reconciliation
// steps, which the transcript flows through exactly like a typed message. Key from env, never logged.
async function transcribe(bytes, filePath) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) { console.error('OPENAI_API_KEY not set'); return { ok: false, reason: 'no-key' }; }
  // Telegram voice notes are OGG/Opus (file_path ends .oga); Whisper accepts oga/ogg/m4a/mp3/wav/webm.
  const ext = (((filePath || '').match(/\.([A-Za-z0-9]+)$/) || [])[1] || 'oga').toLowerCase();
  const fd = new FormData();
  fd.append('file', new Blob([bytes]), `voice.${ext}`);
  fd.append('model', 'whisper-1');
  let r;
  try {
    r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: fd, // fetch sets multipart boundary
    });
  } catch (e) { console.error('whisper request error:', (e && e.message) || e); return { ok: false, reason: 'network' }; }
  if (!r.ok) { console.error('whisper http', r.status, await r.text().catch(() => '')); return { ok: false, reason: 'http-' + r.status }; }
  const j = await r.json().catch(() => null);
  const text = j && typeof j.text === 'string' ? j.text.trim() : '';
  return text ? { ok: true, text } : { ok: false, reason: 'empty' };
}

// A VOICE memo arrived: instant ack, grab the audio bytes (tg-7 getFile), transcribe via Whisper,
// then run the transcript as a normal agent turn (the same session path a typed message takes).
async function handleVoice(token, chatId, voice) {
  const _tm = newTiming('voice', chatId);
  const stop = startTyping(token, chatId);
  let lockTaken = false;
  try {
    // Queue behind any in-flight turn (like file uploads); instant "listening…" ack BEFORE Whisper.
    lockTaken = await fileGateAcquire(token, chatId, 'Got it — listening…');
    if (!lockTaken) return;
    const meta = voice && voice.file_id ? await tgGetFile(token, voice.file_id) : null;
    const bytes = meta && meta.file_path ? await tgDownloadFile(token, meta.file_path) : null;
    mark(_tm, 'downloaded');
    if (!bytes) { await sendMessage(token, chatId, "Couldn’t grab that voice memo from Telegram — send it again or type it."); return; }

    const tr = await transcribe(bytes, meta.file_path);
    mark(_tm, 'transcribed');
    if (!tr.ok || !tr.text) {
      console.error('transcription failed:', tr.reason);
      await sendMessage(token, chatId, "Couldn’t make out that voice memo — try again or type the details.");
      return;
    }
    recordUpload(chatId, { name: 'your voice memo', kind: 'voice', supported: true, readable: 'voice notes' });

    // Feed the transcript to the agent AS IF the broker typed it — same session continuation a text
    // turn uses. Mis-transcriptions (esp. numbers) surface at the agent's confirmation step, not here.
    let row = await sbGet(chatId);
    let sessionId;
    if (!row) { const s = await newSession(); sessionId = s.id; await sbUpsert(chatId, sessionId, s.envId); }
    else sessionId = row.session_id;

    const deadline = Date.now() + 200000;
    let reply;
    try { reply = await sendTurn(sessionId, tr.text, deadline); }
    catch (e) {
      const s = await newSession(); sessionId = s.id; await sbUpsert(chatId, sessionId, s.envId);
      reply = await sendTurn(sessionId, tr.text, deadline);
    }
    mark(_tm, 'agentReply');
    if (!reply) { await sendMessage(token, chatId, "Got your voice memo but couldn’t get a reply in time — try again."); return; }

    const payload = extractGenerate(reply);
    if (payload) { await runGeneration(token, chatId, payload); return; }
    await sbTouch(chatId);
    await sendMessage(token, chatId, reply.replace(/^\s*GENERATE_BPO\s*/i, '').trim() || reply);
  } catch (e) {
    console.error('handleVoice error:', (e && e.message) || e);
    try { await sendMessage(token, chatId, "Hit an error with that voice memo — try again or type it."); } catch { /* ignore */ }
  } finally {
    if (lockTaken) await sbReleaseLock(chatId);
    stop();
    commitTiming(_tm);
  }
}

// Unsupported upload (non-xlsx doc, photo, voice, etc.): acknowledge it by name, say plainly
// it can't be read yet, and give the broker the actionable fallback.
async function handleUnsupportedFile(token, chatId, fileName, kind) {
  const label = readableType(kind);
  recordUpload(chatId, { name: fileName || `your ${kind}`, kind, supported: false, readable: label });
  const what = fileName ? `Got ${fileName}` : `Got your ${kind === 'voice' ? 'voice note' : kind}`;
  await sendMessage(token, chatId, `${what}, but I can’t read ${label} yet — type the details and I’ll take it from there.`);
}

// ---- subject photo: upload to the public Supabase Storage bucket, return the public URL. ----
const PHOTO_BUCKET = 'brokeros-photos';
async function uploadPhoto(bytes, key, ext) {
  const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  let r;
  try {
    r = await fetch(`${SB_URL}/storage/v1/object/${PHOTO_BUCKET}/${key}`, {
      method: 'POST',
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': mime, 'x-upsert': 'true' },
      body: bytes,
    });
  } catch (e) { console.error('photo upload error:', (e && e.message) || e); return null; }
  if (!r.ok) { console.error('photo upload failed:', r.status, await r.text().catch(() => '')); return null; }
  return `${SB_URL}/storage/v1/object/public/${PHOTO_BUCKET}/${key}`;
}

// Inject one OR a whole batch of subject-photo URLs in a SINGLE turn, and send ONE "got your N photos"
// (the bridge owns the count confirmation). Caller holds the turn lock. Used for the settled batch and
// the no-column fallback (1).
async function injectPhotosAndReply(token, chatId, urls) {
  let row = await sbGet(chatId);
  let sessionId;
  if (!row || !row.session_id) { const s = await newSession(); sessionId = s.id; await sbUpsert(chatId, sessionId, s.envId); }
  else sessionId = row.session_id;
  const n = urls.length, many = n > 1;
  await sendMessage(token, chatId, many ? `Got your ${n} photos — I’ll place them across the BPO.` : 'Got the property photo.');
  const injection =
    `[The broker sent ${n} SUBJECT PROPERTY photo${many ? 's together (a batch)' : ''}. Public URL${many ? 's IN ORDER' : ''}:\n${urls.join('\n')}\n` +
    `APPEND ${many ? 'all of these' : 'this URL'} to subject.photo_urls — an ORDERED array. KEEP any URLs already there and add ${many ? 'these' : 'this one'} to the end; never drop earlier photos. The FIRST photo ever received is the cover hero; the rest the server distributes across the BPO (exec summary, section dividers, comps subject row). Do not ask for the cover again. The broker was ALREADY told the count, so do NOT re-list or re-count the photos — acknowledge in at most one short line (or nothing) and continue the flow.]`;
  const deadline = Date.now() + 200000;
  let reply;
  try { reply = await sendTurn(sessionId, injection, deadline); }
  catch (e) {
    const s = await newSession(); sessionId = s.id; await sbUpsert(chatId, sessionId, s.envId);
    reply = await sendTurn(sessionId, injection, deadline);
  }
  if (!reply) return; // already sent the count confirmation
  const payload = extractGenerate(reply);
  if (payload) { await runGeneration(token, chatId, payload); return; }
  await sbTouch(chatId);
  await sendMessage(token, chatId, reply.replace(/^\s*GENERATE_BPO\s*/i, '').trim() || reply);
}

// A PHOTO arrived: grab bytes (tg-7), store in the bucket, append it to the batch buffer; the settler
// injects all URLs as SUBJECT photos. Bridge does all file work; agent only places the URLs.
async function handlePhoto(token, chatId, photos) {
  const _tm = newTiming('photo', chatId);
  const stop = startTyping(token, chatId);
  let lockTaken = false;
  try {
    // Queue behind any in-flight turn (don't reject) so batched photos all process + distribute.
    lockTaken = await fileGateAcquire(token, chatId, 'Got it — saving your photo…');
    if (!lockTaken) return;
    mark(_tm, 'ackSent');

    const best = Array.isArray(photos) && photos.length ? photos[photos.length - 1] : null; // largest size
    const meta = best ? await tgGetFile(token, best.file_id) : null;
    const bytes = meta && meta.file_path ? await tgDownloadFile(token, meta.file_path) : null;
    mark(_tm, 'downloaded');
    if (!bytes) {
      await sendMessage(token, chatId, "Couldn’t grab that image from Telegram — send it again.");
      return;
    }
    const ext = ((meta.file_path.match(/\.([A-Za-z0-9]+)$/) || [])[1] || 'jpg').toLowerCase();
    const url = await uploadPhoto(bytes, `${chatId}/${Date.now()}.${ext}`, ext);
    mark(_tm, 'uploaded');
    if (!url) {
      await sendMessage(token, chatId, "Couldn’t save that image — try again.");
      return;
    }
    recordUpload(chatId, { name: 'the property photo', kind: 'photo', supported: true, readable: 'images' });
    mark(_tm, 'photoConfirm');

    // Debounce a BATCH of photos into ONE "got your N photos": append under the held lock, release so
    // the rest of the batch lands, then only the settler injects all URLs + sends one count message.
    const appended = await batchAppend(chatId, 'photo', url);
    if (appended.fallback) { await injectPhotosAndReply(token, chatId, [url]); mark(_tm, 'agentReply'); return; } // no column -> per-file
    await sbReleaseLock(chatId); lockTaken = false;          // let the rest of the batch append
    const urls = await batchSettle(chatId, 'photo', appended.myToken);
    if (!urls) return;                                       // a later photo will emit the consolidated ack
    if (!(await lockWait(chatId))) return;                    // re-take the lock for the single consolidated turn
    lockTaken = true;
    await injectPhotosAndReply(token, chatId, urls);
    mark(_tm, 'agentReply');
  } catch (e) {
    console.error('handlePhoto error:', (e && e.message) || e);
    try { await sendMessage(token, chatId, "Hit an error saving that photo — send it again."); } catch { /* ignore */ }
  } finally {
    if (lockTaken) await sbReleaseLock(chatId);
    stop();
    commitTiming(_tm);
  }
}

export default async function handler(req, res) {
  // Secret-safe Supabase round-trip self-test (GET ?selftest=supabase). Uses the server-side
  // service key already in env (never returned); writes/reads/deletes a sentinel row to prove
  // the telegram_sessions table is reachable before a full multi-turn phone test.
  if (req.method === 'GET' && req.query && req.query.selftest === 'supabase') {
    if (!sbConfigured()) return res.status(200).json({ selftest: 'supabase', ok: false, reason: 'SUPABASE_URL/SUPABASE_SERVICE_KEY not set' });
    const sentinel = 999000999;
    try {
      await sbUpsert(sentinel, 'selftest-session', 'selftest-env');
      const row = await sbGet(sentinel);
      await sbDelete(sentinel);
      const ok = !!(row && row.session_id === 'selftest-session');
      return res.status(200).json({ selftest: 'supabase', ok, roundtrip: !!row });
    } catch (e) {
      return res.status(200).json({ selftest: 'supabase', ok: false, error: String((e && e.message) || e) });
    }
  }
  // Batch-debounce proof (confirms the `pending_batch` migration ran + the append/settle logic). Two
  // appends, then settle: the stale token gets nothing, the latest token drains both items. If the
  // column is missing, the first append reports fallback -> tells you the ALTER TABLE still needs running.
  if (req.method === 'GET' && req.query && req.query.selftest === 'batch') {
    if (!sbConfigured()) return res.status(200).json({ selftest: 'batch', ok: false, reason: 'supabase not set' });
    const sentinel = 999000333;
    try {
      await sbUpsert(sentinel, 'selftest-session', 'selftest-env');
      const a1 = await batchAppend(sentinel, 'comp', { tag: 'one' });
      if (a1.fallback) { await sbDelete(sentinel); return res.status(200).json({ selftest: 'batch', ok: false, columnPresent: false, reason: 'pending_batch column missing — run: ALTER TABLE telegram_sessions ADD COLUMN IF NOT EXISTS pending_batch jsonb;' }); }
      const a2 = await batchAppend(sentinel, 'comp', { tag: 'two' });
      const mid = await sbGet(sentinel);
      const buffered = mid && mid.pending_batch && mid.pending_batch.comp ? mid.pending_batch.comp.items.length : 0;
      const stale = await batchSettle(sentinel, 'comp', a1.myToken); // superseded -> null
      const drained = await batchSettle(sentinel, 'comp', a2.myToken); // settler -> [one, two]
      await sbDelete(sentinel);
      const ok = buffered === 2 && stale === null && Array.isArray(drained) && drained.length === 2;
      return res.status(200).json({ selftest: 'batch', ok, columnPresent: true, buffered, staleGotNull: stale === null, drainedCount: Array.isArray(drained) ? drained.length : null });
    } catch (e) {
      try { await sbDelete(sentinel); } catch { /* ignore */ }
      return res.status(200).json({ selftest: 'batch', ok: false, error: String((e && e.message) || e) });
    }
  }
  // Concurrency proof for the per-chat TURN LOCK: fire N concurrent atomic acquires against a
  // sentinel row; exactly ONE must win (this is what closes the agent-deciding window). Then prove
  // a held lock rejects further acquires, and a released lock can be re-taken.
  if (req.method === 'GET' && req.query && req.query.selftest === 'lockrace') {
    if (!sbConfigured()) return res.status(200).json({ selftest: 'lockrace', ok: false, reason: 'supabase not set' });
    const sentinel = 999000222;
    const N = Math.min(Math.max(Number(req.query.n) || 6, 2), 20);
    try {
      await sbUpsert(sentinel, 'lockrace', 'lockrace');   // ensure the row exists
      await sbReleaseLock(sentinel);                      // start with the lock free
      const winners = (await Promise.all(Array.from({ length: N }, () => sbAcquireLock(sentinel)))).filter(Boolean).length;
      const wave2 = (await Promise.all(Array.from({ length: 3 }, () => sbAcquireLock(sentinel)))).filter(Boolean).length; // lock held -> expect 0
      await sbReleaseLock(sentinel);
      const afterRelease = (await sbAcquireLock(sentinel)) ? 1 : 0;                                 // expect 1
      await sbReleaseLock(sentinel);
      await sbDelete(sentinel);
      return res.status(200).json({ selftest: 'lockrace', n: N, winners, wave2_winners: wave2, after_release_winner: afterRelease,
        ok: winners === 1 && wave2 === 0 && afterRelease === 1 });
    } catch (e) {
      try { await sbDelete(sentinel); } catch { /* ignore */ }
      return res.status(200).json({ selftest: 'lockrace', ok: false, error: String((e && e.message) || e) });
    }
  }
  // Diagnostic: latency breakdown of the most recent turn (ms from background start).
  if (req.method === 'GET' && req.query && req.query.selftest === 'timing') {
    return res.status(200).json({
      selftest: 'timing',
      module_age_ms: Date.now() - MODULE_LOADED_AT,
      instance_served: instanceServed,
      now_uptime_ms: Math.round(process.uptime() * 1000),
      lastTiming,
    });
  }
  // Diagnostic: which agent does PROD actually resolve, and is it live? (agent_id/name are
  // not secrets.) Proves env-override vs bundled-default and that it isn't the archived agent.
  if (req.method === 'GET' && req.query && req.query.selftest === 'agent') {
    const out = { selftest: 'agent', agent_id: AGENT_ID, source: process.env.BROKEROS_AGENT_ID ? 'env:BROKEROS_AGENT_ID' : 'bundled-default' };
    try {
      const anthropic = await getAnthropic();
      const a = await anthropic.beta.agents.retrieve(AGENT_ID);
      out.name = a.name;
      out.archived = !!a.archived_at;
    } catch (e) {
      out.retrieve_error = String((e && e.message) || e);
    }
    return res.status(200).json(out);
  }
  // Confirm OPENAI_API_KEY is readable by the function (presence/length only, never the value) so a
  // voice-in phone test won't silently fail on a missing/mis-named env var.
  if (req.method === 'GET' && req.query && req.query.selftest === 'whisper') {
    const k = process.env.OPENAI_API_KEY || '';
    return res.status(200).json({ selftest: 'whisper', key_present: !!k, key_len: k.length });
  }
  if (req.method === 'GET' || (req.query && req.query.version !== undefined)) {
    return res.status(200).json({ version: VERSION, endpoint: 'telegram-webhook', increment: 3 });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = process.env.TELEGRAM_BOT_TOKEN;

  let update = req.body;
  if (typeof update === 'string') { try { update = JSON.parse(update); } catch { update = {}; } }
  update = update || {};
  const msg = update.message || update.edited_message || update.channel_post || null;
  const type = classify(msg);
  if (!msg || !msg.chat) return res.status(200).json({ ok: true, version: VERSION, handled: 'no-message', type });

  const chatId = msg.chat.id;
  if (!token) return res.status(200).json({ ok: true, version: VERSION, type, sent: false, reason: 'TELEGRAM_BOT_TOKEN not set in Vercel env' });

  // DOCUMENT: an XLSX is parsed (parse-rentroll) and injected into the session as the rent
  // roll; any other document is acknowledged with the actionable "type it instead" fallback.
  if (type === 'document') {
    const doc = msg.document;
    const xlsx = isXlsxDoc(doc);
    const compPdf = !xlsx && isCompPdf(doc);
    const mode = xlsx ? 'xlsx' : compPdf ? 'comp-pdf' : 'unsupported-file';
    res.status(200).json({ ok: true, version: VERSION, type, mode });
    if ((xlsx || compPdf) && !sbConfigured()) {
      waitUntil((async () => { try { await sendMessage(token, chatId, '⚙️ Session store not configured yet — add SUPABASE_URL and SUPABASE_SERVICE_KEY in Vercel and redeploy.'); } catch { /* ignore */ } })());
      return;
    }
    waitUntil(xlsx ? handleXlsx(token, chatId, doc)
      : compPdf ? handleCompPdf(token, chatId, doc)
      : handleUnsupportedFile(token, chatId, doc.file_name, 'document'));
    return;
  }

  // PHOTO: subject property hero — upload to the bucket and inject the URL (Photos Part 1).
  if (type === 'photo') {
    res.status(200).json({ ok: true, version: VERSION, type, mode: 'photo' });
    if (!sbConfigured()) {
      waitUntil((async () => { try { await sendMessage(token, chatId, '⚙️ Session store not configured yet — add SUPABASE_URL and SUPABASE_SERVICE_KEY in Vercel and redeploy.'); } catch { /* ignore */ } })());
      return;
    }
    waitUntil(handlePhoto(token, chatId, msg.photo));
    return;
  }

  // VOICE / AUDIO: transcribe (Whisper) server-side and feed the transcript to the agent as text.
  // One-way (voice IN, text OUT). Queues + processes like any turn; never triggers a 2nd generation.
  if (type === 'voice' || type === 'audio') {
    res.status(200).json({ ok: true, version: VERSION, type, mode: 'voice' });
    if (!sbConfigured()) {
      waitUntil((async () => { try { await sendMessage(token, chatId, '⚙️ Session store not configured yet — add SUPABASE_URL and SUPABASE_SERVICE_KEY in Vercel and redeploy.'); } catch { /* ignore */ } })());
      return;
    }
    waitUntil(handleVoice(token, chatId, msg.voice || msg.audio));
    return;
  }

  // Other non-text (video/sticker/etc.): acknowledge by type with the actionable fallback.
  if (type !== 'text') {
    res.status(200).json({ ok: true, version: VERSION, type, mode: 'unsupported-file' });
    waitUntil(handleUnsupportedFile(token, chatId, null, type));
    return;
  }

  // Multi-turn requires the session store.
  if (!sbConfigured()) {
    res.status(200).json({ ok: true, version: VERSION, type, mode: 'no-session-store' });
    waitUntil((async () => { try { await sendMessage(token, chatId, '⚙️ Session store not configured yet — add SUPABASE_URL and SUPABASE_SERVICE_KEY in Vercel and redeploy.'); } catch { /* ignore */ } })());
    return;
  }

  // Fast 200; everything else in the background.
  res.status(200).json({ ok: true, version: VERSION, type, mode: 'agent-async' });
  const incoming = msg.text;

  const _tm = newTiming('text', chatId); // latency diagnostics (t0 = background start)
  waitUntil((async () => {
    let stopTyping = () => {};
    try {
      // Explicit END command.
      if (END_RE.test(incoming)) {
        await sbDelete(chatId);
        await sendMessage(token, chatId, "Session ended. Send 'new BPO' to start again.");
        return;
      }

      const ackKind = classifyAck(incoming);
      const genIntent = GENERATE_INTENT_RE.test(incoming);
      let buildAcked = false;

      // Fire the typing indicator + (for heavy data turns) the text ack IMMEDIATELY and in PARALLEL,
      // before any Supabase/agent work. Generate-intent does NOT ack here — its build ack fires once
      // we actually hold the turn lock (below), so it never double-messages when the chat is busy.
      if (ackKind !== 'status') {
        stopTyping = startTyping(token, chatId);
        await Promise.all([
          sendChatAction(token, chatId, 'typing'),
          (ackKind === 'data' && !genIntent) ? sendMessage(token, chatId, pickAck()) : Promise.resolve(),
        ]);
        mark(_tm, 'ackSent');
      }

      const wantStart = START_RE.test(incoming) || NEWBPO_RE.test(incoming);
      let row = await sbGet(chatId);
      mark(_tm, 'sbGet');

      // TURN-LOCK GUARD (cheap, from the row already read): a turn is in flight for this chat —
      // either the agent is DECIDING (the window the old guard missed) or a PDF is BUILDING. Don't
      // start a second turn; give the busy response. (The atomic acquire below covers the race
      // where a concurrent message read the row before the lock was set.)
      if (lockHeld(row)) {
        await sendMessage(token, chatId, busyLine(row)); // context-aware: "still building ~30s" vs "finishing your last message"
        return;
      }

      // STATUS check-in -> answer with real state, no agent turn, no generic ack.
      if (ackKind === 'status') {
        // "did you get the file?" -> answer from what we actually received.
        const up = getRecentUpload(chatId);
        if (FILE_STATUS_RE.test(incoming) && up) {
          await sendMessage(token, chatId, up.supported
            ? `Yes — got ${up.name}. Working through it now.`
            : `Yes — got ${up.name}. But I can’t read ${up.readable} yet — type the details and I’ll take it from there.`);
          return;
        }
        await answerStatus(token, chatId, row);
        return;
      }

      // TURN LOCK (atomic): everything below can run an agent turn and/or a generation. Take the
      // per-chat lock so a concurrent message that slipped past the cheap guard (stale read) can't
      // start a second turn. A brand-new chat has no row yet -> nothing to collide with; it skips
      // the DB lock here and locks itself once its session row exists (in the fresh-start branch).
      let lockTaken = false;
      if (row) {
        if (!(await sbAcquireLock(chatId))) { await sendMessage(token, chatId, busyLine(row)); return; }
        lockTaken = true;
      }
      try {
      // Generate-intent: we now hold the turn lock and will run the turn -> acknowledge the BUILD
      // immediately rather than leaving the broker on the generic line while the agent decides.
      if (genIntent) { await sendMessage(token, chatId, 'Got it — building your BPO now ⏳'); buildAcked = true; }
      // RETRY after a failed generation: re-run the stashed payload directly (no agent round
      // trip, no reliance on the agent re-emitting). Any other message clears the failed state
      // and routes to the agent normally (so the broker can also correct data instead).
      if (row && row.status === 'generate_failed' && row.last_payload) {
        if (RETRY_RE.test(incoming)) {
          await runGeneration(token, chatId, row.last_payload, { ackedBuilding: buildAcked }); // typing already pulsing
          return;
        }
        await sbClearState(chatId); // not a retry -> fall through to a normal agent turn
        row = { ...row, status: null };
      }

      // EXPIRY: a delivered BPO stays correctable only for DELIVERED_TTL. A non-start message
      // after that window is poking a long-closed BPO — close it and ask, rather than resurfacing
      // stale state. (Bare "BPO" / "new BPO" / "start a BPO" are 'new' and skip this.)
      if (deliveredDecision(row, incoming) === 'closed') {
        await sbDelete(chatId);
        await sendMessage(token, chatId, "That BPO session has closed — want me to start a new one? Send \"new BPO\" and we’ll begin.");
        return;
      }

      // Normal agent turn — typing is already pulsing and the ack was already sent above.
      try {
        // A non-"new BPO" message while a delivered BPO is on file = a post-delivery correction:
        // reuse the SAME session (which still holds the built payload) so the agent edits it.
        const editingDelivered = !wantStart && row && row.status === 'delivered' && row.session_id;

        let sessionId;
        if (wantStart || !row) {            // START: fresh session, wiped clean
          const s = await newSession();
          sessionId = s.id;
          await sbUpsert(chatId, sessionId, s.envId);
          await sbClearState(chatId);       // drop any prior delivered/generating/failed state
          if (!lockTaken) { await sbAcquireLock(chatId); lockTaken = true; } // lock this fresh turn (row now exists)
        } else {                            // REUSE: same stateful session = memory
          sessionId = row.session_id;
        }

        // Bare start command ("/start", "/new", "BPO") -> kick the agent's intake; otherwise pass through.
        const toSend = /^\s*\/?(start|new|bpo)\s*$/i.test(incoming) ? 'Hi, I need to start a new BPO.' : incoming;

        const deadline = Date.now() + 200000; // generous; returns as soon as the agent is idle
        let reply;
        try {
          reply = await sendTurn(sessionId, toSend, deadline);
        } catch (e) {
          // The stored session/env was reclaimed. For a post-delivery edit the context is gone,
          // so recreating blank would lose the BPO — tell the broker to restart instead.
          if (editingDelivered) {
            await sendMessage(token, chatId, "That BPO’s session has expired, so I can’t edit it in place anymore. Send “new BPO” and I’ll rebuild it.");
            return;
          }
          const s = await newSession();
          sessionId = s.id;
          await sbUpsert(chatId, sessionId, s.envId);
          reply = await sendTurn(sessionId, toSend, deadline);
        }

        mark(_tm, 'agentReply'); // agent produced its reply
        if (!reply) { await sendMessage(token, chatId, "Sorry — I couldn't get a reply in time. Please try again."); return; }

        // Generation signal? Hand the payload to the bridge — it owns building/sent/failed.
        const payload = extractGenerate(reply);
        if (payload) {
          await runGeneration(token, chatId, payload, { ackedBuilding: buildAcked });
          return;
        }

        // Normal conversational turn. (Strip any stray GENERATE_BPO marker just in case.)
        await sbTouch(chatId);
        await sendMessage(token, chatId, reply.replace(/^\s*GENERATE_BPO\s*/i, '').trim() || reply);
      } finally {
        stopTyping();
      }
      } finally {
        if (lockTaken) await sbReleaseLock(chatId); // release the per-chat turn lock (success, conversational, or error)
      }
    } catch (e) {
      try { await sendMessage(token, chatId, '⚠️ Something went wrong — please try again.'); } catch { /* ignore */ }
    } finally {
      stopTyping();        // covers early-return paths (guard/status/retry); inner finally covers the rest
      commitTiming(_tm);
    }
  })());
}
