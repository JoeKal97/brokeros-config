// /api/telegram-webhook.js
// BrokerOS — Telegram bridge, INCREMENT 1 of 3: bare echo bridge.
//
// Proves the loop: Telegram update -> Vercel webhook -> this code -> reply via Telegram.
// NO Managed Agent, NO session state yet (those are Increments 2 & 3). Just echo + the
// message-TYPE routing we provision from day one (L5 bridge spec): text is echoed,
// voice/document/photo/etc. get a "not handled yet" stub so the router exists up front.
//
// TRANSPORT: Telegram POSTs application/json. Vercel's Node runtime parses it into
// req.body automatically (we also defensively JSON.parse a string body). We always return
// 200 quickly — Telegram retries the update on any non-2xx.
//
// CONFIG: TELEGRAM_BOT_TOKEN must be set in the Vercel project env (server-side only;
// never shipped to the client, never logged here).
//
// setWebhook (re-run after a domain change; token redacted):
//   curl -s "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://brokeros-config.vercel.app/api/telegram-webhook"

const VERSION = '2026-06-10-tg-1';

const TG_API = (token, method) => `https://api.telegram.org/bot${token}/${method}`;

// Detect the inbound message type. Only 'text' is handled this increment; everything else
// is recognized and stubbed so the routing is real from day one (not text-only hardcoded).
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
  const resp = await fetch(TG_API(token, 'sendMessage'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  // Telegram returns {ok:true,...} or {ok:false,description}. Surface failures in the
  // function response body (NOT the token) for debugging via Vercel logs.
  let info = null;
  try { info = await resp.json(); } catch { /* ignore */ }
  return { status: resp.status, ok: info ? info.ok : false, description: info ? info.description : null };
}

export default async function handler(req, res) {
  // VERSION marker (same convention as generate-pdf / parse-rentroll).
  if (req.method === 'GET' || (req.query && req.query.version !== undefined)) {
    return res.status(200).json({ version: VERSION, endpoint: 'telegram-webhook', increment: 1 });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = process.env.TELEGRAM_BOT_TOKEN;

  // Parse the Telegram update defensively (object when Vercel parsed it; string otherwise).
  let update = req.body;
  if (typeof update === 'string') {
    try { update = JSON.parse(update); } catch { update = {}; }
  }
  update = update || {};

  // A Telegram update may carry the message under several keys; handle the common ones.
  const msg = update.message || update.edited_message || update.channel_post || null;
  const type = classify(msg);

  // No actionable message (e.g. my_chat_member, callback_query, etc.) — ack and move on.
  if (!msg || !msg.chat) {
    return res.status(200).json({ ok: true, version: VERSION, handled: 'no-message', type });
  }

  const chatId = msg.chat.id;
  const reply = type === 'text'
    ? `echo: ${msg.text}`
    : `received a ${type} — not handled yet`;

  // No token configured: still 200 so Telegram doesn't retry-storm; report config gap.
  if (!token) {
    return res.status(200).json({ ok: true, version: VERSION, type, sent: false, reason: 'TELEGRAM_BOT_TOKEN not set in Vercel env' });
  }

  let send = { status: 0, ok: false, description: 'send not attempted' };
  try {
    send = await sendMessage(token, chatId, reply);
  } catch (e) {
    send = { status: 0, ok: false, description: String(e && e.message || e) };
  }

  // Always 200 to Telegram (retries only on non-2xx); echo diagnostics in the body.
  return res.status(200).json({ ok: true, version: VERSION, type, reply_sent: send.ok, tg_status: send.status, tg_error: send.description });
}
