import 'dotenv/config';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import webpush from 'web-push';
import { initDatabase } from './db.js';
import { CITY_BY_SLUG, renderAustinIndex, renderCityPage, sitemapEntries } from './city-pages.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = Number(process.env.PORT || 3000);
const store = initDatabase(process.env.SQLITE_PATH || './data/callflow.db');

const vapidPublicKey = process.env.VAPID_PUBLIC_KEY || '';
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY || '';
const vapidSubject = process.env.VAPID_SUBJECT || 'mailto:hello@callflow.biz';
const pushEnabled = Boolean(vapidPublicKey && vapidPrivateKey);
if (pushEnabled) webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);

// ---------------------------------------------------------------------------
// Lightweight shop authentication (scrypt + opaque DB-backed session cookie)
// ---------------------------------------------------------------------------
const SESSION_COOKIE = 'cf_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const demoLoginEnabled = String(process.env.DEMO_LOGIN_ENABLED ?? (process.env.NODE_ENV === 'production' ? 'false' : 'true')).toLowerCase() !== 'false';
const DEMO_LOGIN_EMAIL = String(process.env.DEMO_LOGIN_EMAIL || 'demo@callflow.biz').trim().toLowerCase();
const DEMO_LOGIN_PASSWORD = String(process.env.DEMO_LOGIN_PASSWORD || 'CallFlowDemo!');
const cookieSecure = String(process.env.COOKIE_SECURE || '').toLowerCase() === 'true' || process.env.NODE_ENV === 'production';
const PUBLIC_API_PATHS = new Set([
  '/api/health',
  '/api/auth/config',
  '/api/auth/me',
  '/api/auth/login',
  '/api/auth/signup',
  '/api/auth/demo',
  '/api/auth/logout',
  '/api/contact',
]);

function parseCookies(header) {
  const cookies = {};
  String(header || '').split(';').forEach((part) => {
    const index = part.indexOf('=');
    if (index <= 0) return;
    const key = part.slice(0, index).trim();
    if (!key) return;
    try { cookies[key] = decodeURIComponent(part.slice(index + 1).trim()); } catch { cookies[key] = part.slice(index + 1).trim(); }
  });
  return cookies;
}

function sessionCookie(token) {
  const parts = [`${SESSION_COOKIE}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`];
  if (cookieSecure) parts.push('Secure');
  return parts.join('; ');
}

function clearSessionCookie(res) {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (cookieSecure) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

// ---------------------------------------------------------------------------
// Super-admin session (platform owner supervision at /admin)
//
// Credentials come from .env (ADMIN_EMAIL / ADMIN_PASSWORD) with local defaults
// so the dashboard works out of the box. Sessions are opaque tokens persisted
// in SQLite and delivered in an HttpOnly cookie, separate from shop sessions.
// ---------------------------------------------------------------------------
const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || 'admin@callflow.biz').trim().toLowerCase();
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || 'CallFlowAdmin!2025');
const ADMIN_SESSION_COOKIE = 'cf_admin';
const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function adminSessionCookie(token) {
  const parts = [`${ADMIN_SESSION_COOKIE}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(ADMIN_SESSION_TTL_MS / 1000)}`];
  if (cookieSecure) parts.push('Secure');
  return parts.join('; ');
}

function clearAdminSessionCookie(res) {
  const parts = [`${ADMIN_SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (cookieSecure) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

function adminSessionForRequest(req) {
  const token = parseCookies(req.headers.cookie)[ADMIN_SESSION_COOKIE];
  if (!token) return null;
  const session = store.getAdminSession(token);
  return session ? { token, session } : null;
}

function isAdminRequest(req) {
  return Boolean(adminSessionForRequest(req));
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { hash: crypto.scryptSync(String(password), salt, 64).toString('hex'), salt };
}

function verifyPassword(password, expectedHash, salt) {
  try {
    const candidate = crypto.scryptSync(String(password), String(salt), 64);
    const expected = Buffer.from(String(expectedHash), 'hex');
    return expected.length === candidate.length && crypto.timingSafeEqual(expected, candidate);
  } catch {
    return false;
  }
}

function startSession(res, user) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  store.createSession({ userId: user.id, plumberId: user.plumber_id, token, expiresAt });
  store.setUserLastLogin(user.id);
  res.append('Set-Cookie', sessionCookie(token));
  return token;
}

function sessionForRequest(req) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token) return null;
  const session = store.getSessionUser(token);
  if (!session) return null;
  const plumber = store.getPlumberById(session.plumber_id);
  if (!plumber) return null;
  return { token, session, plumber };
}

function authMiddleware(req, _res, next) {
  const auth = sessionForRequest(req);
  if (auth) {
    req.sessionToken = auth.token;
    req.auth = auth.session;
    req.plumber = auth.plumber;
  }
  next();
}

function apiAuthGuard(req, res, next) {
  if (!req.path.startsWith('/api')) return next();
  // Super-admin routes authenticate separately (see adminApiGuard below).
  if (req.path === '/api/admin' || req.path.startsWith('/api/admin/')) return next();
  if (PUBLIC_API_PATHS.has(req.path)) return next();
  if (!req.auth || !req.plumber) {
    return res.status(401).json({ ok: false, error: 'auth_required', login: '/?login=1' });
  }
  return next();
}

function publicPlumber(plumber) {
  if (!plumber) return null;
  const plan = store.planSnapshot(plumber);
  return {
    id: plumber.id,
    business_name: plumber.business_name,
    owner_name: plumber.owner_name,
    email: plumber.email,
    owner_phone: plumber.owner_phone,
    established_line: plumber.established_line,
    telnyx_number: plumber.telnyx_number,
    avg_ticket_usd: plumber.avg_ticket_usd,
    service_area_note: plumber.service_area_note,
    subscription_status: plan.subscription_status,
    plan_code: plumber.plan_code,
    plan_type: plan.plan_type,
    is_enabled: plan.is_enabled ? 1 : 0,
    trial_ends_at: plan.trial_ends_at,
    trial_days_left: plan.trial_days_left,
    trial_expired: plan.trial_expired,
    daily_lead_limit: plan.daily_lead_limit,
    included_minutes: plan.minutes_included,
    used_minutes: plan.minutes_used,
    remaining_minutes: plan.minutes_left,
  };
}

function escapeHtml(value) {
  return String(value === undefined || value === null ? '' : value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

// Navy/gold notice shown at /app while the platform owner has the account
// disabled from the supervision dashboard.
function disabledBusinessPage(plumber) {
  const name = escapeHtml((plumber && plumber.business_name) || 'This business');
  const email = escapeHtml((plumber && plumber.email) || '');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="theme-color" content="#0D1B2A" />
<title>CallFlow · Account paused</title>
<style>
  :root { --navy:#0D1B2A; --navy-2:#122235; --gold:#E2A93B; --gold-2:#F3C96B; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px;
    background: radial-gradient(720px 420px at 12% -10%, rgba(226,169,59,.16), transparent 70%), var(--navy);
    color:#E8EEF6; font-family: ui-sans-serif, -apple-system, "Segoe UI", Inter, Roboto, Arial, sans-serif; }
  .card { width:min(520px,100%); background:var(--navy-2); border:1px solid rgba(226,169,59,.45);
    border-radius:20px; padding:28px; box-shadow:0 30px 80px -34px rgba(0,0,0,.9); }
  .badge { display:inline-flex; align-items:center; gap:8px; font-size:10px; letter-spacing:.14em;
    text-transform:uppercase; font-weight:900; color:var(--gold); border:1px solid rgba(226,169,59,.5);
    border-radius:999px; padding:5px 11px; }
  h1 { font-size:23px; margin:16px 0 6px; letter-spacing:-.02em; }
  p { color:#CBD5E1; font-size:13.5px; line-height:1.6; margin:0 0 10px; }
  .name { color:var(--gold-2); font-weight:800; }
  .actions { display:flex; flex-wrap:wrap; gap:10px; margin-top:20px; }
  a.btn, button.btn { appearance:none; border-radius:10px; padding:10px 16px; font:inherit; font-size:12px;
    font-weight:800; cursor:pointer; text-decoration:none; display:inline-block; border:1px solid transparent; }
  .primary { background:var(--gold); color:var(--navy); }
  .ghost { background:transparent; color:var(--gold); border-color:rgba(226,169,59,.55); }
  .tiny { font-size:11px; color:#94A3B8; margin-top:16px; }
</style>
</head>
<body>
  <main class="card">
    <span class="badge">Account paused</span>
    <h1><span class="name">${name}</span> is currently disabled.</h1>
    <p>Your CallFlow workspace and AI call capture are paused by the platform owner. New missed calls are not being captured or billed while the account is disabled.</p>
    <p>Need this re-enabled? Contact <a href="mailto:hello@callflow.biz" style="color:var(--gold-2);font-weight:800">hello@callflow.biz</a>${email ? ` from <span class="name">${email}</span>` : ''} and we will restore access.</p>
    <div class="actions">
      <button class="btn primary" id="logoutBtn" type="button">Log out</button>
      <a class="btn ghost" href="/">Back to callflow.biz</a>
    </div>
    <p class="tiny">Existing leads and call logs are kept safe in your SQLite database.</p>
  </main>
  <script>
    document.getElementById('logoutBtn').addEventListener('click', async () => {
      try { await fetch('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch (_) {}
      window.location.assign('/?login=1');
    });
  </script>
</body>
</html>`;
}

function ensureDemoShopUser() {
  if (!demoLoginEnabled) return;
  const plumber = store.getDefaultPlumber();
  if (!plumber) return;
  const existing = store.getUserByEmail(DEMO_LOGIN_EMAIL);
  if (existing) return;
  const { hash, salt } = hashPassword(DEMO_LOGIN_PASSWORD);
  try {
    store.createShopUser({ plumberId: plumber.id, email: DEMO_LOGIN_EMAIL, passwordHash: hash, passwordSalt: salt });
    console.log(`[auth] demo shop login ready for ${DEMO_LOGIN_EMAIL}`);
  } catch (err) {
    console.warn(`[auth] could not seed demo login: ${err?.message || err}`);
  }
}

ensureDemoShopUser();
store.deleteExpiredSessions();
if (ADMIN_EMAIL && ADMIN_PASSWORD) {
  console.log(`[admin] supervision dashboard at /admin · login ${ADMIN_EMAIL}`);
}


app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); req.rawBodyBuffer = Buffer.from(buf); } }));
app.use(authMiddleware);
app.use(apiAuthGuard);

// Admin session guard: everything under /api/admin except login/session/logout
// requires a valid `cf_admin` cookie.
const ADMIN_PUBLIC_PATHS = new Set(['/login', '/session', '/logout']);
app.use('/api/admin', (req, res, next) => {
  if (ADMIN_PUBLIC_PATHS.has(req.path)) return next();
  if (!isAdminRequest(req)) {
    return res.status(401).json({ ok: false, error: 'admin_auth_required', login: '/admin' });
  }
  return next();
});

// Public marketing at `/`; authenticated workspace at `/app`.
app.get(['/app', '/app.html'], (req, res) => {
  if (!req.auth || !req.plumber) return res.redirect('/?login=1');
  res.set('Cache-Control', 'no-store');
  // Disabled businesses (admin supervision toggle) never reach the workspace.
  if (Number(req.plumber.is_enabled) === 0) return res.status(403).send(disabledBusinessPage(req.plumber));
  return res.sendFile(path.join(__dirname, 'public', 'app.html'));
});
app.get('/login', (_req, res) => res.redirect('/?login=1'));
app.get('/signup', (_req, res) => res.redirect('/?trial=1'));

// Super-admin dashboard: server-side gate. Unauthenticated visitors only ever
// receive the login form; the supervision UI is sent after a valid session.
app.get(['/admin', '/admin.html'], (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.set('X-Frame-Options', 'DENY');
  if (!isAdminRequest(req)) return res.sendFile(path.join(__dirname, 'public', 'admin-login.html'));
  return res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Public legal / support pages: static HTML, no session required.
const PUBLIC_PAGES = {
  '/privacy-policy': 'privacy-policy.html',
  '/refund-and-cancellation': 'refund-and-cancellation.html',
  '/contact': 'contact.html',
};
for (const [route, file] of Object.entries(PUBLIC_PAGES)) {
  app.get([route, `${route}.html`], (_req, res) => res.sendFile(path.join(__dirname, 'public', file)));
}

app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// /austin/<city> SEO landing pages (+ /austin hub, sitemap, robots)
//
// Rendered on the server from city-pages.js: no client JS, full HTML in the
// first response, and a canonical URL per city for search engines.
// ---------------------------------------------------------------------------
const PUBLIC_SITE_URL = String(process.env.PUBLIC_SITE_URL || 'https://callflow.biz').replace(/\/+$/, '');

app.get('/austin', (_req, res) => {
  // HTML must revalidate on every load (ETag still makes it a cheap 304), so a
  // deploy is never hidden behind a stale browser copy for up to an hour.
  res.set('Cache-Control', 'no-cache');
  res.type('html').send(renderAustinIndex());
});

app.get('/austin/:city', (req, res, next) => {
  const slug = String(req.params.city || '').trim().toLowerCase();
  const page = CITY_BY_SLUG.get(slug);
  if (!page) return next(); // unknown city -> normal 404 handling
  res.set('Cache-Control', 'no-cache');
  res.type('html').send(renderCityPage(page));
});

app.get('/sitemap.xml', (_req, res) => {
  const urls = sitemapEntries()
    .map((route) => `  <url><loc>${PUBLIC_SITE_URL}${route}</loc></url>`)
    .join('\n');
  res.type('application/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`
  );
});

app.get('/robots.txt', (_req, res) => {
  res.type('text/plain').send(
    `User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api\nDisallow: /app\n\nSitemap: ${PUBLIC_SITE_URL}/sitemap.xml\n`
  );
});
// ---------------------------------------------------------------------------
// Webhook observability + Dograh payload normalisation
//
// Dograh delivers results with the shared secret in the `X-Webhook-Secret`
// header (older setups used `X-Dograh-Secret` / `Authorization: Bearer`), and
// it may nest the useful fields inside `data` / `call` / `payload` objects or
// inside JSON-encoded strings such as `gathered` / `initial_context`.
// Forwarded calls put the agent line in `to_number` and the real Telnyx DID in
// `forwarded_from`, so both are carried through to tenant resolution.
// Everything below normalises those shapes and makes every attempt visible in
// the server log so a rejected/missed call can never fail silently again.
// ---------------------------------------------------------------------------
const DOGRAH_SECRET_HEADERS = ['x-dograh-secret', 'x-webhook-secret', 'x-dograh-webhook-secret', 'x-api-key'];

const DOGRAH_FIELDS = {
  telnyxNumber: ['telnyx_number', 'to_number', 'to', 'callee', 'called_number', 'called', 'destination_number', 'dialed_number', 'business_number', 'inbound_number', 'system_number'],
  callerPhone: ['caller_phone', 'from_number', 'from', 'caller', 'caller_number', 'from_e164', 'caller_e164', 'customer_phone', 'contact_phone', 'caller_id', 'callerId'],
  callerName: ['caller_name', 'customer_name', 'contact_name', 'caller_full_name', 'from_name', 'name'],
  // The real Telnyx DID when the call was forwarded on to the AI agent line:
  // Dograh reports the agent line as `to_number`, the dialled number here.
  forwardedFrom: ['forwarded_from', 'forwardedFrom', 'diverted_from', 'divertedFrom', 'forwarded_number', 'forward_from', 'original_to_number', 'original_called_number', 'dialed_to_number'],
  // Explicit tenant hint (payload top level or nested `metadata`).
  businessId: ['business_id', 'businessId', 'plumber_id', 'plumberId', 'tenant_id', 'account_id'],
  urgency: ['urgency', 'priority', 'urgency_level', 'severity', 'is_emergency', 'emergency'],
  zipCode: ['zip_code', 'zip', 'postal_code', 'postcode', 'zipcode', 'service_zip'],
  streetAddress: ['street_address', 'service_address', 'address', 'street'],
  issueSummary: ['issue_summary', 'summary', 'issue', 'problem', 'reason', 'description', 'call_summary', 'ai_summary', 'issue_description', 'problem_description', 'notes'],
  durationSeconds: ['duration_seconds', 'duration', 'call_duration', 'call_duration_seconds', 'duration_sec', 'length_seconds', 'talk_time'],
  // When the call started, so the call log shows call time rather than webhook
  // receipt time (falls back to leads.created_at when absent).
  startedAt: ['started_at', 'call_started_at', 'call_start_time', 'startedAt', 'callStartTime', 'start_time', 'initiated_at', 'call_started_timestamp'],
  transcript: ['transcript', 'transcription', 'call_transcript', 'transcript_text', 'conversation_transcript', 'dialogue', 'full_transcript'],
  eventId: ['event_id', 'call_id', 'callId', 'callID', 'conversation_id', 'webhook_id', 'run_id', 'workflow_run_id', 'id'],
  eventType: ['event_type', 'eventType', 'type', 'call_status', 'status'],
};

function logWebhook(entry) {
  console.log(`[webhook] ${new Date().toISOString()} ${JSON.stringify(entry)}`);
}

// Breadth-first walk over the payload, following nested objects/arrays and
// JSON-encoded strings, so field lookup works at top level or nested anywhere.
// Breadth-first walk over the payload, following nested objects and
// JSON-encoded strings (`gathered`, `initial_context`, ...), so field lookup
// works whether Dograh sends data at the top level or nested inside
// `data` / `call` / `payload`. Array elements are only followed near the root:
// deeper arrays are diagnostic lists (answer_supervisor, agent_visits, ...)
// whose `reason` values would otherwise be mistaken for business fields.
function collectWebhookContainers(root, maxDepth = 6) {
  const containers = [];
  const seen = new WeakSet();
  const queue = [{ value: root, depth: 0 }];
  while (queue.length) {
    const { value, depth } = queue.shift();
    if (!value || typeof value !== 'object' || depth > maxDepth || seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) {
      if (depth > 1) continue;
      for (const item of value.slice(0, 10)) queue.push({ value: item, depth: depth + 1 });
      continue;
    }
    containers.push({ value, depth });
    for (const nested of Object.values(value)) {
      if (nested && typeof nested === 'object') queue.push({ value: nested, depth: depth + 1 });
      else if (typeof nested === 'string' && /^\s*[[{]/.test(nested)) {
        try { queue.push({ value: JSON.parse(nested), depth: depth + 1 }); } catch { /* plain text, ignore */ }
      }
    }
  }
  return containers;
}

// Key names win over container depth: a nested `caller_phone` beats a top-level `name`.
function pickWebhookField(containers, keys) {
  for (const key of keys) {
    for (const { value: container } of containers) {
      const value = container[key];
      if (value === undefined || value === null) continue;
      if (typeof value === 'string') { if (value.trim()) return value.trim(); continue; }
      if (typeof value === 'number' || typeof value === 'boolean') return value;
      if (typeof value === 'object' && !Array.isArray(value)) {
        for (const nestedKey of ['number', 'phone', 'phone_number', 'e164', 'value', 'text']) {
          const nested = value[nestedKey];
          if (typeof nested === 'string' && nested.trim()) return nested.trim();
        }
      }
    }
  }
  return undefined;
}

// Talk time arrives in several shapes depending on the provider/node:
// integer seconds, numeric strings, "1:24", "84s", "1m 24s" or ISO-8601
// "PT1M24S". Normalise everything to whole seconds; undefined = not sent.
function normalizeDurationSeconds(raw) {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'number') return Number.isFinite(raw) ? Math.max(0, Math.round(raw)) : undefined;
  const text = String(raw).trim();
  if (!text) return undefined;
  if (/^\d+(\.\d+)?$/.test(text)) return Math.max(0, Math.round(Number(text)));

  const iso = text.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i);
  if (iso && (iso[1] || iso[2] || iso[3] || iso[4])) {
    return Math.round(Number(iso[1] || 0) * 86400 + Number(iso[2] || 0) * 3600 + Number(iso[3] || 0) * 60 + Number(iso[4] || 0));
  }
  const clock = text.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
  if (clock) {
    return clock[3] !== undefined
      ? Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3])
      : Number(clock[1]) * 60 + Number(clock[2]);
  }
  const units = text.match(/^\s*(?:(\d+(?:\.\d+)?)\s*h(?:ours?)?)?\s*(?:(\d+(?:\.\d+)?)\s*m(?:in(?:ute)?s?)?)?\s*(?:(\d+(?:\.\d+)?)\s*s(?:ec(?:ond)?s?)?)?\s*$/i);
  if (units && (units[1] || units[2] || units[3])) {
    return Math.round(Number(units[1] || 0) * 3600 + Number(units[2] || 0) * 60 + Number(units[3] || 0));
  }
  const fallback = Number.parseFloat(text);
  return Number.isFinite(fallback) ? Math.max(0, Math.round(fallback)) : undefined;
}

function normalizeUrgencyValue(raw) {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'boolean') return raw ? 'emergency' : 'standard';
  const value = String(raw).trim().toLowerCase();
  if (!value) return undefined;
  if (['emergency', 'urgent', 'critical', 'high', 'asap', 'immediate', 'true', '1', 'yes'].includes(value)) return 'emergency';
  if (['standard', 'normal', 'routine', 'flexible', 'low', 'medium', 'false', '0', 'no', 'non-emergency', 'non_emergency'].includes(value)) return 'standard';
  return 'unknown';
}

// Telnyx can report `restricted@<ip>` / `anonymous` for withheld caller IDs.
function isRestrictedCaller(raw) {
  if (raw === undefined || raw === null) return true;
  const value = String(raw).trim();
  if (!value || value.includes('@') || !/\d/.test(value)) return true;
  return /restricted|anonymous|unknown|private|blocked|unavailable|withheld/i.test(value);
}

function secretsMatch(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(String(provided).trim());
  const b = Buffer.from(String(expected).trim());
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Dodo Payments billing helpers
//
// Dodo (like Svix) follows the Standard Webhooks spec: a `v1,<base64>`
// signature computed over `<webhook-id>.<webhook-timestamp>.<body>`. Some
// integrations instead post `x-dodo-signature` / `x-webhook-signature` with a
// hex or base64 HMAC of the raw body, and plain (non `whsec_`) secrets are
// common, so every combination is accepted and compared in constant time.
// ---------------------------------------------------------------------------
const DODO_SIGNATURE_HEADERS = ['webhook-signature', 'x-dodo-signature', 'x-webhook-signature'];
const DODO_SUBSCRIPTION_STATUSES = ['trialing', 'active', 'on_hold', 'past_due', 'cancelled', 'expired'];
const DODO_STATUS_BY_EVENT = {
  'subscription.active': 'active',
  'subscription.renewed': 'active',
  'subscription.trialing': 'trialing',
  'subscription.on_hold': 'on_hold',
  'subscription.past_due': 'past_due',
  'subscription.cancelled': 'cancelled',
  'subscription.expired': 'expired',
  'subscription.updated': null,
};
const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

function buffersMatch(a, b) {
  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b) || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// The secret may be `whsec_<base64>`, a bare base64 string, hex, or plain text.
function dodoSecretCandidates(secret) {
  const raw = String(secret || '').trim();
  if (!raw) return [];
  const candidates = [];
  const stripped = raw.replace(/^whsec_/i, '');
  const addBase64 = (value, label) => {
    if (!value || value.length < 16) return;
    const normalized = value.replace(/=+$/, '');
    if (!/^[A-Za-z0-9+/_-]+$/.test(normalized)) return;
    const decoded = Buffer.from(normalized, 'base64');
    if (!decoded.length) return;
    const reencoded = decoded.toString('base64').replace(/=+$/, '');
    if (reencoded !== normalized.replace(/-/g, '+').replace(/_/g, '/')) return;
    candidates.push({ label, key: decoded });
  };
  if (/^whsec_/i.test(raw)) addBase64(stripped, 'whsec_decoded');
  addBase64(stripped, 'secret_base64_bytes');
  candidates.push({ label: 'secret_utf8', key: Buffer.from(raw, 'utf8') });
  if (stripped !== raw) candidates.push({ label: 'secret_utf8_no_prefix', key: Buffer.from(stripped, 'utf8') });
  return candidates;
}

function parseDodoSignatures(headerValue) {
  return String(headerValue || '')
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter((part) => part && !/^v\d+[a-z]?$/i.test(part));
}

function dodoSignedPayloads(req, bodyBuffer) {
  const webhookId = req.get('webhook-id');
  const timestamp = req.get('webhook-timestamp');
  const payloads = [];
  if (webhookId && timestamp) {
    payloads.push({
      label: 'id.timestamp.body',
      standard: true,
      value: Buffer.concat([Buffer.from(`${webhookId}.${timestamp}.`, 'utf8'), bodyBuffer]),
    });
  }
  payloads.push({ label: 'body', standard: false, value: bodyBuffer });
  if (timestamp) {
    payloads.push({ label: 'timestamp.body', standard: false, value: Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), bodyBuffer]) });
  }
  return payloads;
}

function verifyDodoSignature(req, bodyBuffer, secret) {
  if (!String(secret || '').trim()) return { ok: true, skipped: true, reason: 'webhook_secret_not_configured' };
  const signatureHeader = DODO_SIGNATURE_HEADERS.find((header) => String(req.get(header) || '').trim());
  if (!signatureHeader) return { ok: false, reason: 'signature_missing' };
  const provided = parseDodoSignatures(req.get(signatureHeader));
  if (!provided.length) return { ok: false, reason: 'signature_malformed', signatureHeader };
  const keys = dodoSecretCandidates(secret);
  for (const payload of dodoSignedPayloads(req, bodyBuffer)) {
    for (const candidate of keys) {
      const digest = crypto.createHmac('sha256', candidate.key).update(payload.value).digest();
      const expected = [digest.toString('base64'), digest.toString('hex')].map((value) => Buffer.from(value, 'utf8'));
      if (provided.some((signature) => expected.some((value) => buffersMatch(Buffer.from(signature, 'utf8'), value)))) {
        if (payload.standard) {
          const timestamp = Number(req.get('webhook-timestamp'));
          const skew = Math.abs(Math.floor(Date.now() / 1000) - timestamp);
          if (!Number.isFinite(timestamp) || skew > WEBHOOK_TOLERANCE_SECONDS) {
            return { ok: false, reason: 'timestamp_out_of_tolerance', signatureHeader };
          }
        }
        return { ok: true, scheme: `${payload.label}/${candidate.label}`, signatureHeader };
      }
    }
  }
  return { ok: false, reason: 'signature_mismatch', signatureHeader };
}

function dodoMode() {
  const explicit = String(process.env.DODO_ENVIRONMENT || '').trim().toLowerCase();
  if (explicit) return ['live', 'production', 'live_mode'].includes(explicit) ? 'live' : 'test';
  return String(process.env.DODO_API_BASE_URL || '').toLowerCase().includes('live.') ? 'live' : 'test';
}

function dodoApiBaseUrl() {
  const explicit = String(process.env.DODO_API_BASE_URL || '').trim().replace(/\/+$/, '');
  if (explicit) return explicit;
  return dodoMode() === 'live' ? 'https://live.dodopayments.com' : 'https://test.dodopayments.com';
}

function trimBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function isLocalBaseUrl(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return ['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'].includes(host);
  } catch {
    return false;
  }
}

// Resolve the active browser origin from Origin / Host / reverse-proxy headers.
function requestOrigin(req) {
  if (!req || !req.headers) return '';
  const originHeader = String(req.headers.origin || '').trim();
  if (originHeader) {
    try {
      const parsed = new URL(originHeader);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.origin;
    } catch { /* fall through to Host */ }
  }

  let host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  if (!host) return '';
  host = host.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  if (!/^[a-zA-Z0-9.\-:[\] ]+$/.test(host) || /[\r\n]/.test(host)) return '';

  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  const protocol = forwardedProto === 'https' || req.secure ? 'https' : 'http';
  try {
    return new URL(`${protocol}://${host}`).origin;
  } catch {
    return '';
  }
}

// Precedence: explicit PUBLIC_URL (live webhooks/checkout) -> explicit non-local
// APP_BASE_URL/APP_URL -> the incoming request origin -> localhost fallback.
function appBaseUrl(req) {
  const publicUrl = trimBaseUrl(process.env.PUBLIC_URL);
  if (publicUrl) return publicUrl;

  const configured = trimBaseUrl(process.env.APP_BASE_URL || process.env.APP_URL);
  if (configured && !isLocalBaseUrl(configured)) return configured;

  return requestOrigin(req) || configured || `http://localhost:${port}`;
}

function billingConfig(req) {
  const missing = ['DODO_API_KEY', 'DODO_PLAN_SOLO_ID'].filter((key) => !String(process.env[key] || '').trim());
  return {
    configured: missing.length === 0,
    missing,
    dodoApiKey: Boolean(String(process.env.DODO_API_KEY || '').trim()),
    dodoPlanSoloId: Boolean(String(process.env.DODO_PLAN_SOLO_ID || '').trim()),
    dodoWebhookSecret: Boolean(String(process.env.DODO_WEBHOOK_SECRET || '').trim()),
    dodoCustomerEmail: isValidEmail(process.env.DODO_CUSTOMER_EMAIL),
    checkoutCurrency: checkoutCurrency(),
    billingAddress: billingAddress(),
    appBaseUrl: appBaseUrl(req),
    mode: dodoMode(),
  };
}

const FALLBACK_CUSTOMER_EMAIL = 'billing@callflow.biz';

// Dodo's Adaptive Currency otherwise bills in the buyer's local currency.
function checkoutCurrency() {
  const configured = String(process.env.DODO_CHECKOUT_CURRENCY || '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(configured) ? configured : 'USD';
}

// Without a billing address Dodo geolocates the buyer, so the checkout country
// can default to the visitor's IP country. Pin US/Austin; env overridable.
function billingAddress() {
  const country = String(process.env.DODO_BILLING_COUNTRY || 'US').trim().toUpperCase();
  const city = String(process.env.DODO_BILLING_CITY || 'Austin').trim();
  const state = String(process.env.DODO_BILLING_STATE || 'TX').trim().toUpperCase();
  const zipcode = String(process.env.DODO_BILLING_ZIPCODE || '78701').trim();
  const address = {
    country: /^[A-Z]{2}$/.test(country) ? country : 'US',
    city: city || 'Austin',
    state: state || 'TX',
    zipcode: zipcode || '78701',
  };
  const street = String(process.env.DODO_BILLING_STREET || '').trim();
  if (street) address.street = street;
  return address;
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

// Dodo rejects a partial `customer` object (422 INVALID_REQUEST_BODY), so an
// email is always resolved: plumber record -> DODO_CUSTOMER_EMAIL -> fallback.
// Dodo reuses the most recent customer for an email unless this is true, which
// silently keeps an old (or nameless) customer record and hides the real name.
function createNewCustomerFlag() {
  const raw = String(process.env.DODO_CREATE_NEW_CUSTOMER || '').trim().toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(raw);
}

function buildCustomerPrefill(plumber) {
  const fromPlumber = String((plumber && plumber.email) || '').trim().toLowerCase();
  const fromEnv = String(process.env.DODO_CUSTOMER_EMAIL || '').trim().toLowerCase();
  const email = isValidEmail(fromPlumber) ? fromPlumber : isValidEmail(fromEnv) ? fromEnv : FALLBACK_CUSTOMER_EMAIL;
  const emailSource = isValidEmail(fromPlumber) ? 'plumber.email' : isValidEmail(fromEnv) ? 'DODO_CUSTOMER_EMAIL' : 'fallback';
  const ownerName = String((plumber && plumber.owner_name) || '').trim();
  const businessName = String((plumber && plumber.business_name) || '').trim();
  const name = (ownerName || businessName || 'Austin Plumber').slice(0, 120);
  const nameSource = ownerName ? 'owner_name' : businessName ? 'business_name' : 'fallback';
  const phone = plumber && isE164(plumber.owner_phone) ? String(plumber.owner_phone).trim() : null;
  // Dodo requires a non-empty customer.name; create_new_customer keeps it from
  // being masked by a previously stored customer for the same email.
  const customer = { email, name, create_new_customer: createNewCustomerFlag() };
  if (phone) customer.phone_number = phone;
  return { customer, emailSource, nameSource, ownerName, businessName };
}

function isE164(value) {
  return /^\+[1-9]\d{7,14}$/.test(String(value || '').trim());
}

// Dodo reuses the most recent customer for an email (create_new_customer only
// takes effect at payment time), so an old/company name can stick around. This
// corrects the stored customer record so the name matches the plumber.
async function syncDodoCustomerRecord({ email, name, phoneNumber }) {
  const headers = {
    Authorization: 'Bearer ' + String(process.env.DODO_API_KEY || '').trim(),
    'Content-Type': 'application/json',
  };
  try {
    const lookup = await fetch(dodoApiBaseUrl() + '/customers?email=' + encodeURIComponent(email), { headers, signal: AbortSignal.timeout(8000) });
    if (!lookup.ok) return { synced: false, reason: 'lookup_failed', status: lookup.status };
    const payload = await lookup.json().catch(() => null);
    const list = Array.isArray(payload) ? payload : ((payload && (payload.items || payload.data)) || []);
    if (!list.length) return { synced: false, reason: 'customer_not_created_yet' };
    const newest = list.slice().sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))[0];
    const customerId = newest.customer_id || newest.id;
    const needsName = String(newest.name || '') !== name;
    const needsPhone = Boolean(phoneNumber) && String(newest.phone_number || '') !== phoneNumber;
    if (!customerId || (!needsName && !needsPhone)) return { synced: false, reason: 'already_current', customerId };
    const changes = {};
    if (needsName) changes.name = name;
    if (needsPhone) changes.phone_number = phoneNumber;
    const res = await fetch(dodoApiBaseUrl() + '/customers/' + encodeURIComponent(customerId), {
      method: 'PATCH',
      headers,
      body: JSON.stringify(changes),
      signal: AbortSignal.timeout(8000),
    });
    return { synced: res.ok, customerId, status: res.status, updated: Object.keys(changes) };
  } catch (err) {
    return { synced: false, reason: 'sync_error', error: (err && err.message) || String(err) };
  }
}

// Persist rejected attempts too (prefixed ids keep them out of event dedupe).
function recordRejectedWebhook(reason, req, source = 'dograh') {
  const deliveryHeader = source === 'dodo'
    ? req.get('webhook-id') || req.get('webhook-timestamp')
    : req.get('x-dograh-delivery-id') || req.get('x-dograh-workflow-run-id');
  const deliveryId = deliveryHeader;
  const externalEventId = `rejected:${deliveryId || crypto.randomUUID()}`;
  try {
    const inserted = store.recordWebhookEventOnce({
      source,
      externalEventId,
      eventType: `rejected.${reason}`,
      payload: { reason, deliveryId, userAgent: req.get('user-agent'), path: req.originalUrl, body: req.body || {} },
    });
    if (inserted) store.markWebhookProcessed(externalEventId, reason);
  } catch (err) {
    console.error(`[webhook] failed to persist rejection: ${err?.message}`);
  }
}

// Uniform responses for calls refused by plan/business supervision so Dograh,
// Telnyx and the simulator all see the same clear reason.
const LEAD_REJECTION_META = {
  business_disabled: { status: 403, message: 'This business is disabled. New calls are not being captured.' },
  trial_daily_lead_cap_reached: { status: 429, message: 'Trial limit reached — 5 leads captured per day. Upgrade to Solo for unlimited daily leads.' },
  no_active_plumber: { status: 409, message: 'No active business is linked to that phone number.' },
};

function leadRejection(reason, extra = {}) {
  const meta = LEAD_REJECTION_META[reason] || { status: 400, message: 'The lead could not be captured.' };
  return { ok: false, error: reason, reason, status: meta.status, message: extra.message || meta.message, ...extra };
}

// Every hit on /webhooks/* is logged with its final status code.
app.use('/webhooks', (req, res, next) => {
  const startedAt = Date.now();
  res.on('finish', () => logWebhook({
    outcome: 'request',
    method: req.method,
    path: req.originalUrl,
    status: res.statusCode,
    deliveryId: req.get('x-dograh-delivery-id') || undefined,
    remoteIp: req.ip,
    durationMs: Date.now() - startedAt,
  }));
  next();
});


async function sendWebPushToPlumber(plumberId, lead) {
  if (!pushEnabled) return { sent: 0, reason: 'vapid_keys_not_configured' };
  const subs = store.listActivePushSubscriptions(plumberId);
  if (!subs.length) return { sent: 0, reason: 'no_active_push_subscriptions' };
  const urgencyLabel = lead.urgency === 'emergency' ? 'URGENT LEAK' : 'MISSED CALL';
  const payload = JSON.stringify({
    title: `${urgencyLabel} · ${lead.zip_code || 'Austin'}`,
    body: `${lead.caller_phone} — ${lead.issue_summary || 'Tap to review & call back'}`,
    url: `/app?lead=${encodeURIComponent(lead.id)}`,
    tag: `lead-${lead.id}`,
    urgency: lead.urgency,
  });
  let sent = 0;
  for (const sub of subs) {
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, { TTL: 3600 });
      store.markPushSent(sub.endpoint);
      sent += 1;
    } catch (err) {
      if (err?.statusCode === 410 || err?.statusCode === 404) store.deactivatePushEndpoint(sub.endpoint);
    }
  }
  return { sent };
}

/* ---------------- auth endpoints ---------------- */
app.get('/api/auth/config', (_req, res) => {
  res.json({ ok: true, demoLogin: demoLoginEnabled, demoEmail: demoLoginEnabled ? DEMO_LOGIN_EMAIL : null });
});

app.get('/api/auth/me', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!req.auth || !req.plumber) return res.status(401).json({ ok: false, error: 'auth_required', login: '/?login=1' });
  return res.json({ ok: true, user: { email: req.auth.email }, plumber: publicPlumber(req.plumber), redirect: '/app' });
});

app.post('/api/auth/login', (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  const password = String((req.body || {}).password || '');
  if (!email || !password) return res.status(400).json({ ok: false, error: 'missing_credentials', message: 'Enter your email and password.' });
  const user = store.getUserByEmail(email);
  if (!user || !verifyPassword(password, user.password_hash, user.password_salt)) {
    return res.status(401).json({ ok: false, error: 'invalid_credentials', message: 'That email and password do not match an active shop.' });
  }
  const plumber = store.getPlumberById(user.plumber_id);
  if (!plumber) return res.status(401).json({ ok: false, error: 'inactive_shop', message: 'This shop is not active. Contact hello@callflow.biz.' });
  startSession(res, user);
  return res.json({ ok: true, redirect: '/app', user: { email: user.email }, plumber: publicPlumber(plumber) });
});

app.post('/api/auth/signup', (req, res) => {
  const body = req.body || {};
  const businessName = String(body.business_name || '').trim();
  const ownerName = String(body.owner_name || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const ownerPhone = store.normalizePhone(String(body.owner_phone || body.phone || '').trim());
  const serviceArea = String(body.service_area_note || '').trim();

  if (!businessName || !ownerName) return res.status(400).json({ ok: false, error: 'missing_shop_details', message: 'Enter your business name and owner name.' });
  if (!isValidEmail(email)) return res.status(400).json({ ok: false, error: 'invalid_email', message: 'Enter a valid work email, e.g. owner@yourshop.com.' });
  if (!isE164(ownerPhone)) return res.status(400).json({ ok: false, error: 'invalid_phone', message: 'Enter a valid mobile number like +1 512 555 0148.' });
  if (password.length < 8) return res.status(400).json({ ok: false, error: 'weak_password', message: 'Use at least 8 characters for your password.' });
  if (store.getUserByEmail(email)) return res.status(409).json({ ok: false, error: 'email_in_use', message: 'That email already has a CallFlow shop. Log in instead.' });

  const { hash, salt } = hashPassword(password);
  try {
    const result = store.createTrialShop({
      businessName,
      ownerName,
      email,
      ownerPhone,
      serviceArea,
      passwordHash: hash,
      passwordSalt: salt,
    });
    if (!result.ok) {
      const status = result.reason === 'email_in_use' ? 409 : 503;
      return res.status(status).json({ ok: false, error: result.reason, message: result.reason === 'email_in_use' ? 'That email already has a shop.' : 'Could not assign a local trial number. Try again.' });
    }
    startSession(res, result.user);
    return res.status(201).json({ ok: true, redirect: '/app', user: { email: result.user.email }, plumber: publicPlumber(result.plumber) });
  } catch (err) {
    console.error('[auth] signup failed: ' + (err?.message || err));
    const duplicate = String(err?.message || '').includes('UNIQUE');
    return res.status(duplicate ? 409 : 500).json({ ok: false, error: duplicate ? 'email_in_use' : 'signup_failed', message: duplicate ? 'That email already has a shop.' : 'Could not create your trial shop. Try again.' });
  }
});

app.post('/api/auth/demo', (_req, res) => {
  if (!demoLoginEnabled) return res.status(404).json({ ok: false, error: 'demo_disabled' });
  const user = store.getUserByEmail(DEMO_LOGIN_EMAIL);
  if (!user) return res.status(503).json({ ok: false, error: 'demo_unavailable', message: 'Demo login is not seeded yet — restart the server.' });
  const plumber = store.getPlumberById(user.plumber_id);
  if (!plumber) return res.status(503).json({ ok: false, error: 'demo_unavailable' });
  startSession(res, user);
  return res.json({ ok: true, redirect: '/app', user: { email: user.email }, plumber: publicPlumber(plumber) });
});

app.post('/api/auth/logout', (req, res) => {
  const token = req.sessionToken || parseCookies(req.headers.cookie)[SESSION_COOKIE];
  store.deleteSession(token);
  clearSessionCookie(res);
  res.json({ ok: true, redirect: '/' });
});

/* ---------------- super-admin supervision ---------------- */
app.post('/api/admin/login', (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  const password = String((req.body || {}).password || '');
  if (!email || !password) {
    return res.status(400).json({ ok: false, error: 'missing_credentials', message: 'Enter the admin email and password.' });
  }
  const emailOk = email === ADMIN_EMAIL;
  const passwordOk = secretsMatch(password, ADMIN_PASSWORD);
  if (!emailOk || !passwordOk) {
    console.warn(`[admin] failed login attempt for ${email || 'unknown'} from ${req.ip}`);
    return res.status(401).json({ ok: false, error: 'invalid_admin_credentials', message: 'Those admin credentials are not valid.' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + ADMIN_SESSION_TTL_MS).toISOString();
  store.createAdminSession({ token, expiresAt });
  res.append('Set-Cookie', adminSessionCookie(token));
  console.log(`[admin] session started for ${ADMIN_EMAIL} expires=${expiresAt}`);
  return res.json({ ok: true, admin: { email: ADMIN_EMAIL }, redirect: '/admin' });
});

app.get('/api/admin/session', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const auth = adminSessionForRequest(req);
  if (!auth) return res.status(401).json({ ok: false, error: 'admin_auth_required', login: '/admin' });
  return res.json({ ok: true, admin: { email: ADMIN_EMAIL }, expires_at: auth.session.expires_at });
});

app.post('/api/admin/logout', (req, res) => {
  const token = parseCookies(req.headers.cookie)[ADMIN_SESSION_COOKIE];
  store.deleteAdminSession(token);
  clearAdminSessionCookie(res);
  res.json({ ok: true, redirect: '/admin' });
});

app.get('/api/admin/summary', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const filter = String(req.query.filter || 'all');
  const search = String(req.query.search || '');
  const summary = store.getAdminSummary({ filter, search });
  res.json({
    ok: true,
    admin: { email: ADMIN_EMAIL },
    filter: ['all', 'trial', 'paid', 'disabled'].includes(filter.toLowerCase()) ? filter.toLowerCase() : 'all',
    kpis: summary.kpis,
    counts: summary.counts,
    accounts: summary.accounts,
    trial_lead_cap: store.TRIAL_DAILY_LEAD_CAP,
    generated_at: new Date().toISOString(),
  });
});

app.get('/api/admin/businesses', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const summary = store.getAdminSummary({ filter: String(req.query.filter || 'all'), search: String(req.query.search || '') });
  res.json({ ok: true, kpis: summary.kpis, counts: summary.counts, accounts: summary.accounts, trial_lead_cap: store.TRIAL_DAILY_LEAD_CAP });
});

// Cross-account call log for /admin: Date & time, business/number, caller,
// duration and status/outcome for every recent call.
app.get('/api/admin/calls', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  const businessId = String(req.query.business_id || '').trim() || null;
  const calls = store.listCallLog({ businessId, limit });
  const talkSeconds = calls.reduce((sum, call) => sum + (call.duration_seconds || 0), 0);
  res.json({
    ok: true,
    calls,
    totals: { calls: calls.length, talk_seconds: talkSeconds, talk_label: store.formatCallDuration(talkSeconds) },
    generated_at: new Date().toISOString(),
  });
});

function adminBusinessPayload(business) {
  if (!business) return null;
  return {
    id: business.id,
    business_name: business.business_name,
    owner_email: business.email || null,
    is_enabled: Number(business.is_enabled) === 0 ? 0 : 1,
    plan_type: business.plan_type,
    subscription_status: business.subscription_status,
    trial_ends_at: business.trial_ends_at || null,
    minutes_included: Number(business.minutes_included) || 0,
    minutes_used: Number(business.minutes_used) || 0,
    minutes_left: business.minutes_left !== undefined
      ? Math.max(0, Number(business.minutes_left) || 0)
      : Math.max(0, (Number(business.minutes_included) || 0) - (Number(business.minutes_used) || 0)),
  };
}

app.post('/api/admin/businesses/:id/toggle', (req, res) => {
  const body = req.body || {};
  const desired = Object.prototype.hasOwnProperty.call(body, 'enabled') ? Boolean(body.enabled) : undefined;
  const result = store.setBusinessEnabled(req.params.id, desired);
  if (!result.ok) return res.status(404).json({ ok: false, error: result.reason, message: 'Business not found.' });
  const payload = adminBusinessPayload(result.business);
  console.log(`[admin] business ${payload.id} (${payload.business_name}) is_enabled=${payload.is_enabled}`);
  res.json({
    ok: true,
    business: payload,
    message: payload.is_enabled ? `${payload.business_name} enabled — calls are live again.` : `${payload.business_name} disabled — new calls will be rejected.`,
  });
});

app.post('/api/admin/businesses/:id/minutes', (req, res) => {
  const body = req.body || {};
  const result = store.updateBusinessMinutes({
    plumberId: req.params.id,
    includedMinutes: body.included_minutes,
    addMinutes: body.add_minutes,
  });
  if (!result.ok) {
    const status = result.reason === 'business_not_found' ? 404 : 400;
    return res.status(status).json({ ok: false, error: result.reason, message: result.reason === 'missing_minutes' ? 'Send included_minutes or add_minutes.' : 'Business not found.' });
  }
  const payload = adminBusinessPayload(result.business);
  console.log(`[admin] business ${payload.id} minutes_included=${payload.minutes_included} minutes_left=${payload.minutes_left}`);
  res.json({ ok: true, business: payload, message: `Minutes updated — ${payload.minutes_left} min left.` });
});

/* ---------------- Telnyx number pool ---------------- */
const POOL_ERROR_STATUS = {
  invalid_number: 400,
  invalid_forwarding_target: 400,
  number_not_found: 404,
  business_not_found: 404,
  number_not_available: 409,
  number_already_assigned: 409,
  number_disabled: 409,
  number_not_assigned: 409,
  release_first: 409,
  pool_empty: 409,
  sync_failed: 500,
};
const POOL_ERROR_MESSAGES = {
  invalid_number: 'Enter a valid E.164 Telnyx number like +15125550199.',
  invalid_forwarding_target: 'Enter a valid E.164 AI agent number like +17374021999.',
  number_not_found: 'That pool number does not exist.',
  business_not_found: 'Pick a valid business.',
  number_not_available: 'That number is not available — release it from its business first.',
  number_already_assigned: 'That number is already assigned to another business.',
  number_disabled: 'That number is disabled. Enable it before assigning.',
  number_not_assigned: 'That number is not assigned to a business.',
  release_first: 'Release the number from its business before disabling or deleting it.',
  pool_empty: 'No available numbers in the pool.',
  sync_failed: 'The forwarding number could not be synced to the business.',
};

function sendPoolError(res, reason, fallbackMessage) {
  const status = POOL_ERROR_STATUS[reason] || 400;
  return res.status(status).json({
    ok: false,
    error: reason,
    message: fallbackMessage || POOL_ERROR_MESSAGES[reason] || 'Could not complete that number pool action.',
  });
}

function parsePoolId(raw) {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

app.get('/api/admin/number-pool', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  const { numbers, counts } = store.listNumberPool();
  res.json({ ok: true, numbers, counts, generated_at: new Date().toISOString() });
});

app.post('/api/admin/number-pool', (req, res) => {
  const body = req.body || {};
  const rawNumbers = body.numbers !== undefined ? body.numbers : body.phone_number;
  if (!rawNumbers || (Array.isArray(rawNumbers) && rawNumbers.length === 0) || !String(rawNumbers).trim()) {
    return res.status(400).json({ ok: false, error: 'missing_number', message: 'Enter at least one Telnyx number.' });
  }
  const result = store.addPoolNumbers({
    numbers: rawNumbers,
    friendlyLabel: body.friendly_label || body.label || null,
    notes: body.notes || null,
  });
  if (!result.ok) {
    return res.status(409).json({
      ok: false,
      error: 'no_numbers_added',
      message: 'No new numbers were added — they are duplicates or not valid E.164 numbers.',
      skipped: result.skipped,
      counts: result.counts,
    });
  }
  console.log(`[admin] number pool added ${result.added.length} number(s), skipped ${result.skipped.length}`);
  res.status(201).json({
    ok: true,
    added: result.added,
    skipped: result.skipped,
    counts: result.counts,
    message: `${result.added.length} number${result.added.length === 1 ? '' : 's'} added to the pool.`,
  });
});

app.post('/api/admin/number-pool/:id/assign', (req, res) => {
  const poolId = parsePoolId(req.params.id);
  if (!poolId) return sendPoolError(res, 'number_not_found');
  const body = req.body || {};
  const businessId = String(body.business_id || '').trim();
  if (!businessId) return res.status(400).json({ ok: false, error: 'missing_business', message: 'Pick a business to assign this number to.' });
  const result = store.assignPoolNumberToBusiness({ poolId, businessId, forwardingTarget: body.forwarding_target });
  if (!result.ok) return sendPoolError(res, result.reason);
  console.log(`[admin] pool number ${result.number.phone_number} assigned to ${result.business.business_name} (${result.business.id}) forwarding_target=${result.forwarding_target || 'none'}`);
  res.json({
    ok: true,
    number: result.number,
    business: result.business,
    forwarding_target: result.forwarding_target || null,
    counts: store.listNumberPool().counts,
    message: `${result.number.display_number} assigned to ${result.business.business_name}.`,
  });
});

// Optional per-number AI agent / forwarding target. The DID forwards to this
// line in Telnyx, and Dograh then reports it as `to_number` — webhook ingestion
// uses it to resolve the tenant when `forwarded_from` is missing.
app.post('/api/admin/number-pool/:id/forwarding-target', (req, res) => {
  const poolId = parsePoolId(req.params.id);
  if (!poolId) return sendPoolError(res, 'number_not_found');
  const body = req.body || {};
  if (!Object.prototype.hasOwnProperty.call(body, 'forwarding_target')) {
    return res.status(400).json({
      ok: false,
      error: 'missing_forwarding_target',
      message: 'Send forwarding_target as E.164, or null to clear it.',
    });
  }
  const result = store.setPoolNumberForwardingTarget({ poolId, forwardingTarget: body.forwarding_target });
  if (!result.ok) return sendPoolError(res, result.reason);
  console.log(`[admin] pool number ${result.number.phone_number} forwarding_target=${result.forwarding_target || 'none'}`);
  res.json({
    ok: true,
    number: result.number,
    forwarding_target: result.forwarding_target,
    counts: store.listNumberPool().counts,
    message: result.message,
  });
});

app.post('/api/admin/number-pool/:id/release', (req, res) => {
  const poolId = parsePoolId(req.params.id);
  if (!poolId) return sendPoolError(res, 'number_not_found');
  const result = store.releasePoolNumber(poolId);
  if (!result.ok) return sendPoolError(res, result.reason);
  console.log(`[admin] pool number ${result.number.phone_number} released from ${result.business_id}`);
  res.json({ ok: true, number: result.number, business_id: result.business_id, counts: store.listNumberPool().counts, message: result.message });
});

app.post('/api/admin/number-pool/:id/toggle', (req, res) => {
  const poolId = parsePoolId(req.params.id);
  if (!poolId) return sendPoolError(res, 'number_not_found');
  const result = store.togglePoolNumber(poolId);
  if (!result.ok) return sendPoolError(res, result.reason);
  console.log(`[admin] pool number ${result.number.phone_number} status=${result.number.status}`);
  res.json({ ok: true, number: result.number, counts: store.listNumberPool().counts, message: result.message });
});

app.delete('/api/admin/number-pool/:id', (req, res) => {
  const poolId = parsePoolId(req.params.id);
  if (!poolId) return sendPoolError(res, 'number_not_found');
  const result = store.deletePoolNumber(poolId);
  if (!result.ok) return sendPoolError(res, result.reason);
  console.log(`[admin] pool number id=${result.deleted_id} deleted`);
  res.json({ ok: true, deleted_id: result.deleted_id, counts: result.counts, message: 'Number removed from the pool.' });
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'callflow.biz', pushEnabled, vapidPublicKey: vapidPublicKey || null });
});

// Public contact form endpoint (no session). Messages are written to the server
// log with a reference code so support can pick them up; no email provider is
// required for the page to confirm successfully.
app.post('/api/contact', (req, res) => {
  const body = req.body || {};
  // Honeypot: bots fill the hidden "website" field. Acknowledge silently.
  if (String(body.website || '').trim()) return res.json({ ok: true, reference: null });
  const name = String(body.name || '').trim().slice(0, 120);
  const email = String(body.email || '').trim().toLowerCase().slice(0, 200);
  const business = String(body.business || '').trim().slice(0, 160);
  const topic = String(body.topic || 'Support').trim().slice(0, 80);
  const message = String(body.message || '').trim();
  if (!name) return res.status(400).json({ ok: false, error: 'missing_name', message: 'Please enter your name.' });
  if (!isValidEmail(email)) return res.status(400).json({ ok: false, error: 'invalid_email', message: 'Please enter a valid work email.' });
  if (message.length < 10) return res.status(400).json({ ok: false, error: 'message_too_short', message: 'Add a few more details so we can help.' });
  if (message.length > 5000) return res.status(400).json({ ok: false, error: 'message_too_long', message: 'Please keep your message under 5,000 characters.' });
  const reference = `CF-${Date.now().toString(36).toUpperCase()}`;
  console.log('[contact] ' + JSON.stringify({
    reference,
    name,
    email,
    business: business || null,
    topic,
    messageLength: message.length,
    message: message.slice(0, 2000),
    ip: req.ip,
    receivedAt: new Date().toISOString(),
  }));
  return res.status(201).json({
    ok: true,
    reference,
    delivery: 'logged',
    message: `Thanks ${name.split(/\s+/)[0]} — your message is in. We reply within one business day (Mon–Fri, 9am–6pm CT).`,
  });
});

app.get('/api/state', (req, res) => {
  const plumber = req.plumber;
  const leads = store.db.prepare('SELECT * FROM leads WHERE plumber_id = ? ORDER BY created_at DESC LIMIT 50').all(plumber.id);
  const pushCount = store.listActivePushSubscriptions(plumber.id).length;
  const bookedCount = leads.filter((l) => l.status === 'booked').length;
  const bookedRevenueUsd = leads.filter((l) => l.status === 'booked').reduce((s, l) => s + (l.estimated_value_usd || plumber.avg_ticket_usd || 480), 0);
  res.json({ plumber, leads, pushCount, metrics: { bookedCount, bookedRevenueUsd, totalLeads: leads.length } });
});

// Shop-scoped call log (Date & time + call duration) backing the /app view.
// /api/state already carries the same leads; this endpoint is the stable
// contract for the log so both /app and /admin render an identical shape.
app.get('/api/calls', (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
  const calls = store.listCallLog({ plumberId: req.plumber.id, limit });
  res.json({ ok: true, calls, generated_at: new Date().toISOString() });
});

// Aggregate endpoint for the dashboard + first-time onboarding wizard.
// Non-breaking: every value here is also available from /api/state and friends.
app.get('/api/bootstrap', (req, res) => {
  const plumber = req.plumber;
  const leads = store.db.prepare('SELECT * FROM leads WHERE plumber_id = ? ORDER BY created_at DESC LIMIT 50').all(plumber.id);
  const pushSubscriptions = store.listActivePushSubscriptions(plumber.id);
  const subscription = store.getPlumberSubscription(plumber.id);
  const config = billingConfig(req);

  const bookedCount = leads.filter((lead) => lead.status === 'booked').length;
  const bookedRevenueUsd = leads
    .filter((lead) => lead.status === 'booked')
    .reduce((sum, lead) => sum + (lead.estimated_value_usd || plumber.avg_ticket_usd || 480), 0);

  const emailResolved = isValidEmail(plumber.email) || isValidEmail(process.env.DODO_CUSTOMER_EMAIL);
  const hasShopDetails = Boolean(String(plumber.owner_name || '').trim() && String(plumber.business_name || '').trim() && emailResolved);
  const hasForwarding = isE164(plumber.telnyx_number);
  const hasPush = pushSubscriptions.length > 0;
  const planActive = Boolean(subscription && subscription.status === 'active');

  const steps = [
    { key: 'shop', label: 'Shop Details & Email', complete: hasShopDetails },
    { key: 'push', label: 'Web Push Alerts Enabled', complete: hasPush },
    { key: 'forwarding', label: 'Forwarding Number Ready', complete: hasForwarding },
    { key: 'plan', label: 'Solo Plan Active ($99/mo)', complete: planActive },
  ];

  const lastWebhook = store.db.prepare("SELECT created_at FROM webhook_events WHERE source = 'dograh' ORDER BY created_at DESC LIMIT 1").get();
  const plan = store.planSnapshot(plumber);
  const includedMinutes = plan.minutes_included;
  const usedMinutes = plan.minutes_used;

  res.json({
    ok: true,
    plumber,
    leads,
    pushCount: pushSubscriptions.length,
    metrics: { bookedCount, bookedRevenueUsd, totalLeads: leads.length },
    billing: {
      status: subscription ? subscription.status : plan.subscription_status,
      plan_code: subscription ? subscription.plan_code : (plan.is_paid ? 'solo_99' : 'trial_3day'),
      plan_type: plan.plan_type,
      is_paid: plan.is_paid,
      is_trial: plan.is_trial,
      is_enabled: plan.is_enabled ? 1 : 0,
      trial_ends_at: plan.trial_ends_at,
      trial_days_left: plan.trial_days_left,
      trial_expired: plan.trial_expired,
      daily_lead_limit: plan.daily_lead_limit,
      leads_today: store.countLeadsToday(plumber.id),
      used_minutes: usedMinutes,
      included_minutes: includedMinutes,
      remaining_minutes: plan.minutes_left,
      current_period_end: subscription ? subscription.current_period_end : null,
      configured: {
        dodo_api_key: config.dodoApiKey,
        dodo_plan_solo_id: config.dodoPlanSoloId,
        dodo_webhook_secret: config.dodoWebhookSecret,
        dodo_customer_email: config.dodoCustomerEmail,
        checkout_currency: config.checkoutCurrency,
        billing_address: config.billingAddress,
        mode: config.mode,
      },
      ready_for_checkout: config.configured,
      missing: config.missing,
    },
    readiness: {
      webhook_ready: Boolean(String(process.env.DOGRAH_WEBHOOK_SECRET || '').trim()),
      last_webhook_at: lastWebhook ? lastWebhook.created_at : null,
      push_ready: pushEnabled,
      push_devices: pushSubscriptions.length,
    },
    onboarding: {
      steps,
      completed_steps: steps.filter((step) => step.complete).map((step) => step.key),
      complete: steps.every((step) => step.complete),
      has_shop_details: hasShopDetails,
      has_email: emailResolved,
      has_forwarding: hasForwarding,
      has_push: hasPush,
      plan_active: planActive,
    },
  });
});

app.get('/api/billing/status', (req, res) => {
  const plumber = req.plumber;
  const subscription = store.getPlumberSubscription(plumber.id);
  const config = billingConfig(req);
  const plan = store.planSnapshot(plumber);
  const includedMinutes = plan.minutes_included;
  const usedMinutes = plan.minutes_used;
  res.json({
    ok: true,
    plumber_id: plumber.id,
    business_name: plumber.business_name,
    status: subscription ? subscription.status : plan.subscription_status,
    plan_code: subscription ? subscription.plan_code : (plan.is_paid ? 'solo_99' : 'trial_3day'),
    plan_type: plan.plan_type,
    is_paid: plan.is_paid,
    is_trial: plan.is_trial,
    is_enabled: plan.is_enabled ? 1 : 0,
    trial_ends_at: plan.trial_ends_at,
    trial_days_left: plan.trial_days_left,
    trial_expired: plan.trial_expired,
    daily_lead_limit: plan.daily_lead_limit,
    leads_today: store.countLeadsToday(plumber.id),
    used_minutes: usedMinutes,
    included_minutes: includedMinutes,
    remaining_minutes: plan.minutes_left,
    current_period_end: subscription ? subscription.current_period_end : null,
    dodo_customer_id: subscription ? subscription.dodo_customer_id : null,
    dodo_subscription_id: subscription ? subscription.dodo_subscription_id : null,
    updated_at: subscription ? subscription.updated_at : null,
    configured: {
      dodo_api_key: config.dodoApiKey,
      dodo_plan_solo_id: config.dodoPlanSoloId,
      dodo_webhook_secret: config.dodoWebhookSecret,
      dodo_customer_email: config.dodoCustomerEmail,
      checkout_currency: config.checkoutCurrency,
      billing_address: config.billingAddress,
      app_base_url: config.appBaseUrl,
      mode: config.mode,
    },
    ready_for_checkout: config.configured,
    missing: config.missing,
  });
});

app.post('/api/billing/checkout', async (req, res) => {
  const config = billingConfig(req);
  const planCode = 'solo_99';

  if (!config.configured) {
    return res.status(400).json({
      ok: false,
      configured: false,
      missing: config.missing,
      message: 'Dodo Payments is not configured yet. Add ' + config.missing.join(' and ') + ' to .env, then restart the server.',
      configured_keys: config,
    });
  }

  const plumber = req.plumber;
  const returnUrl = new URL('/app?billing=success', appBaseUrl(req)).toString();
  const currency = checkoutCurrency();
  const address = billingAddress();
  const prefill = buildCustomerPrefill(plumber);
  const metadata = { plumber_id: plumber.id, plan_code: planCode };
  if (prefill.ownerName) metadata.owner_name = prefill.ownerName;
  if (prefill.businessName) metadata.business_name = prefill.businessName;
  const payload = {
    product_cart: [{ product_id: String(process.env.DODO_PLAN_SOLO_ID).trim(), quantity: 1 }],
    // Pin the billing currency: with Adaptive Currency enabled Dodo otherwise
    // guesses the buyer's local currency (e.g. INR) instead of the USD base price.
    billing_currency: currency,
    // Pin the billing country too, otherwise Dodo geolocates the visitor's IP.
    billing_address: address,
    return_url: returnUrl,
    metadata,
    customer: prefill.customer,
  };

  const baseUrl = dodoApiBaseUrl();
  try {
    const response = await fetch(baseUrl + '/checkouts', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + String(process.env.DODO_API_KEY).trim(), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }

    if (!response.ok) {
      console.error('[billing] dodo checkout failed status=' + response.status + ' body=' + String(text).slice(0, 400));
      const dodoCode = (json && (json.code || json.error_code)) || null;
      return res.status(502).json({
        ok: false,
        configured: true,
        status: response.status,
        code: dodoCode,
        message: 'Dodo Payments rejected the checkout request.',
        error: (json && (json.message || json.error)) || String(text).slice(0, 300) || 'unknown_error',
        hint: dodoCode === 'INVALID_REQUEST_BODY'
          ? 'Check DODO_PLAN_SOLO_ID belongs to this environment, and that no partial customer object is sent.'
          : undefined,
      });
    }

    const checkoutUrl = (json && (json.checkout_url || json.checkoutUrl)) || null;
    if (!checkoutUrl) {
      console.error('[billing] dodo checkout response missing checkout_url: ' + String(text).slice(0, 400));
      return res.status(502).json({ ok: false, configured: true, message: 'Dodo Payments returned no checkout_url.', session_id: (json && json.session_id) || null });
    }

    const sessionId = (json && json.session_id) || null;
    const customerRecord = await syncDodoCustomerRecord({
      email: prefill.customer.email,
      name: prefill.customer.name,
      phoneNumber: prefill.customer.phone_number,
    });
    console.log('[billing] checkout session created ' + JSON.stringify({ plumberId: plumber.id, planCode, sessionId, returnUrl, mode: config.mode, currency, billingAddress: address, customerName: prefill.customer.name, customerNameSource: prefill.nameSource, customerEmailSource: prefill.emailSource, customerRecord }));
    res.json({ ok: true, checkoutUrl, sessionId, planCode, returnUrl, mode: config.mode, currency, billingAddress: address, customerName: prefill.customer.name, customerNameSource: prefill.nameSource, customerPrefill: prefill.emailSource, customerRecord });
  } catch (err) {
    const reason = err && err.name === 'TimeoutError' ? 'request_timeout' : 'request_failed';
    console.error('[billing] dodo checkout error: ' + ((err && err.message) || String(err)));
    res.status(502).json({ ok: false, configured: true, message: 'Could not reach Dodo Payments.', error: (err && err.message) || String(err), reason });
  }
});

app.post('/api/plumber/settings', (req, res) => {
  const plumber = req.plumber;
  const { business_name, owner_name, owner_phone, email, established_line, avg_ticket_usd, service_area_note, telnyx_number } = req.body || {};
  const emailValue = String(email || '').trim().toLowerCase();
  if (emailValue && !isValidEmail(emailValue)) {
    return res.status(400).json({ ok: false, error: 'invalid_email', message: 'Enter a valid billing email like billing@yourbusiness.com.' });
  }
  store.db.prepare(`
    UPDATE plumbers SET business_name = COALESCE(NULLIF(?, ''), business_name), owner_name = COALESCE(NULLIF(?, ''), owner_name),
      owner_phone = COALESCE(NULLIF(?, ''), owner_phone), email = COALESCE(NULLIF(?, ''), email),
      established_line = COALESCE(?, established_line), avg_ticket_usd = COALESCE(?, avg_ticket_usd),
      service_area_note = COALESCE(NULLIF(?, ''), service_area_note), updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?
  `).run(business_name?.trim() || '', owner_name?.trim() || '', owner_phone?.trim() || '', emailValue, established_line?.trim() ?? null, Number(avg_ticket_usd) > 0 ? Math.round(Number(avg_ticket_usd)) : null, service_area_note?.trim() || '', plumber.id);

  let telnyxNumberResult = null;
  if (telnyx_number && String(telnyx_number).trim()) {
    telnyxNumberResult = store.assignTelephonyNumberToPlumber({ plumberId: plumber.id, telnyxNumber: telnyx_number });
    if (!telnyxNumberResult.ok) return res.status(400).json({ ok: false, error: telnyxNumberResult.reason, attempted: telnyx_number });
  }
  const updated = store.getPlumberById(plumber.id);
  if (telnyxNumberResult?.ok && telnyxNumberResult.e164Number !== updated.telnyx_number) {
    // Never let the UI silently jump back to an old number again.
    console.warn(`[settings] telnyx_number mismatch: assigned=${telnyxNumberResult.e164Number} primary=${updated.telnyx_number}`);
  }
  res.json({ ok: true, plumber: updated, telnyxNumber: telnyxNumberResult });
});

app.post('/api/push/subscribe', (req, res) => {
  const plumber = req.plumber;
  const { subscription, deviceLabel } = req.body || {};
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) return res.status(400).json({ ok: false, error: 'Invalid subscription' });
  const saved = store.savePushSubscription({ plumberId: plumber.id, endpoint: subscription.endpoint, p256dh: subscription.keys.p256dh, auth: subscription.keys.auth, deviceLabel });
  res.json({ ok: true, subscriptionId: saved.id });
});

app.patch('/api/leads/:id', (req, res) => {
  const { id } = req.params;
  const { status } = req.body || {};
  const lead = store.db.prepare('SELECT * FROM leads WHERE id = ? AND plumber_id = ?').get(id, req.plumber.id);
  if (!lead) return res.status(404).json({ ok: false, error: 'Lead not found' });
  if (['new', 'triaging', 'ready', 'called', 'booked', 'closed_lost'].includes(status)) {
    store.db.prepare(`UPDATE leads SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ? AND plumber_id = ?`).run(status, id, req.plumber.id);
  }
  res.json({ ok: true, lead: store.db.prepare('SELECT * FROM leads WHERE id = ? AND plumber_id = ?').get(id, req.plumber.id) });
});

app.post('/webhooks/dograh/lead', async (req, res) => {
  const startedAt = Date.now();
  const expectedSecret = process.env.DOGRAH_WEBHOOK_SECRET;
  const providedSecret = DOGRAH_SECRET_HEADERS.map((header) => req.get(header)).find((value) => value && String(value).trim())
    || req.get('authorization')?.replace(/^Bearer\s+/i, '');
  const secretHeader = DOGRAH_SECRET_HEADERS.find((header) => req.get(header)) || (req.get('authorization') ? 'authorization' : null);
  const deliveryId = req.get('x-dograh-delivery-id') || null;

  if (expectedSecret && !secretsMatch(providedSecret, expectedSecret)) {
    const reason = providedSecret ? 'secret_mismatch' : 'secret_missing';
    logWebhook({
      outcome: 'rejected',
      reason,
      path: req.originalUrl,
      secretHeader: secretHeader || 'none',
      acceptedSecretHeaders: DOGRAH_SECRET_HEADERS,
      deliveryId,
      remoteIp: req.ip,
      userAgent: req.get('user-agent'),
      durationMs: Date.now() - startedAt,
    });
    recordRejectedWebhook(reason, req);
    return res.status(401).json({
      ok: false,
      error: 'Unauthorized',
      reason,
      hint: `Send DOGRAH_WEBHOOK_SECRET in one of: ${DOGRAH_SECRET_HEADERS.join(', ')} (or Authorization: Bearer <secret>)`,
    });
  }

  // Accept both top-level and nested payload shapes (data / call / payload /
  // JSON-encoded `gathered` + `initial_context` strings, etc.).
  const body = req.body || {};
  const containers = collectWebhookContainers(body);
  const eventType = String(pickWebhookField(containers, DOGRAH_FIELDS.eventType) || 'call.completed');
  const eventId = String(pickWebhookField(containers, DOGRAH_FIELDS.eventId) || deliveryId || crypto.randomUUID()).trim();

  const extracted = {
    telnyxNumber: pickWebhookField(containers, DOGRAH_FIELDS.telnyxNumber),
    forwardedFrom: pickWebhookField(containers, DOGRAH_FIELDS.forwardedFrom),
    businessId: pickWebhookField(containers, DOGRAH_FIELDS.businessId),
    callerPhone: pickWebhookField(containers, DOGRAH_FIELDS.callerPhone),
    callerName: pickWebhookField(containers, DOGRAH_FIELDS.callerName),
    urgency: normalizeUrgencyValue(pickWebhookField(containers, DOGRAH_FIELDS.urgency)),
    zipCode: pickWebhookField(containers, DOGRAH_FIELDS.zipCode),
    streetAddress: pickWebhookField(containers, DOGRAH_FIELDS.streetAddress),
    issueSummary: pickWebhookField(containers, DOGRAH_FIELDS.issueSummary),
    durationSeconds: normalizeDurationSeconds(pickWebhookField(containers, DOGRAH_FIELDS.durationSeconds)),
    startedAt: pickWebhookField(containers, DOGRAH_FIELDS.startedAt),
    transcript: pickWebhookField(containers, DOGRAH_FIELDS.transcript),
  };

  const callerRestricted = isRestrictedCaller(extracted.callerPhone);
  const callerPhone = callerRestricted ? null : String(extracted.callerPhone).trim();
  // Keep withheld callers (`restricted@<ip>`, anonymous) readable instead of
  // mangling them into a fake dialable number.
  const callerLabel = callerRestricted ? (extracted.callerPhone ? String(extracted.callerPhone).trim() : 'Unknown caller') : null;

  logWebhook({
    outcome: 'received',
    path: req.originalUrl,
    deliveryId,
    eventId,
    eventType,
    containersScanned: containers.length,
    resolved: {
      telnyx_number: extracted.telnyxNumber ?? null,
      forwarded_from: extracted.forwardedFrom ?? null,
      business_id: extracted.businessId ?? null,
      caller: extracted.callerPhone ?? null,
      caller_restricted: callerRestricted,
      caller_name: extracted.callerName ?? null,
      urgency: extracted.urgency ?? null,
      zip_code: extracted.zipCode ?? null,
      issue_summary: extracted.issueSummary ? String(extracted.issueSummary).slice(0, 160) : null,
      duration_seconds: extracted.durationSeconds ?? null,
      started_at: extracted.startedAt ?? null,
      has_transcript: Boolean(extracted.transcript),
    },
  });

  if (!store.recordWebhookEventOnce({ source: 'dograh', externalEventId: eventId, eventType, payload: body })) {
    logWebhook({ outcome: 'duplicate_ignored', eventId, deliveryId, durationMs: Date.now() - startedAt });
    return res.json({ ok: true, duplicate: true, eventId });
  }

  const result = store.createOrUpdateLead({
    telnyxNumber: extracted.telnyxNumber,
    forwardedFrom: extracted.forwardedFrom,
    businessId: extracted.businessId,
    callerPhone,
    callerName: extracted.callerName,
    callerLabel,
    externalCallId: eventId,
    urgency: extracted.urgency,
    zipCode: extracted.zipCode,
    streetAddress: extracted.streetAddress,
    issueSummary: extracted.issueSummary,
    durationSeconds: extracted.durationSeconds ?? 0,
    startedAt: extracted.startedAt,
    transcript: extracted.transcript,
    structuredJson: body,
    eventId,
  });

  if (!result.ok) {
    store.markWebhookProcessed(eventId, result.reason);
    logWebhook({
      outcome: 'lead_rejected',
      eventId,
      reason: result.reason,
      matchedBy: result.matched_by ?? null,
      trialLeadsToday: result.used,
      trialLeadCap: result.limit,
      durationMs: Date.now() - startedAt,
    });
    const rejection = leadRejection(result.reason, {
      eventId,
      limit: result.limit,
      used: result.used,
      plan_type: result.plan_type,
    });
    const { status, ...payload } = rejection;
    return res.status(status).json(payload);
  }

  const push = await sendWebPushToPlumber(result.plumber.id, result.lead);
  store.markWebhookProcessed(eventId, null);
  logWebhook({
    outcome: 'lead_saved',
    eventId,
    leadId: result.lead.id,
    plumberId: result.plumber.id,
    matchedBy: result.matched_by ?? null,
    forwardedFrom: extracted.forwardedFrom ?? null,
    caller: result.lead.caller_phone,
    urgency: result.lead.urgency,
    status: result.lead.status,
    pushSent: push.sent,
    durationMs: Date.now() - startedAt,
  });
  res.json({ ok: true, lead: result.lead, push, eventId, extracted, matchedBy: result.matched_by || null });
});

app.post('/webhooks/dodo', (req, res) => {
  const startedAt = Date.now();
  const bodyBuffer = req.rawBodyBuffer || Buffer.from(req.rawBody || '', 'utf8');
  const verification = verifyDodoSignature(req, bodyBuffer, process.env.DODO_WEBHOOK_SECRET);

  if (!verification.ok) {
    logWebhook({
      outcome: 'rejected',
      source: 'dodo',
      reason: verification.reason,
      path: req.originalUrl,
      signatureHeader: verification.signatureHeader || 'none',
      acceptedSignatureHeaders: DODO_SIGNATURE_HEADERS,
      webhookId: req.get('webhook-id') || null,
      remoteIp: req.ip,
      userAgent: req.get('user-agent'),
      durationMs: Date.now() - startedAt,
    });
    recordRejectedWebhook(verification.reason, req, 'dodo');
    return res.status(401).json({ ok: false, error: 'Unauthorized', reason: verification.reason });
  }

  if (verification.skipped) {
    console.warn('[webhook] source=dodo signature verification skipped: DODO_WEBHOOK_SECRET is not configured');
  }

  const event = req.body || {};
  const data = event.data || event;
  const metadata = data.metadata || event.metadata || {};
  const eventType = String(event.type || event.event_type || data.event_type || 'subscription.updated');
  const eventId = String(event.id || event.event_id || req.get('webhook-id') || eventType + ':' + (data.subscription_id || data.id || crypto.randomUUID()));

  logWebhook({
    outcome: 'verified',
    source: 'dodo',
    eventId,
    eventType,
    scheme: verification.scheme || null,
    signatureHeader: verification.signatureHeader || null,
    verificationSkipped: Boolean(verification.skipped),
    durationMs: Date.now() - startedAt,
  });

  if (!store.recordWebhookEventOnce({ source: 'dodo', externalEventId: eventId, eventType, payload: event })) {
    logWebhook({ outcome: 'duplicate_ignored', source: 'dodo', eventId, eventType });
    return res.json({ ok: true, duplicate: true, eventId });
  }

  // Billing events we do not model (payments, refunds, disputes, ...) are
  // acknowledged and archived without touching subscription state.
  if (!eventType.startsWith('subscription.')) {
    store.markWebhookProcessed(eventId, null);
    logWebhook({ outcome: 'ignored_event', source: 'dodo', eventId, eventType });
    return res.json({ ok: true, ignored: true, reason: 'not_a_subscription_event', eventType, eventId });
  }

  const customerId = data.customer?.customer_id || data.customer?.id || data.customer_id || null;
  const subscriptionId = data.subscription_id || data.id || null;
  const plumber = store.findPlumberForDodo({
    plumberId: metadata.plumber_id || data.plumber_id,
    dodoSubscriptionId: subscriptionId,
    dodoCustomerId: customerId,
  });
  if (!plumber) {
    store.markWebhookProcessed(eventId, 'plumber_not_found');
    logWebhook({ outcome: 'unmatched_plumber', source: 'dodo', eventId, eventType, subscriptionId, customerId });
    return res.status(404).json({ ok: false, error: 'Plumber not found', eventId });
  }

  const rawStatus = DODO_STATUS_BY_EVENT[eventType] ?? String(data.status || '').trim().toLowerCase();
  const status = DODO_SUBSCRIPTION_STATUSES.includes(rawStatus) ? rawStatus : null;
  if (!status) {
    store.markWebhookProcessed(eventId, 'unmapped_status:' + (rawStatus || 'unknown'));
    logWebhook({ outcome: 'unmapped_status', source: 'dodo', eventId, eventType, rawStatus: rawStatus || null });
    return res.json({ ok: true, ignored: true, reason: 'unmapped_subscription_status', eventType, eventId });
  }

  const includedRaw = data.included_minutes ?? metadata.included_minutes;
  const includedMinutes = includedRaw === undefined || includedRaw === null || includedRaw === '' || !Number.isFinite(Number(includedRaw))
    ? null
    : Math.max(0, Math.round(Number(includedRaw)));

  const subscription = store.upsertDodoSubscription({
    plumberId: plumber.id,
    dodoCustomerId: customerId,
    dodoSubscriptionId: subscriptionId,
    planCode: metadata.plan_code || data.product_id || data.plan_code || null,
    status,
    includedMinutes,
    currentPeriodEnd: data.next_billing_date || data.current_period_end || data.expires_at || null,
  });

  store.markWebhookProcessed(eventId, null);
  logWebhook({
    outcome: 'subscription_synced',
    source: 'dodo',
    eventId,
    eventType,
    plumberId: plumber.id,
    status: subscription.status,
    planCode: subscription.plan_code,
    currentPeriodEnd: subscription.current_period_end,
    durationMs: Date.now() - startedAt,
  });
  res.json({ ok: true, subscription, eventId, eventType, verified: !verification.skipped });
});

// Anything else under /webhooks is a wrong path (e.g. /webhooks/dograh without /lead).
app.use('/webhooks', (req, res) => {
  logWebhook({ outcome: 'unknown_webhook_path', method: req.method, path: req.originalUrl, remoteIp: req.ip });
  res.status(404).json({ ok: false, error: 'Unknown webhook endpoint', path: req.originalUrl, known: ['/webhooks/dograh/lead', '/webhooks/dodo'] });
});

app.post('/api/simulate-call', async (req, res) => {
  const plumber = req.plumber;
  const b = req.body || {};
  const result = store.createOrUpdateLead({
    telnyxNumber: plumber.telnyx_number,
    callerPhone: b.caller_phone || '+15125550188',
    callerName: b.caller_name || 'Devon Brooks',
    externalCallId: `sim-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
    urgency: b.urgency || 'emergency',
    zipCode: b.zip_code || '78758',
    issueSummary: b.issue_summary || 'Water heater leaking onto garage floor near Burnet Rd',
    durationSeconds: b.duration_seconds || 54,
    transcript: `[Simulated Dograh AI Call] ${b.issue_summary || 'Water heater leaking'}`,
  });
  if (!result.ok) {
    const rejection = leadRejection(result.reason, { limit: result.limit, used: result.used, plan_type: result.plan_type });
    const { status, ...payload } = rejection;
    console.warn(`[simulate] rejected plumber=${plumber.id} reason=${result.reason}`);
    return res.status(status).json(payload);
  }
  const push = await sendWebPushToPlumber(plumber.id, result.lead);
  res.json({ ok: true, lead: result.lead, push, plan: result.plan });
});

// Bind address: HOST=127.0.0.1 in production (nginx terminates TLS and proxies
// to us, so the app port is never exposed); 0.0.0.0 keeps local dev unchanged.
const host = String(process.env.HOST || '0.0.0.0').trim() || '0.0.0.0';
app.listen(port, host, () => {
  console.log(`CallFlow (www.callflow.biz) running at http://${host}:${port}`);
  console.log(`VAPID Web Push enabled: ${pushEnabled ? 'YES' : 'NO'}`);
});
