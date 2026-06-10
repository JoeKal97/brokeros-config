// /api/telegram-webhook.js
// BrokerOS — Telegram bridge, INCREMENT 2 of 3: single-turn Managed Agent handoff.
//
// Text messages are no longer echoed — they are handed to the persisted BrokerOS Managed
// Agent and the agent's reply is sent back to the chat. NO multi-turn session state yet
// (Increment 3 = Supabase session mapping); for now EACH message is one independent,
// single-turn agent call (fresh session, ephemeral). Non-text messages keep their stubs.
//
// TIMEOUT HANDLING (the key design point):
//   Telegram expects a fast webhook response and retries the update on a slow/non-2xx
//   reply — which would cause duplicate agent runs and duplicate Telegram messages. An
//   agent call (provision cloud environment + session + poll to idle) is far too slow to
//   block on. So we:
//     1. Respond 200 to Telegram IMMEDIATELY (before the agent call).
//     2. Run the agent call in the background via Vercel `waitUntil`, then deliver the
//        agent's answer with a FOLLOW-UP sendMessage.
//   The webhook never blocks on the agent, so Telegram never retries and the user never
//   gets duplicates. The background work is bounded by the function maxDuration (below).
//
// LATENCY: the slow part is cloud-environment provisioning. We cache the environment id in
// module scope so warm function instances reuse it across messages (only cold starts pay
// the full provisioning cost); a stale/archived env is detected and recreated once.
//
// CONFIG (Vercel env, server-side only, never logged here):
//   TELEGRAM_BOT_TOKEN  — bot token for sendMessage
//   ANTHROPIC_API_KEY   — read by the Anthropic SDK (x-api-key) for the agent call
//   BROKEROS_AGENT_ID   — optional override of the persisted agent id

import Anthropic from '@anthropic-ai/sdk';
import { waitUntil } from '@vercel/functions';

// Background agent work needs room beyond the (immediate) webhook 200. 60s is safe on all
// Vercel plans; bump to 300 (Pro) if cold-start agent replies don't arrive in time.
export const config = { maxDuration: 60 };

const VERSION = '2026-06-10-tg-2';

// Persisted BrokerOS agent (governed by agents/brokeros-bpo-system-prompt.md, baked into
// the agent at create time). Overridable via env if the agent is rebuilt.
const AGENT_ID = process.env.BROKEROS_AGENT_ID || 'agent_01DDa6SH2GfP2AgdhpRmZgZg';

const TERMINAL = new Set(['session.status_idle', 'session.status_terminated', 'session.error']);
const TG_API = (token, method) => `https://api.telegram.org/bot${token}/${method}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- message-type routing (unchanged from Increment 1) ----
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

async function sendMessage(token, chatId, text) {
  // Telegram caps a message at 4096 chars; trim defensively.
  const body = { chat_id: chatId, text: String(text).slice(0, 4096) };
  const resp = await fetch(TG_API(token, 'sendMessage'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let info = null;
  try { info = await resp.json(); } catch { /* ignore */ }
  return { status: resp.status, ok: info ? info.ok : false, description: info ? info.description : null };
}

// Defensive: if the agent wraps its whole reply in a ```fence``` (e.g. PAYLOAD_READY JSON),
// unwrap it so the chat shows clean text rather than raw backticks. Plain prose passes through.
function unwrapFence(text) {
  const t = String(text || '').trim();
  const m = t.match(/^```(?:json|JSON)?\s*([\s\S]*?)\s*```$/);
  return m ? m[1].trim() : t;
}

// ---- single-turn Managed Agent call ----
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
let cachedEnvId = null; // reused across warm invocations

async function ensureEnv() {
  if (cachedEnvId) return cachedEnvId;
  const env = await anthropic.beta.environments.create({ name: 'bpo-tg-env', config: { type: 'cloud' } });
  cachedEnvId = env.id;
  return cachedEnvId;
}

async function createSessionWithEnv() {
  // Try the cached env; if it's stale/archived, recreate once.
  try {
    const envId = await ensureEnv();
    return await anthropic.beta.sessions.create({ agent: AGENT_ID, environment_id: envId });
  } catch (e) {
    cachedEnvId = null;
    const envId = await ensureEnv();
    return await anthropic.beta.sessions.create({ agent: AGENT_ID, environment_id: envId });
  }
}

async function runAgentSingleTurn(text, deadlineMs) {
  let session = null;
  try {
    session = await createSessionWithEnv();
    await anthropic.beta.sessions.events.send(session.id, {
      events: [{ type: 'user.message', content: [{ type: 'text', text }] }],
    });
    let reply = '';
    while (Date.now() < deadlineMs) {
      const evs = [];
      for await (const e of anthropic.beta.sessions.events.list(session.id, { order: 'asc' })) evs.push(e);
      if (evs.some((e) => TERMINAL.has(e.type))) {
        reply = evs
          .filter((e) => e.type === 'agent.message')
          .flatMap((e) => (e.content || []).map((b) => b.text || ''))
          .join('')
          .trim();
        break;
      }
      await sleep(2500);
    }
    return reply;
  } finally {
    // Session is ephemeral (single-turn). Keep the env cached for reuse; drop the session.
    try { if (session) await anthropic.beta.sessions.delete(session.id); } catch { /* ignore */ }
  }
}

export default async function handler(req, res) {
  if (req.method === 'GET' || (req.query && req.query.version !== undefined)) {
    return res.status(200).json({ version: VERSION, endpoint: 'telegram-webhook', increment: 2 });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = process.env.TELEGRAM_BOT_TOKEN;

  let update = req.body;
  if (typeof update === 'string') { try { update = JSON.parse(update); } catch { update = {}; } }
  update = update || {};

  const msg = update.message || update.edited_message || update.channel_post || null;
  const type = classify(msg);

  if (!msg || !msg.chat) {
    return res.status(200).json({ ok: true, version: VERSION, handled: 'no-message', type });
  }
  const chatId = msg.chat.id;

  if (!token) {
    return res.status(200).json({ ok: true, version: VERSION, type, sent: false, reason: 'TELEGRAM_BOT_TOKEN not set in Vercel env' });
  }

  // Non-text: fast stub reply (Increment 1 behavior), awaited (quick) then 200.
  if (type !== 'text') {
    let send = { ok: false };
    try { send = await sendMessage(token, chatId, `received a ${type} — not handled yet`); } catch { /* ignore */ }
    return res.status(200).json({ ok: true, version: VERSION, type, reply_sent: send.ok });
  }

  // TEXT: answer fast to Telegram, run the agent in the background, deliver as a follow-up.
  res.status(200).json({ ok: true, version: VERSION, type, mode: 'agent-async' });

  const incoming = msg.text;
  waitUntil((async () => {
    try {
      // Leave headroom under maxDuration (60s) for teardown + the follow-up sendMessage.
      const deadline = Date.now() + 50000;
      let reply = await runAgentSingleTurn(incoming, deadline);
      reply = unwrapFence(reply);
      if (!reply) reply = "Sorry — I couldn't get a reply from the agent in time. Please try again.";
      await sendMessage(token, chatId, reply);
    } catch (e) {
      try { await sendMessage(token, chatId, '⚠️ Agent error — please try again.'); } catch { /* ignore */ }
    }
  })());
}
