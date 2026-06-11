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

import Anthropic from '@anthropic-ai/sdk';
import { waitUntil } from '@vercel/functions';

// The generate turn (agent writes the full payload, then PDFShift renders 19 pages) is the
// heaviest (full payload + 19-page PDFShift render). 300s (Vercel Pro) gives the generate
// turn ample headroom so it never times out from the broker's view.
export const config = { maxDuration: 300 };

const VERSION = '2026-06-10-tg-6';

// A chat marked "generating" within this window blocks a second generation (double-gen
// guard). Beyond it the mark is treated as stale (a truly dead run) and generation may retry.
const GENERATING_TTL_MS = 240000;

// Rebuilt agent governed by base workflow + agents/telegram-delivery-contract.md.
const AGENT_ID = process.env.BROKEROS_AGENT_ID || 'agent_0158kmQA7nKFSB6xRdTSfJ2C';
const GENERATE_PDF_URL = 'https://brokeros-config.vercel.app/api/generate-pdf';

const TERMINAL = new Set(['session.status_idle', 'session.status_terminated', 'session.error']);
const TG_API = (token, m) => `https://api.telegram.org/bot${token}/${m}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const START_RE = /^\s*\/?(start|new)\b/i;          // "/start", "/new", "new bpo", "new ..."
const NEWBPO_RE = /\bnew\s*bpo\b/i;
const END_RE = /^\s*\/?(cancel|done|reset|stop)\b/i;
const RETRY_RE = /^\s*\/?(retry|resend|try\s*again|again|yes|yep|yeah|yup|ok(ay)?|sure|go|please)\b/i; // after a failed generation

// STATUS check-in ("you there?", "where's my PDF", "any update", "done yet?") -> answer with
// real status, not a generic ack.
const STATUS_RE = /\b(still (coming|building|there|working|waiting)|you (there|up|alive)|are you (there|alive|working)|where('?s| is)?\s+(my\s+|the\s+)?(pdf|bpo|report|doc(ument)?|it|that)|how('?s| is)\s+(it|that|this)\s+(going|coming|looking)|any\s+update|done\s+yet|ready\s+yet|finished\s+yet|did\s+(it|that|you)\s+(send|go|work|get)|hello\??|you\s+working)\b/i;

// Short confirmation/answer ("looks good", "go ahead", "correct", "all missoula") -> the agent
// reply lands fast; no separate "working on that" ack (typing carries it).
const CONFIRM_RE = /^\s*(looks?\s+good|that'?s?\s+(right|correct|it|good)|correct|confirm(ed)?|yes|yep|yeah|yup|ok(ay)?|sure|sounds?\s+good|perfect|great|all\s+good|that\s+works|works(\s+for\s+me)?|go\s+ahead|go|run\s+with\s+it|just\s+run.*|do\s+it|please\s+do|fine|good|right)\b/i;

// Varied "processing" acks for substantive DATA turns (rotated, no back-to-back repeat).
const DATA_ACKS = ['On it…', 'Got it, one sec…', 'Working on that…', 'Let me pull that together…', 'Got it — give me a moment…'];
let lastAckIdx = -1;
function pickAck() {
  let i = Math.floor(Math.random() * DATA_ACKS.length);
  if (DATA_ACKS.length > 1 && i === lastAckIdx) i = (i + 1) % DATA_ACKS.length;
  lastAckIdx = i;
  return DATA_ACKS[i];
}
// Classify the inbound text for ack purposes: 'status' | 'confirm' | 'data'.
function classifyAck(text) {
  const t = String(text || '').trim();
  if (STATUS_RE.test(t)) return 'status';
  const words = t.split(/\s+/).filter(Boolean).length;
  if (CONFIRM_RE.test(t) || (words <= 4 && t.length < 40)) return 'confirm';
  return 'data';
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
const sbClearState = (chatId) => sbPatch(chatId, { status: null, generating_since: null, last_payload: null });

function isGeneratingActive(row) {
  if (!row || row.status !== 'generating') return false;
  const since = row.generating_since ? Date.parse(row.generating_since) : 0;
  return Number.isFinite(since) && since > 0 && (Date.now() - since) < GENERATING_TTL_MS;
}

// Answer a STATUS check-in with the real state — never a generic ack. (Mid-generation is
// caught earlier by the guard; this covers failed / active-idle / no-session.)
async function answerStatus(token, chatId, row) {
  if (isGeneratingActive(row)) return sendMessage(token, chatId, 'Still building your BPO — about 30 seconds…');
  if (row && row.status === 'generate_failed') return sendMessage(token, chatId, "That last build didn’t go through — reply \"retry\" and I’ll finish it.");
  if (row && row.session_id) return sendMessage(token, chatId, "I’m here — still on your BPO. Send the next detail whenever you’re ready.");
  return sendMessage(token, chatId, "I’m here. Send \"new BPO\" to start one.");
}

// ---- Managed Agent session ----
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
let cachedEnvId = null; // one cloud env reused across sessions on a warm instance

async function ensureEnv() {
  if (cachedEnvId) return cachedEnvId;
  const env = await anthropic.beta.environments.create({ name: 'bpo-tg-env', config: { type: 'cloud' } });
  cachedEnvId = env.id;
  return cachedEnvId;
}
async function newSession() {
  let envId;
  try { envId = await ensureEnv(); return { ...(await anthropic.beta.sessions.create({ agent: AGENT_ID, environment_id: envId })), envId }; }
  catch (e) { cachedEnvId = null; envId = await ensureEnv(); return { ...(await anthropic.beta.sessions.create({ agent: AGENT_ID, environment_id: envId })), envId }; }
}
async function collectEvents(sessionId) {
  const evs = [];
  for await (const e of anthropic.beta.sessions.events.list(sessionId, { order: 'asc' })) evs.push(e);
  return evs;
}
// Send one user turn into an existing session; return only the NEW agent text for this turn.
async function sendTurn(sessionId, text, deadlineMs) {
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
async function runGeneration(token, chatId, payload) {
  await sbMarkGenerating(chatId, payload);                 // stash payload + block resends
  await sendMessage(token, chatId, 'Building your BPO now ⏳');
  const result = await generatePdf(payload);

  if (result.ok) {
    const addr = (payload.subject && payload.subject.address_line1) || 'BPO';
    const fname = `Eagen_BPO_${String(addr).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}.pdf`;
    if (await sendDocument(token, chatId, result.bytes, fname)) {  // attach FIRST
      await sendMessage(token, chatId, '✅ Your BPO is ready.');     // THEN confirm — only after a real send
      await sbDelete(chatId);                                       // success ends the session
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
  // Diagnostic: which agent does PROD actually resolve, and is it live? (agent_id/name are
  // not secrets.) Proves env-override vs bundled-default and that it isn't the archived agent.
  if (req.method === 'GET' && req.query && req.query.selftest === 'agent') {
    const out = { selftest: 'agent', agent_id: AGENT_ID, source: process.env.BROKEROS_AGENT_ID ? 'env:BROKEROS_AGENT_ID' : 'bundled-default' };
    try {
      const a = await anthropic.beta.agents.retrieve(AGENT_ID);
      out.name = a.name;
      out.archived = !!a.archived_at;
    } catch (e) {
      out.retrieve_error = String((e && e.message) || e);
    }
    return res.status(200).json(out);
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

  // Non-text: stub (this increment is text-only; xlsx/photo/voice are the NEXT build per N7).
  if (type !== 'text') {
    res.status(200).json({ ok: true, version: VERSION, type, mode: 'stub' });
    waitUntil((async () => { try { await sendMessage(token, chatId, `received a ${type} — not handled yet`); } catch { /* ignore */ } })());
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

  waitUntil((async () => {
    try {
      // Explicit END command.
      if (END_RE.test(incoming)) {
        await sbDelete(chatId);
        await sendMessage(token, chatId, "Session ended. Send 'new BPO' to start again.");
        return;
      }

      const wantStart = START_RE.test(incoming) || NEWBPO_RE.test(incoming);
      let row = await sbGet(chatId);

      // DOUBLE-GENERATION GUARD: if a PDF is already being built for this chat, don't start
      // a second generation (or even a second agent turn) — give real status.
      if (isGeneratingActive(row)) {
        await sendMessage(token, chatId, 'Still building your BPO — about 30 seconds…');
        return;
      }

      const ackKind = classifyAck(incoming);

      // STATUS check-in -> answer with real state, no agent turn, no generic ack.
      if (ackKind === 'status') {
        await answerStatus(token, chatId, row);
        return;
      }

      // RETRY after a failed generation: re-run the stashed payload directly (no agent round
      // trip, no reliance on the agent re-emitting). Any other message clears the failed state
      // and routes to the agent normally (so the broker can also correct data instead).
      if (row && row.status === 'generate_failed' && row.last_payload) {
        if (RETRY_RE.test(incoming)) {
          const stop = startTyping(token, chatId);
          try { await runGeneration(token, chatId, row.last_payload); } finally { stop(); }
          return;
        }
        await sbClearState(chatId); // not a retry -> fall through to a normal agent turn
        row = { ...row, status: null };
      }

      // Keep the typing indicator alive for the whole turn (primary "it's alive" signal).
      // Substantive DATA turns also get a short, VARIED text ack; short confirmations get
      // none (the agent reply lands fast — typing carries it).
      const stopTyping = startTyping(token, chatId);
      try {
        if (ackKind === 'data') await sendMessage(token, chatId, pickAck());
        let sessionId;
        if (wantStart || !row) {            // START: fresh session
          const s = await newSession();
          sessionId = s.id;
          await sbUpsert(chatId, sessionId, s.envId);
        } else {                            // REUSE: same stateful session = memory
          sessionId = row.session_id;
        }

        // Bare "/start" or "/new" -> kick the agent's intake; otherwise pass the text through.
        const toSend = /^\s*\/?(start|new)\s*$/i.test(incoming) ? 'Hi, I need to start a new BPO.' : incoming;

        const deadline = Date.now() + 200000; // generous; returns as soon as the agent is idle
        let reply;
        try {
          reply = await sendTurn(sessionId, toSend, deadline);
        } catch (e) {
          // Stored session/env was reclaimed — start a fresh session once and resend.
          const s = await newSession();
          sessionId = s.id;
          await sbUpsert(chatId, sessionId, s.envId);
          reply = await sendTurn(sessionId, toSend, deadline);
        }

        if (!reply) { await sendMessage(token, chatId, "Sorry — I couldn't get a reply in time. Please try again."); return; }

        // Generation signal? Hand the payload to the bridge — it owns building/sent/failed.
        const payload = extractGenerate(reply);
        if (payload) {
          await runGeneration(token, chatId, payload);
          return;
        }

        // Normal conversational turn. (Strip any stray GENERATE_BPO marker just in case.)
        await sbTouch(chatId);
        await sendMessage(token, chatId, reply.replace(/^\s*GENERATE_BPO\s*/i, '').trim() || reply);
      } finally {
        stopTyping();
      }
    } catch (e) {
      try { await sendMessage(token, chatId, '⚠️ Something went wrong — please try again.'); } catch { /* ignore */ }
    }
  })());
}
