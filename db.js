import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

export function initDatabase(dbPath = process.env.SQLITE_PATH || './data/callflow.db') {
  const resolvedPath = path.resolve(dbPath);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  const db = new Database(resolvedPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS plumbers (
      id TEXT PRIMARY KEY,
      business_name TEXT NOT NULL,
      owner_name TEXT,
      email TEXT,
      owner_phone TEXT NOT NULL,
      established_line TEXT,
      avg_ticket_usd INTEGER NOT NULL DEFAULT 480,
      service_area_note TEXT NOT NULL DEFAULT 'Greater Austin (78701-78759)',
      active INTEGER NOT NULL DEFAULT 1,
      is_enabled INTEGER NOT NULL DEFAULT 1,
      plan_type TEXT NOT NULL DEFAULT 'trial',
      subscription_status TEXT NOT NULL DEFAULT 'trialing',
      minutes_included INTEGER NOT NULL DEFAULT 30,
      minutes_used INTEGER NOT NULL DEFAULT 0,
      trial_ends_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS telephony_numbers (
      id TEXT PRIMARY KEY,
      e164_number TEXT NOT NULL UNIQUE,
      provider TEXT NOT NULL DEFAULT 'telnyx',
      assigned_plumber_id TEXT REFERENCES plumbers(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'assigned', 'maintenance')),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY,
      plumber_id TEXT NOT NULL UNIQUE REFERENCES plumbers(id) ON DELETE CASCADE,
      dodo_customer_id TEXT,
      dodo_subscription_id TEXT UNIQUE,
      plan_code TEXT NOT NULL DEFAULT 'solo_99',
      status TEXT NOT NULL DEFAULT 'trialing' CHECK (status IN ('trialing', 'active', 'on_hold', 'past_due', 'cancelled', 'expired')),
      included_minutes INTEGER NOT NULL DEFAULT 200,
      used_minutes INTEGER NOT NULL DEFAULT 0,
      current_period_end TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS leads (
      id TEXT PRIMARY KEY,
      plumber_id TEXT NOT NULL REFERENCES plumbers(id) ON DELETE CASCADE,
      telephony_number_id TEXT REFERENCES telephony_numbers(id) ON DELETE SET NULL,
      caller_phone TEXT NOT NULL,
      caller_name TEXT,
      external_call_id TEXT UNIQUE,
      urgency TEXT NOT NULL DEFAULT 'unknown' CHECK (urgency IN ('unknown', 'emergency', 'standard')),
      status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'triaging', 'ready', 'called', 'booked', 'closed_lost')),
      zip_code TEXT,
      street_address TEXT,
      issue_summary TEXT,
      estimated_value_usd INTEGER,
      duration_seconds INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS ai_call_logs (
      id TEXT PRIMARY KEY,
      lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      plumber_id TEXT NOT NULL REFERENCES plumbers(id) ON DELETE CASCADE,
      external_event_id TEXT UNIQUE,
      transcript TEXT,
      structured_json TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id TEXT PRIMARY KEY,
      plumber_id TEXT NOT NULL REFERENCES plumbers(id) ON DELETE CASCADE,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      device_label TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      last_pushed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS webhook_events (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL CHECK (source IN ('telnyx', 'dograh', 'dodo')),
      external_event_id TEXT NOT NULL UNIQUE,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      processed INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      processed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS shop_users (
      id TEXT PRIMARY KEY,
      plumber_id TEXT NOT NULL UNIQUE REFERENCES plumbers(id) ON DELETE CASCADE,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      last_login_at TEXT
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES shop_users(id) ON DELETE CASCADE,
      plumber_id TEXT NOT NULL REFERENCES plumbers(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      expires_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
    CREATE TABLE IF NOT EXISTS admin_sessions (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_admin_sessions_expiry ON admin_sessions(expires_at);
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS number_pool (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone_number TEXT UNIQUE NOT NULL,
      friendly_label TEXT,
      area_code TEXT,
      status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'assigned', 'disabled')),
      assigned_business_id TEXT REFERENCES plumbers(id) ON DELETE SET NULL,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      assigned_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_number_pool_status ON number_pool(status);
    CREATE INDEX IF NOT EXISTS idx_number_pool_business ON number_pool(assigned_business_id);
  `);

  // Migration: explicit call-forwarding / AI agent target per Telnyx number.
  //
  // Telnyx forwards the business DID to the Dograh agent line, so Dograh often
  // only knows the *agent* line as `to_number` and the real DID arrives as
  // `forwarded_from`. Storing the target per number lets webhook ingestion
  // resolve the tenant from either side of that mapping. Existing rows keep
  // working: the column is nullable and defaults to NULL.
  const telephonyColumns = db.prepare('PRAGMA table_info(telephony_numbers)').all().map((column) => column.name);
  if (!telephonyColumns.includes('forwarding_target')) {
    db.exec('ALTER TABLE telephony_numbers ADD COLUMN forwarding_target TEXT');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_telephony_forwarding_target ON telephony_numbers(forwarding_target)');

  // Migration: when the call itself started (Dograh `started_at`). The call log
  // falls back to `created_at` (webhook receipt time) when it is not supplied.
  const leadColumns = db.prepare('PRAGMA table_info(leads)').all().map((column) => column.name);
  if (!leadColumns.includes('call_started_at')) {
    db.exec('ALTER TABLE leads ADD COLUMN call_started_at TEXT');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads(created_at)');

  // Migration: billing email used to prefill Dodo checkout on existing DBs.
  const plumberColumns = db.prepare('PRAGMA table_info(plumbers)').all().map((column) => column.name);
  if (!plumberColumns.includes('email')) {
    db.exec('ALTER TABLE plumbers ADD COLUMN email TEXT');
  }

  // Migration: supervision fields used by /admin (plan, minutes, enable/disable).
  const supervisionColumns = {
    is_enabled: 'INTEGER NOT NULL DEFAULT 1',
    plan_type: "TEXT NOT NULL DEFAULT 'trial'",
    subscription_status: "TEXT NOT NULL DEFAULT 'trialing'",
    minutes_included: 'INTEGER NOT NULL DEFAULT 30',
    minutes_used: 'INTEGER NOT NULL DEFAULT 0',
    trial_ends_at: 'TEXT',
  };
  const addedSupervisionColumns = [];
  for (const [name, definition] of Object.entries(supervisionColumns)) {
    if (!plumberColumns.includes(name)) {
      db.exec(`ALTER TABLE plumbers ADD COLUMN ${name} ${definition}`);
      addedSupervisionColumns.push(name);
    }
  }
  if (addedSupervisionColumns.length) {
    // Existing accounts inherit whatever the Dodo subscription already knows.
    db.exec(`
      UPDATE plumbers SET
        minutes_included = COALESCE((SELECT s.included_minutes FROM subscriptions s WHERE s.plumber_id = plumbers.id), minutes_included),
        minutes_used = COALESCE((SELECT s.used_minutes FROM subscriptions s WHERE s.plumber_id = plumbers.id), minutes_used),
        subscription_status = COALESCE((SELECT s.status FROM subscriptions s WHERE s.plumber_id = plumbers.id), subscription_status),
        plan_type = CASE
          WHEN (SELECT s.status FROM subscriptions s WHERE s.plumber_id = plumbers.id) = 'active' THEN 'solo'
          WHEN (SELECT s.status FROM subscriptions s WHERE s.plumber_id = plumbers.id) = 'trialing' THEN 'trial'
          ELSE plan_type
        END
      WHERE EXISTS (SELECT 1 FROM subscriptions s WHERE s.plumber_id = plumbers.id);
    `);
    // The seeded demo login keeps full-access demo supervision.
    db.exec(`UPDATE plumbers SET plan_type = 'demo', is_enabled = 1,
      minutes_included = CASE WHEN COALESCE(minutes_included, 0) < 300 THEN 300 ELSE minutes_included END,
      trial_ends_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '+3 days')
      WHERE id = 'plumber-austin-default'`);
    db.exec(`UPDATE plumbers SET trial_ends_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '+3 days')
      WHERE trial_ends_at IS NULL AND plan_type IN ('trial', 'demo')`);
  }

  function normalizePhone(phone) {
    if (!phone || typeof phone !== 'string') return '';
    const trimmed = phone.trim();
    if (trimmed.startsWith('+')) return '+' + trimmed.slice(1).replace(/\D/g, '');
    const digits = trimmed.replace(/\D/g, '');
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
    return digits ? `+${digits}` : '';
  }

  const E164_PATTERN = /^\+[1-9]\d{7,14}$/;

  // Returns a normalised E.164 number or null, so callers can tell "invalid"
  // apart from "not provided" (empty string).
  function toE164OrNull(value) {
    if (value === undefined || value === null) return null;
    const normalized = normalizePhone(String(value));
    return normalized && E164_PATTERN.test(normalized) ? normalized : null;
  }

  // Normalises provider timestamps (ISO strings, epoch seconds/millis) to the
  // same `YYYY-MM-DDTHH:MM:SSZ` shape as every other timestamp column, so the
  // call log can sort and render them reliably.
  function normalizeIsoTimestamp(value) {
    if (value === undefined || value === null) return null;
    const raw = String(value).trim();
    if (!raw) return null;
    let ms = NaN;
    if (/^\d{10}$/.test(raw)) ms = Number(raw) * 1000;
    else if (/^\d{13}$/.test(raw)) ms = Number(raw);
    else ms = Date.parse(raw);
    if (!Number.isFinite(ms)) return null;
    // Guard against garbage/clock skew: reject pre-2000 and far-future values.
    if (ms < Date.UTC(2000, 0, 1) || ms > Date.now() + 24 * 60 * 60 * 1000) return null;
    return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  // Human-readable talk time used by both call logs: "1m 24s", "54s", "0s".
  function formatCallDuration(seconds) {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    const mins = Math.floor(total / 60);
    const secs = total % 60;
    return mins ? `${mins}m ${String(secs).padStart(2, '0')}s` : `${secs}s`;
  }

  // -------------------------------------------------------------------------
  // Plan supervision helpers (trial caps, minutes left, enable/disable)
  // -------------------------------------------------------------------------
  const TRIAL_DAILY_LEAD_CAP = 5;
  const TRIAL_MINUTES = 30;
  const SOLO_MINUTES = 300;
  const TRIAL_LENGTH_DAYS = 3;

  function isoInDays(days) {
    return new Date(Date.now() + Number(days) * 24 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  // Single source of truth for how an account should be treated right now.
  function planSnapshot(plumber) {
    const planRaw = String((plumber && plumber.plan_type) || 'trial').toLowerCase();
    const statusRaw = String((plumber && plumber.subscription_status) || 'trialing').toLowerCase();
    const isPaid = planRaw === 'solo' || planRaw === 'paid' || statusRaw === 'active';
    const trialEndsMs = plumber && plumber.trial_ends_at ? Date.parse(plumber.trial_ends_at) : NaN;
    const trialEndsAt = Number.isFinite(trialEndsMs) ? new Date(trialEndsMs).toISOString() : null;
    const trialExpired = trialEndsAt !== null && trialEndsMs <= Date.now();
    const isTrial = !isPaid && planRaw !== 'demo';
    const includedMinutes = Number.isFinite(Number(plumber && plumber.minutes_included))
      ? Math.max(0, Math.round(Number(plumber.minutes_included)))
      : (isPaid ? SOLO_MINUTES : TRIAL_MINUTES);
    const usedMinutes = Math.max(0, Math.round(Number(plumber && plumber.minutes_used) || 0));
    return {
      plan_type: planRaw,
      subscription_status: statusRaw,
      is_paid: isPaid,
      is_trial: isTrial,
      is_demo: planRaw === 'demo',
      trial_ends_at: trialEndsAt,
      trial_expired: trialExpired,
      trial_days_left: trialEndsAt ? Math.max(0, Math.ceil((trialEndsMs - Date.now()) / (24 * 60 * 60 * 1000))) : null,
      daily_lead_limit: isTrial ? TRIAL_DAILY_LEAD_CAP : null,
      minutes_included: includedMinutes,
      minutes_used: usedMinutes,
      minutes_left: Math.max(0, includedMinutes - usedMinutes),
      is_enabled: Number(plumber && plumber.is_enabled) !== 0,
    };
  }

  function countLeadsToday(plumberId) {
    if (!plumberId) return 0;
    return Number(db.prepare(`SELECT COUNT(*) AS count FROM leads WHERE plumber_id = ? AND substr(created_at, 1, 10) = strftime('%Y-%m-%d', 'now')`).get(plumberId).count) || 0;
  }

  if (db.prepare('SELECT COUNT(*) AS count FROM plumbers').get().count === 0) {
    const pid = 'plumber-austin-default';
    db.prepare(`INSERT INTO plumbers (id, business_name, owner_name, owner_phone, established_line, avg_ticket_usd, service_area_note, is_enabled, plan_type, subscription_status, minutes_included, minutes_used, trial_ends_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'demo', 'trialing', ?, 14, ?)`)
      .run(pid, 'South Congress Plumbing Co.', 'Ramiro Garza', '+15125550148', '+15125550190', 520, 'Austin Metro (78704, 78745, 78701, 78758)', SOLO_MINUTES, isoInDays(TRIAL_LENGTH_DAYS));
    db.prepare(`INSERT INTO telephony_numbers (id, e164_number, provider, assigned_plumber_id, status) VALUES (?, ?, 'telnyx', ?, 'assigned')`)
      .run('telnyx-num-1', '+15125550199', pid);
    db.prepare(`INSERT INTO subscriptions (id, plumber_id, plan_code, status, included_minutes, used_minutes) VALUES (?, ?, 'solo_99', 'trialing', ?, 14)`)
      .run('sub-austin-default', pid, SOLO_MINUTES);
    db.prepare(`INSERT INTO leads (id, plumber_id, telephony_number_id, caller_phone, caller_name, urgency, status, zip_code, issue_summary, estimated_value_usd, duration_seconds) VALUES (?, ?, 'telnyx-num-1', '+15125550172', 'Hannah Miller', 'emergency', 'ready', '78704', 'Under-sink supply line spraying water in kitchen', 520, 48)`)
      .run('lead-seed-1', pid);
  }

  // -------------------------------------------------------------------------
  // One-time number pool seed: existing telephony inventory becomes pool rows so
  // /admin starts with a truthful picture. Guarded by app_meta so numbers an
  // admin deliberately deletes are not resurrected on the next restart.
  // -------------------------------------------------------------------------
  const poolSeeded = db.prepare("SELECT value FROM app_meta WHERE key = 'number_pool_seed_v1'").get();
  if (!poolSeeded) {
    const insertPool = db.prepare(`INSERT OR IGNORE INTO number_pool
      (phone_number, friendly_label, area_code, status, assigned_business_id, notes, created_at, assigned_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const row of db.prepare('SELECT * FROM telephony_numbers').all()) {
      const normalized = normalizePhone(row.e164_number);
      if (!normalized) continue;
      const mappedStatus = row.status === 'assigned' && row.assigned_plumber_id
        ? 'assigned'
        : row.status === 'maintenance' ? 'disabled' : 'available';
      const stamp = row.created_at || new Date().toISOString();
      insertPool.run(normalized, null, extractAreaCode(normalized), mappedStatus,
        mappedStatus === 'assigned' ? row.assigned_plumber_id : null,
        'Imported from existing telephony inventory', stamp,
        mappedStatus === 'assigned' ? stamp : null);
    }
    db.prepare("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('number_pool_seed_v1', ?)")
      .run(new Date().toISOString());
  }
  // Self-heal: a pool row whose business was deleted returns to the pool.
  db.exec(`UPDATE number_pool SET status = 'available', assigned_business_id = NULL, assigned_at = NULL
    WHERE status = 'assigned' AND (assigned_business_id IS NULL OR assigned_business_id NOT IN (SELECT id FROM plumbers))`);

  // A plumber has exactly one primary Telnyx number at a time: the most
  // recently assigned one. `tn.id DESC` breaks timestamp ties deterministically
  // instead of letting the query planner return the seeded row first.
  // Subscription columns are aliased so the plumbers supervision columns
  // (plan_type / minutes_* / is_enabled) stay authoritative.
  const PLUMBER_SELECT = `
    SELECT p.*, tn.e164_number AS telnyx_number, tn.id AS telephony_number_id,
      s.status AS dodo_status, s.plan_code,
      s.included_minutes AS subscription_included_minutes, s.used_minutes AS subscription_used_minutes
    FROM plumbers p
    LEFT JOIN telephony_numbers tn ON tn.id = (
      SELECT tn2.id FROM telephony_numbers tn2
      WHERE tn2.assigned_plumber_id = p.id AND tn2.status = 'assigned'
      ORDER BY tn2.created_at DESC, tn2.id DESC LIMIT 1
    )
    LEFT JOIN subscriptions s ON s.plumber_id = p.id
  `;

  function getDefaultPlumber() {
    return db.prepare(PLUMBER_SELECT + ' WHERE p.active = 1 ORDER BY p.created_at ASC LIMIT 1').get();
  }

  function getPlumberById(plumberId) {
    if (!plumberId) return null;
    return db.prepare(PLUMBER_SELECT + ' WHERE p.id = ? AND p.active = 1').get(plumberId) || null;
  }

  // Tenant resolution for inbound AI calls.
  //
  // A Telnyx DID (the number the customer actually dialled) is forwarded to the
  // Dograh agent line, so Dograh reports the *agent* line as `to_number` and the
  // real DID as `forwarded_from`. The lookup therefore accepts both directions
  // of the mapping, in this priority order:
  //   1. assigned number == forwarded_from
  //   2. assigned number == to_number
  //   3. assigned number whose forwarding_target == to_number
  //   4. explicit business_id / plumber_id from the payload or metadata
  //   5. getDefaultPlumber() as a last resort
  // Only `status = 'assigned'` numbers with an active business match steps 1-3.
  // Disabled businesses (is_enabled = 0) still resolve on purpose, so
  // createOrUpdateLead() can answer `business_disabled` instead of silently
  // billing whichever tenant happens to be the default.
  function matchAssignedNumber(column, value) {
    if (!value) return null;
    return db.prepare(`
      SELECT tn.id AS telephony_number_id, tn.assigned_plumber_id AS plumber_id
      FROM telephony_numbers tn JOIN plumbers p ON p.id = tn.assigned_plumber_id
      WHERE tn.status = 'assigned' AND p.active = 1 AND ${column} = ?
      ORDER BY tn.created_at DESC, tn.id DESC LIMIT 1
    `).get(value) || null;
  }

  function resolvePlumberForCall({ forwardedFrom, toNumber, businessId } = {}) {
    const forwarded = toE164OrNull(forwardedFrom);
    const to = toE164OrNull(toNumber);
    let match = null;
    let matchedBy = null;

    if (forwarded) {
      match = matchAssignedNumber('tn.e164_number', forwarded);
      if (match) matchedBy = 'forwarded_from';
    }
    if (!match && to) {
      match = matchAssignedNumber('tn.e164_number', to);
      if (match) matchedBy = 'to_number';
    }
    if (!match && to) {
      match = matchAssignedNumber('tn.forwarding_target', to);
      if (match) matchedBy = 'forwarding_target';
    }
    if (match) {
      const plumber = getPlumberById(match.plumber_id);
      if (plumber) return { plumber, matchedBy, matchedNumberId: match.telephony_number_id };
    }

    const explicitId = businessId === undefined || businessId === null ? '' : String(businessId).trim();
    if (explicitId) {
      const explicit = getPlumberById(explicitId);
      if (explicit) return { plumber: explicit, matchedBy: 'business_id', matchedNumberId: explicit.telephony_number_id || null };
    }

    const fallback = getDefaultPlumber() || null;
    return {
      plumber: fallback,
      matchedBy: fallback ? 'default' : null,
      matchedNumberId: fallback ? fallback.telephony_number_id || null : null,
    };
  }

  // Backwards-compatible single-number lookup (kept for existing callers/tests).
  function findPlumberByTelnyxNumber(telnyxNumber) {
    return resolvePlumberForCall({ toNumber: telnyxNumber }).plumber;
  }

  // Makes `telnyxNumber` the plumber's single primary number: every other
  // number still assigned to this plumber is released back to the available
  // pool first, so getDefaultPlumber() cannot keep returning a stale number.
  const assignTelephonyNumberToPlumber = db.transaction(({ plumberId, telnyxNumber }) => {
    const normalized = normalizePhone(telnyxNumber);
    if (!normalized) return { ok: false, reason: 'invalid_phone_number' };
    const released = db.prepare(`
      UPDATE telephony_numbers SET assigned_plumber_id = NULL, status = 'available', forwarding_target = NULL
      WHERE assigned_plumber_id = ? AND e164_number <> ? AND status = 'assigned'
    `).run(plumberId, normalized).changes;
    const existing = db.prepare('SELECT id FROM telephony_numbers WHERE e164_number = ?').get(normalized);
    let numberId;
    if (existing) {
      numberId = existing.id;
      db.prepare(`UPDATE telephony_numbers SET assigned_plumber_id = ?, status = 'assigned' WHERE id = ?`).run(plumberId, numberId);
    } else {
      numberId = crypto.randomUUID();
      db.prepare(`INSERT INTO telephony_numbers (id, e164_number, provider, assigned_plumber_id, status) VALUES (?, ?, 'telnyx', ?, 'assigned')`).run(numberId, normalized, plumberId);
    }
    return { ok: true, numberId, e164Number: normalized, releasedCount: released };
  });

  // -------------------------------------------------------------------------
  // Telnyx number pool (pre-purchased numbers for instant forwarding)
  //
  // Pool assignment mirrors into `telephony_numbers`, which is the row that
  // /app reads (plumber.telnyx_number) — so the AI agent + onboarding wizard
  // show the real number immediately after claim/assign/release.
  // -------------------------------------------------------------------------
  const POOL_STATUSES = ['available', 'assigned', 'disabled'];

  function poolTimestamp() {
    return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  function extractAreaCode(phoneNumber) {
    const digits = String(normalizePhone(phoneNumber) || phoneNumber || '').replace(/\D/g, '');
    if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1, 4);
    return digits.slice(0, 3);
  }

  function formatPhoneNumber(value) {
    const normalized = normalizePhone(value) || String(value || '').trim();
    const digits = normalized.replace(/\D/g, '');
    if (digits.length === 11 && digits.startsWith('1')) {
      return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
    }
    return normalized;
  }

  function parseNumberList(input) {
    const entries = Array.isArray(input) ? input : [input];
    const numbers = [];
    for (const entry of entries) {
      String(entry === undefined || entry === null ? '' : entry).split(/[\r\n,;]+/).forEach((chunk) => {
        const trimmed = chunk.trim();
        if (!trimmed) return;
        // "+15125550194 +15125550195" on one line = two numbers.
        if ((trimmed.match(/\+/g) || []).length > 1) {
          trimmed.split(/\s+/).filter(Boolean).forEach((piece) => numbers.push(piece));
        } else {
          numbers.push(trimmed);
        }
      });
    }
    return numbers;
  }

  function decoratePoolNumber(row) {
    if (!row) return null;
    return {
      id: Number(row.id),
      phone_number: row.phone_number,
      display_number: formatPhoneNumber(row.phone_number),
      friendly_label: row.friendly_label || null,
      area_code: row.area_code || extractAreaCode(row.phone_number),
      status: POOL_STATUSES.includes(row.status) ? row.status : 'available',
      forwarding_target: row.forwarding_target || null,
      assigned_business_id: row.assigned_business_id || null,
      assigned_business_name: row.business_name || null,
      assigned_business_email: row.owner_email || row.business_email || null,
      notes: row.notes || null,
      created_at: row.created_at || null,
      assigned_at: row.assigned_at || null,
    };
  }

  function getPoolNumber(poolId) {
    const row = db.prepare(`
      SELECT np.*, p.business_name AS business_name, p.email AS business_email, su.email AS owner_email,
        tn.forwarding_target AS forwarding_target
      FROM number_pool np
      LEFT JOIN plumbers p ON p.id = np.assigned_business_id
      LEFT JOIN shop_users su ON su.plumber_id = p.id
      LEFT JOIN telephony_numbers tn ON tn.e164_number = np.phone_number
      WHERE np.id = ?
    `).get(poolId);
    return decoratePoolNumber(row);
  }

  function listNumberPool() {
    const rows = db.prepare(`
      SELECT np.*, p.business_name AS business_name, p.email AS business_email, su.email AS owner_email,
        tn.forwarding_target AS forwarding_target
      FROM number_pool np
      LEFT JOIN plumbers p ON p.id = np.assigned_business_id
      LEFT JOIN shop_users su ON su.plumber_id = p.id
      LEFT JOIN telephony_numbers tn ON tn.e164_number = np.phone_number
      ORDER BY CASE np.status WHEN 'available' THEN 0 WHEN 'assigned' THEN 1 ELSE 2 END, np.id ASC
    `).all();
    const numbers = rows.map(decoratePoolNumber);
    const counts = {
      total: numbers.length,
      available: numbers.filter((number) => number.status === 'available').length,
      assigned: numbers.filter((number) => number.status === 'assigned').length,
      disabled: numbers.filter((number) => number.status === 'disabled').length,
    };
    return { numbers, counts };
  }

  const addPoolNumbers = db.transaction(({ numbers, friendlyLabel, notes } = {}) => {
    const candidates = parseNumberList(numbers);
    const added = [];
    const skipped = [];
    const seen = new Set();
    for (const raw of candidates) {
      const normalized = normalizePhone(raw);
      if (!normalized || !/^\+[1-9]\d{7,14}$/.test(normalized)) {
        skipped.push({ value: raw, reason: 'invalid_number' });
        continue;
      }
      if (seen.has(normalized)) {
        skipped.push({ value: normalized, reason: 'duplicate_in_request' });
        continue;
      }
      seen.add(normalized);
      if (db.prepare('SELECT id FROM number_pool WHERE phone_number = ?').get(normalized)) {
        skipped.push({ value: normalized, reason: 'already_in_pool' });
        continue;
      }
      // If Telnyx already routes this number to a business, mirror that truth.
      const live = db.prepare(`SELECT * FROM telephony_numbers WHERE e164_number = ? AND status = 'assigned'`).get(normalized);
      const status = live && live.assigned_plumber_id ? 'assigned' : 'available';
      const info = db.prepare(`INSERT INTO number_pool
        (phone_number, friendly_label, area_code, status, assigned_business_id, notes, assigned_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(normalized, friendlyLabel || null, extractAreaCode(normalized), status,
          status === 'assigned' ? live.assigned_plumber_id : null,
          notes || null, status === 'assigned' ? poolTimestamp() : null);
      added.push(Number(info.lastInsertRowid));
    }
    const { counts } = listNumberPool();
    return {
      ok: added.length > 0,
      added: added.map((id) => getPoolNumber(id)).filter(Boolean),
      skipped,
      counts,
    };
  });

  // Keeps number_pool, telephony_numbers and the plumber row in sync.
  function assignPoolNumberRecord(poolId, businessId, forwardingTarget) {
    const pool = db.prepare('SELECT * FROM number_pool WHERE id = ?').get(poolId);
    if (!pool) return { ok: false, reason: 'number_not_found' };
    const business = db.prepare('SELECT * FROM plumbers WHERE id = ?').get(businessId);
    if (!business) return { ok: false, reason: 'business_not_found' };
    if (pool.status === 'disabled') return { ok: false, reason: 'number_disabled' };
    // Optional AI agent / forwarding target — validated before anything mutates
    // so a typo can never leave a half-configured number behind.
    const targetProvided = forwardingTarget !== undefined;
    const targetRaw = forwardingTarget === undefined || forwardingTarget === null ? '' : String(forwardingTarget).trim();
    const target = targetRaw ? toE164OrNull(targetRaw) : null;
    if (targetRaw && !target) return { ok: false, reason: 'invalid_forwarding_target' };
    if (pool.status === 'assigned' && pool.assigned_business_id !== businessId) {
      return { ok: false, reason: 'number_already_assigned' };
    }
    // A business only holds one pool number: release the previous one first.
    const releasedPoolNumbers = db.prepare(`
      UPDATE number_pool SET status = 'available', assigned_business_id = NULL, assigned_at = NULL
      WHERE assigned_business_id = ? AND id <> ?
    `).run(businessId, poolId).changes;

    db.prepare(`UPDATE number_pool SET status = 'assigned', assigned_business_id = ?, assigned_at = ?,
      area_code = COALESCE(NULLIF(area_code, ''), ?) WHERE id = ?`)
      .run(businessId, poolTimestamp(), extractAreaCode(pool.phone_number), poolId);

    const synced = assignTelephonyNumberToPlumber({ plumberId: businessId, telnyxNumber: pool.phone_number });
    if (!synced.ok) {
      db.prepare(`UPDATE number_pool SET status = 'available', assigned_business_id = NULL, assigned_at = NULL WHERE id = ?`).run(poolId);
      return { ok: false, reason: synced.reason || 'sync_failed' };
    }
    if (targetProvided) {
      db.prepare('UPDATE telephony_numbers SET forwarding_target = ? WHERE e164_number = ?').run(target, pool.phone_number);
    }
    return {
      ok: true,
      number: getPoolNumber(poolId),
      business: { id: business.id, business_name: business.business_name, email: business.email || null },
      released_pool_numbers: releasedPoolNumbers,
      telephony_number: synced.e164Number,
      forwarding_target: targetProvided ? target : (getPoolNumber(poolId)?.forwarding_target || null),
    };
  }

  const assignPoolNumberToBusiness = db.transaction(({ poolId, businessId, forwardingTarget }) =>
    assignPoolNumberRecord(poolId, businessId, forwardingTarget));

  // Stores (or clears) the AI agent / forwarding target for a pool number.
  //
  // The value lives on `telephony_numbers` because that is the row webhook
  // ingestion resolves against. An available number may not have a telephony
  // row yet, so a placeholder 'available' row is created on demand — it stays
  // invisible to tenant resolution until the number is actually assigned.
  const setPoolNumberForwardingTarget = db.transaction(({ poolId, forwardingTarget }) => {
    const pool = db.prepare('SELECT * FROM number_pool WHERE id = ?').get(poolId);
    if (!pool) return { ok: false, reason: 'number_not_found' };
    const raw = forwardingTarget === undefined || forwardingTarget === null ? '' : String(forwardingTarget).trim();
    const normalized = raw ? toE164OrNull(raw) : null;
    if (raw && !normalized) return { ok: false, reason: 'invalid_forwarding_target' };

    const existing = db.prepare('SELECT id FROM telephony_numbers WHERE e164_number = ?').get(pool.phone_number);
    if (existing) {
      db.prepare('UPDATE telephony_numbers SET forwarding_target = ? WHERE id = ?').run(normalized, existing.id);
    } else {
      db.prepare(`INSERT INTO telephony_numbers (id, e164_number, provider, assigned_plumber_id, status, forwarding_target)
        VALUES (?, ?, 'telnyx', NULL, 'available', ?)`).run(crypto.randomUUID(), pool.phone_number, normalized);
    }
    return {
      ok: true,
      number: getPoolNumber(poolId),
      forwarding_target: normalized,
      message: normalized
        ? `${formatPhoneNumber(pool.phone_number)} forwards to ${formatPhoneNumber(normalized)}.`
        : `Forwarding target cleared for ${formatPhoneNumber(pool.phone_number)}.`,
    };
  });

  // Auto-claim used by createTrialShop: first available number in id order.
  function claimNextPoolNumber(businessId) {
    const next = db.prepare(`SELECT * FROM number_pool WHERE status = 'available' ORDER BY id ASC LIMIT 1`).get();
    if (!next) return { ok: false, reason: 'pool_empty', counts: listNumberPool().counts };
    return assignPoolNumberRecord(next.id, businessId);
  }

  const releasePoolNumber = db.transaction((poolId) => {
    const pool = db.prepare('SELECT * FROM number_pool WHERE id = ?').get(poolId);
    if (!pool) return { ok: false, reason: 'number_not_found' };
    if (pool.status !== 'assigned' || !pool.assigned_business_id) {
      return { ok: false, reason: 'number_not_assigned' };
    }
    const businessId = pool.assigned_business_id;
    db.prepare(`UPDATE number_pool SET status = 'available', assigned_business_id = NULL, assigned_at = NULL WHERE id = ?`).run(poolId);
    // /app reads telephony_numbers, so clear the business's forwarding number
    // and its AI target (a stale target must never outlive the assignment).
    db.prepare(`UPDATE telephony_numbers SET assigned_plumber_id = NULL, status = 'available', forwarding_target = NULL
      WHERE e164_number = ? AND assigned_plumber_id = ?`).run(pool.phone_number, businessId);
    return {
      ok: true,
      number: getPoolNumber(poolId),
      business_id: businessId,
      message: `${formatPhoneNumber(pool.phone_number)} released back to the available pool.`,
    };
  });

  const togglePoolNumber = db.transaction((poolId) => {
    const pool = db.prepare('SELECT * FROM number_pool WHERE id = ?').get(poolId);
    if (!pool) return { ok: false, reason: 'number_not_found' };
    if (pool.status === 'assigned' || pool.assigned_business_id) {
      return { ok: false, reason: 'release_first' };
    }
    const next = pool.status === 'disabled' ? 'available' : 'disabled';
    db.prepare('UPDATE number_pool SET status = ? WHERE id = ?').run(next, poolId);
    return {
      ok: true,
      number: getPoolNumber(poolId),
      message: next === 'disabled' ? 'Number disabled — it will not be auto-assigned.' : 'Number enabled — available for assignment.',
    };
  });

  const deletePoolNumber = db.transaction((poolId) => {
    const pool = db.prepare('SELECT * FROM number_pool WHERE id = ?').get(poolId);
    if (!pool) return { ok: false, reason: 'number_not_found' };
    if (pool.status === 'assigned' || pool.assigned_business_id) {
      return { ok: false, reason: 'release_first' };
    }
    db.prepare('DELETE FROM number_pool WHERE id = ?').run(poolId);
    return { ok: true, deleted_id: Number(poolId), counts: listNumberPool().counts };
  });

  function getPlumberSubscription(plumberId) {
    return db.prepare('SELECT * FROM subscriptions WHERE plumber_id = ?').get(plumberId) || null;
  }

  function findPlumberForDodo({ plumberId, dodoSubscriptionId, dodoCustomerId }) {
    if (plumberId) { const r = db.prepare('SELECT * FROM plumbers WHERE id = ?').get(plumberId); if (r) return r; }
    if (dodoSubscriptionId) { const s = db.prepare('SELECT plumber_id FROM subscriptions WHERE dodo_subscription_id = ?').get(dodoSubscriptionId); if (s) return db.prepare('SELECT * FROM plumbers WHERE id = ?').get(s.plumber_id); }
    if (dodoCustomerId) { const s = db.prepare('SELECT plumber_id FROM subscriptions WHERE dodo_customer_id = ?').get(dodoCustomerId); if (s) return db.prepare('SELECT * FROM plumbers WHERE id = ?').get(s.plumber_id); }
    return getDefaultPlumber();
  }

  function recordWebhookEventOnce({ source, externalEventId, eventType, payload }) {
    const info = db.prepare(`INSERT OR IGNORE INTO webhook_events (id, source, external_event_id, event_type, payload_json) VALUES (?, ?, ?, ?, ?)`)
      .run(crypto.randomUUID(), source, externalEventId, eventType, JSON.stringify(payload ?? {}));
    return info.changes > 0;
  }

  function markWebhookProcessed(externalEventId, errorMessage = null) {
    db.prepare(`UPDATE webhook_events SET processed = ?, error_message = ?, processed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE external_event_id = ?`)
      .run(errorMessage ? 0 : 1, errorMessage, externalEventId);
  }

  const createOrUpdateLead = db.transaction((input) => {
    // Resolve the tenant from the real DID (`forwarded_from`), the dialled
    // number, the configured AI target, an explicit business id, or the default
    // account — in that order. Unmatched calls keep the previous behaviour.
    const resolution = resolvePlumberForCall({
      forwardedFrom: input.forwardedFrom,
      toNumber: input.telnyxNumber,
      businessId: input.businessId,
    });
    const plumber = resolution.plumber;
    if (!plumber) return { ok: false, reason: 'no_active_plumber' };
    // Disabled businesses never capture new calls, even if Telnyx keeps
    // delivering them (admin toggle in /admin).
    if (Number(plumber.is_enabled) === 0) {
      return {
        ok: false,
        reason: 'business_disabled',
        message: 'This business is disabled. Re-enable it in the admin dashboard to capture calls.',
      };
    }
    const callerLabel = input.callerLabel ? String(input.callerLabel).trim().slice(0, 64) : null;
    const callerPhone = normalizePhone(input.callerPhone) || callerLabel || '+15125550199';
    const callId = input.externalCallId ? String(input.externalCallId).trim() : null;
    const urgency = ['emergency', 'standard'].includes(input.urgency) ? input.urgency : 'unknown';
    const zipCode = input.zipCode ? String(input.zipCode).trim().slice(0, 10) : null;
    const streetAddress = input.streetAddress ? String(input.streetAddress).trim().slice(0, 200) : null;
    const issueSummary = input.issueSummary ? String(input.issueSummary).trim().slice(0, 500) : null;
    const callerName = input.callerName ? String(input.callerName).trim().slice(0, 120) : null;
    const durationSeconds = Number.isFinite(Number(input.durationSeconds)) ? Math.max(0, Math.round(Number(input.durationSeconds))) : 0;
    // When the call started (Dograh `started_at`); NULL means "use created_at".
    const callStartedAt = normalizeIsoTimestamp(input.startedAt);
    const existing = callId ? db.prepare('SELECT * FROM leads WHERE external_call_id = ?').get(callId) : null;

    let leadId;
    if (existing) {
      leadId = existing.id;
      db.prepare(`
        UPDATE leads SET caller_phone = COALESCE(NULLIF(?, ''), caller_phone), caller_name = COALESCE(?, caller_name),
          urgency = CASE WHEN ? != 'unknown' THEN ? ELSE urgency END,
          status = CASE WHEN status IN ('called', 'booked', 'closed_lost') THEN status WHEN COALESCE(?, issue_summary) IS NOT NULL OR COALESCE(?, zip_code) IS NOT NULL THEN 'ready' ELSE 'triaging' END,
          zip_code = COALESCE(?, zip_code), street_address = COALESCE(?, street_address), issue_summary = COALESCE(?, issue_summary),
          estimated_value_usd = COALESCE(estimated_value_usd, ?), duration_seconds = MAX(duration_seconds, ?),
          call_started_at = COALESCE(call_started_at, ?),
          updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?
      `).run(callerPhone, callerName, urgency, urgency, issueSummary, zipCode, zipCode, streetAddress, issueSummary, plumber.avg_ticket_usd, durationSeconds, callStartedAt, leadId);
    } else {
      // Trial accounts (including expired trials) are capped at 5 new leads
      // per UTC day. Existing-call updates above are still allowed.
      const plan = planSnapshot(plumber);
      if (plan.is_trial) {
        const leadsToday = countLeadsToday(plumber.id);
        if (leadsToday >= TRIAL_DAILY_LEAD_CAP) {
          return {
            ok: false,
            reason: 'trial_daily_lead_cap_reached',
            limit: TRIAL_DAILY_LEAD_CAP,
            used: leadsToday,
            plan_type: plan.plan_type,
            trial_ends_at: plan.trial_ends_at,
            message: `Trial limit reached — ${TRIAL_DAILY_LEAD_CAP} leads per day. Upgrade to Solo for unlimited daily leads.`,
          };
        }
      }
      leadId = crypto.randomUUID();
      const initialStatus = issueSummary || zipCode ? 'ready' : 'triaging';
      db.prepare(`
        INSERT INTO leads (id, plumber_id, telephony_number_id, caller_phone, caller_name, external_call_id, urgency, status, zip_code, street_address, issue_summary, estimated_value_usd, duration_seconds, call_started_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(leadId, plumber.id, resolution.matchedNumberId || plumber.telephony_number_id || null, callerPhone, callerName, callId, urgency, initialStatus, zipCode, streetAddress, issueSummary, plumber.avg_ticket_usd, durationSeconds, callStartedAt);
    }

    if (input.transcript || input.structuredJson || input.eventId) {
      db.prepare(`INSERT OR IGNORE INTO ai_call_logs (id, lead_id, plumber_id, external_event_id, transcript, structured_json) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(crypto.randomUUID(), leadId, plumber.id, input.eventId || null, input.transcript || null, input.structuredJson ? JSON.stringify(input.structuredJson) : null);
    }

    // Minutes are tracked on both tables: subscriptions for Dodo billing, and
    // plumbers for the /admin "Minutes Left" supervision column.
    const minutesAdded = Math.ceil(durationSeconds / 60);
    if (minutesAdded > 0) {
      db.prepare(`UPDATE subscriptions SET used_minutes = used_minutes + ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE plumber_id = ?`).run(minutesAdded, plumber.id);
      db.prepare(`UPDATE plumbers SET minutes_used = COALESCE(minutes_used, 0) + ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?`).run(minutesAdded, plumber.id);
    }

    return {
      ok: true,
      plumber,
      lead: db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId),
      plan: planSnapshot(plumber),
      matched_by: resolution.matchedBy,
      matched_number_id: resolution.matchedNumberId || null,
    };
  });

  // -------------------------------------------------------------------------
  // Unified call log (shared by /app and /admin)
  //
  // One row per captured call: when it happened, how long it lasted, which
  // business/number answered it, who called and how it ended. Timestamps use
  // `call_started_at` when Dograh sent one, otherwise the webhook receipt time.
  // -------------------------------------------------------------------------
  const LEAD_STATUS_LABELS = {
    new: 'New',
    triaging: 'Triaging',
    ready: 'Ready to call',
    called: 'Called',
    booked: 'Booked',
    closed_lost: 'Archived',
  };

  function listCallLog({ plumberId = null, businessId = null, limit = 100 } = {}) {
    const safeLimit = Math.min(500, Math.max(1, Math.round(Number(limit) || 100)));
    const filters = [];
    const params = [];
    if (plumberId) { filters.push('l.plumber_id = ?'); params.push(plumberId); }
    if (businessId) { filters.push('l.plumber_id = ?'); params.push(businessId); }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const rows = db.prepare(`
      SELECT l.id AS lead_id, l.plumber_id, l.caller_phone, l.caller_name, l.urgency, l.status,
        l.issue_summary, l.zip_code, l.duration_seconds, l.call_started_at, l.created_at, l.updated_at,
        p.business_name, tn.e164_number AS number,
        (SELECT COUNT(*) FROM ai_call_logs acl WHERE acl.lead_id = l.id) AS call_log_entries
      FROM leads l
      JOIN plumbers p ON p.id = l.plumber_id
      LEFT JOIN telephony_numbers tn ON tn.id = l.telephony_number_id
      ${where}
      ORDER BY COALESCE(l.call_started_at, l.created_at) DESC, l.created_at DESC
      LIMIT ?
    `).all(...params, safeLimit);

    return rows.map((row) => {
      const key = LEAD_STATUS_LABELS[row.status] ? row.status : 'new';
      const urgency = row.urgency || 'unknown';
      return {
        lead_id: row.lead_id,
        plumber_id: row.plumber_id,
        business_name: row.business_name || null,
        number: row.number || null,
        caller_phone: row.caller_phone || null,
        caller_name: row.caller_name || null,
        urgency,
        status: row.status || 'new',
        status_label: LEAD_STATUS_LABELS[key],
        outcome: LEAD_STATUS_LABELS[key] + (urgency === 'emergency' ? ' · emergency' : ''),
        issue_summary: row.issue_summary || null,
        zip_code: row.zip_code || null,
        duration_seconds: Math.max(0, Math.round(Number(row.duration_seconds) || 0)),
        duration_label: formatCallDuration(row.duration_seconds),
        occurred_at: row.call_started_at || row.created_at || null,
        call_started_at: row.call_started_at || null,
        created_at: row.created_at || null,
        updated_at: row.updated_at || null,
        has_call_record: Number(row.call_log_entries) > 0,
      };
    });
  }

  function savePushSubscription({ plumberId, endpoint, p256dh, auth, deviceLabel }) {
    db.prepare(`
      INSERT INTO push_subscriptions (id, plumber_id, endpoint, p256dh, auth, device_label, is_active) VALUES (?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(endpoint) DO UPDATE SET plumber_id = excluded.plumber_id, p256dh = excluded.p256dh, auth = excluded.auth, device_label = COALESCE(excluded.device_label, push_subscriptions.device_label), is_active = 1
    `).run(crypto.randomUUID(), plumberId, endpoint, p256dh, auth, deviceLabel || 'Browser Device');
    return db.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?').get(endpoint);
  }

  function deactivatePushEndpoint(endpoint) {
    db.prepare('UPDATE push_subscriptions SET is_active = 0 WHERE endpoint = ?').run(endpoint);
  }

  function listActivePushSubscriptions(plumberId) {
    return db.prepare('SELECT * FROM push_subscriptions WHERE plumber_id = ? AND is_active = 1').all(plumberId);
  }

  function markPushSent(endpoint) {
    db.prepare(`UPDATE push_subscriptions SET last_pushed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE endpoint = ?`).run(endpoint);
  }

  function upsertDodoSubscription({ plumberId, dodoCustomerId, dodoSubscriptionId, planCode, status, includedMinutes, currentPeriodEnd }) {
    const existing = db.prepare('SELECT * FROM subscriptions WHERE plumber_id = ?').get(plumberId);
    if (existing) {
      db.prepare(`
        UPDATE subscriptions SET dodo_customer_id = COALESCE(?, dodo_customer_id), dodo_subscription_id = COALESCE(?, dodo_subscription_id),
          plan_code = COALESCE(?, plan_code), status = ?, included_minutes = COALESCE(?, included_minutes),
          current_period_end = COALESCE(?, current_period_end), updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE plumber_id = ?
      `).run(dodoCustomerId || null, dodoSubscriptionId || null, planCode || null, status, includedMinutes ?? null, currentPeriodEnd || null, plumberId);
    } else {
      db.prepare(`
        INSERT INTO subscriptions (id, plumber_id, dodo_customer_id, dodo_subscription_id, plan_code, status, included_minutes, current_period_end)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(crypto.randomUUID(), plumberId, dodoCustomerId || null, dodoSubscriptionId || null, planCode || 'solo_99', status, includedMinutes ?? SOLO_MINUTES, currentPeriodEnd || null);
    }

    // Mirror billing state onto the plumber row so /admin supervision and
    // /api/billing/status always agree on plan, status and Minutes Left.
    const plumber = db.prepare('SELECT * FROM plumbers WHERE id = ?').get(plumberId);
    if (plumber) {
      const nextPlan = status === 'active' ? 'solo' : (plumber.plan_type || 'trial');
      let nextIncluded = Number.isFinite(Number(plumber.minutes_included)) ? Number(plumber.minutes_included) : null;
      if (includedMinutes !== null && includedMinutes !== undefined && Number.isFinite(Number(includedMinutes))) {
        nextIncluded = Math.max(0, Math.round(Number(includedMinutes)));
      } else if (nextPlan === 'solo' && (nextIncluded === null || nextIncluded < SOLO_MINUTES)) {
        nextIncluded = SOLO_MINUTES;
      }
      db.prepare(`UPDATE plumbers SET plan_type = ?, subscription_status = ?, minutes_included = COALESCE(?, minutes_included),
        updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?`)
        .run(nextPlan, status, nextIncluded, plumberId);
      // Keep the Dodo subscription row aligned with the supervised allowance so
      // /api/billing/status and /admin never disagree about Minutes Left.
      if (nextIncluded !== null) {
        db.prepare(`UPDATE subscriptions SET included_minutes = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE plumber_id = ?`)
          .run(nextIncluded, plumberId);
      }
    }
    return db.prepare('SELECT * FROM subscriptions WHERE plumber_id = ?').get(plumberId);
  }

  function getUserByEmail(email) {
    const normalized = String(email || '').trim().toLowerCase();
    if (!normalized) return null;
    return db.prepare('SELECT * FROM shop_users WHERE email = ? COLLATE NOCASE').get(normalized) || null;
  }

  function createShopUser({ plumberId, email, passwordHash, passwordSalt }) {
    const id = crypto.randomUUID();
    db.prepare(`INSERT INTO shop_users (id, plumber_id, email, password_hash, password_salt) VALUES (?, ?, ?, ?, ?)`)
      .run(id, plumberId, String(email).trim().toLowerCase(), passwordHash, passwordSalt);
    return db.prepare('SELECT * FROM shop_users WHERE id = ?').get(id);
  }

  function setUserLastLogin(userId) {
    db.prepare(`UPDATE shop_users SET last_login_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?`).run(userId);
  }

  const createTrialShop = db.transaction(({ businessName, ownerName, email, ownerPhone, passwordHash, passwordSalt, serviceArea }) => {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (db.prepare('SELECT 1 FROM shop_users WHERE email = ? COLLATE NOCASE').get(normalizedEmail)) {
      return { ok: false, reason: 'email_in_use' };
    }

    const plumberId = crypto.randomUUID();
    db.prepare(`INSERT INTO plumbers (id, business_name, owner_name, email, owner_phone, avg_ticket_usd, service_area_note,
        is_enabled, plan_type, subscription_status, minutes_included, minutes_used, trial_ends_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'trial', 'trialing', ?, 0, ?)`)
      .run(plumberId, String(businessName).trim(), String(ownerName).trim(), normalizedEmail, String(ownerPhone).trim(), 520,
        String(serviceArea || 'Austin Metro (78701-78759)').trim(), TRIAL_MINUTES, isoInDays(TRIAL_LENGTH_DAYS));

    // Claim a pre-purchased Telnyx number from the pool. Signup must never fail
    // because inventory ran out: fall back to a placeholder number, then to an
    // unassigned state (the admin can assign a real number later).
    let poolClaim = null;
    try {
      poolClaim = claimNextPoolNumber(plumberId);
    } catch (err) {
      console.warn(`[number-pool] auto-claim failed for ${plumberId}: ${err?.message || err}`);
      poolClaim = { ok: false, reason: 'claim_error' };
    }
    let numberSource = poolClaim && poolClaim.ok ? 'pool' : null;
    if (!numberSource) {
      for (let attempt = 0; attempt < 500; attempt += 1) {
        const candidate = `+1512555${crypto.randomInt(1000, 10000)}`;
        if (!db.prepare('SELECT 1 FROM telephony_numbers WHERE e164_number = ?').get(candidate)) {
          db.prepare(`INSERT INTO telephony_numbers (id, e164_number, provider, assigned_plumber_id, status)
            VALUES (?, ?, 'telnyx', ?, 'assigned')`)
            .run(crypto.randomUUID(), candidate, plumberId);
          numberSource = 'placeholder';
          break;
        }
      }
    }

    db.prepare(`INSERT INTO subscriptions (id, plumber_id, plan_code, status, included_minutes, used_minutes, current_period_end)
      VALUES (?, ?, 'trial_3day', 'trialing', ?, 0, ?)`)
      .run(crypto.randomUUID(), plumberId, TRIAL_MINUTES, isoInDays(TRIAL_LENGTH_DAYS));
    const userId = crypto.randomUUID();
    db.prepare(`INSERT INTO shop_users (id, plumber_id, email, password_hash, password_salt)
      VALUES (?, ?, ?, ?, ?)`)
      .run(userId, plumberId, normalizedEmail, passwordHash, passwordSalt);

    return {
      ok: true,
      user: db.prepare('SELECT * FROM shop_users WHERE id = ?').get(userId),
      plumber: getPlumberById(plumberId),
      pool_number: poolClaim && poolClaim.ok ? poolClaim.number : null,
      number_source: numberSource || 'unassigned',
    };
  });

  function createSession({ userId, plumberId, token, expiresAt }) {
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date().toISOString());
    db.prepare('INSERT INTO sessions (id, user_id, plumber_id, expires_at) VALUES (?, ?, ?, ?)')
      .run(token, userId, plumberId, expiresAt);
    return token;
  }

  function getSessionUser(token) {
    if (!token) return null;
    return db.prepare(`
      SELECT s.id AS session_id, s.user_id, s.plumber_id, s.expires_at,
        u.email, u.created_at AS user_created_at, u.last_login_at
      FROM sessions s
      JOIN shop_users u ON u.id = s.user_id
      JOIN plumbers p ON p.id = s.plumber_id
      WHERE s.id = ? AND s.expires_at > ? AND p.active = 1
      LIMIT 1
    `).get(token, new Date().toISOString()) || null;
  }

  function deleteSession(token) {
    if (token) db.prepare('DELETE FROM sessions WHERE id = ?').run(token);
  }

  function deleteExpiredSessions() {
    return db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date().toISOString()).changes;
  }

  // -------------------------------------------------------------------------
  // Super-admin supervision (all accounts, KPIs, enable/disable, minutes)
  // -------------------------------------------------------------------------
  const ADMIN_ACCOUNT_SELECT = `
    SELECT p.id, p.business_name, p.owner_name, p.email, p.owner_phone,
      p.plan_type, p.subscription_status, p.minutes_included, p.minutes_used,
      p.is_enabled, p.trial_ends_at, p.created_at,
      tn.e164_number AS telnyx_number,
      tn.forwarding_target AS forwarding_target,
      np.id AS pool_number_id, np.phone_number AS pool_number, np.friendly_label AS pool_label, np.status AS pool_status,
      su.email AS owner_email,
      s.plan_code AS dodo_plan_code, s.status AS dodo_status, s.current_period_end,
      (SELECT COUNT(*) FROM leads l WHERE l.plumber_id = p.id AND substr(l.created_at, 1, 10) = strftime('%Y-%m-%d', 'now')) AS leads_today,
      (SELECT COUNT(*) FROM leads l WHERE l.plumber_id = p.id) AS leads_total,
      (SELECT MAX(l.created_at) FROM leads l WHERE l.plumber_id = p.id) AS last_lead_at
    FROM plumbers p
    LEFT JOIN telephony_numbers tn ON tn.id = (
      SELECT tn2.id FROM telephony_numbers tn2
      WHERE tn2.assigned_plumber_id = p.id AND tn2.status = 'assigned'
      ORDER BY tn2.created_at DESC, tn2.id DESC LIMIT 1
    )
    LEFT JOIN number_pool np ON np.id = (
      SELECT np2.id FROM number_pool np2
      WHERE np2.assigned_business_id = p.id AND np2.status = 'assigned'
      ORDER BY np2.id DESC LIMIT 1
    )
    LEFT JOIN shop_users su ON su.plumber_id = p.id
    LEFT JOIN subscriptions s ON s.plumber_id = p.id
  `;

  function accountLabel(plan) {
    if (plan.plan_type === 'demo') return 'Demo';
    if (plan.is_paid) return 'Paid - Solo';
    return 'Trial';
  }

  function listBusinessAccounts({ filter = 'all', search = '' } = {}) {
    const rows = db.prepare(ADMIN_ACCOUNT_SELECT + ' ORDER BY p.created_at DESC, p.business_name ASC').all();
    const accounts = rows.map((row) => {
      const plan = planSnapshot(row);
      const ownerEmail = row.owner_email || row.email || null;
      return {
        id: row.id,
        business_name: row.business_name,
        owner_name: row.owner_name || null,
        owner_email: ownerEmail,
        contact_email: row.email || null,
        phone_number: row.telnyx_number || null,
        forwarding_target: row.forwarding_target || null,
        pool_number_id: row.pool_number_id ? Number(row.pool_number_id) : null,
        pool_number: row.pool_number || null,
        pool_display_number: row.pool_number ? formatPhoneNumber(row.pool_number) : null,
        pool_label: row.pool_label || null,
        pool_status: row.pool_status || null,
        owner_phone: row.owner_phone || null,
        account_type: accountLabel(plan),
        plan_type: plan.plan_type,
        subscription_status: plan.subscription_status,
        dodo_status: row.dodo_status || null,
        dodo_plan_code: row.dodo_plan_code || null,
        current_period_end: row.current_period_end || null,
        trial_ends_at: plan.trial_ends_at,
        trial_expired: plan.trial_expired,
        trial_days_left: plan.trial_days_left,
        minutes_included: plan.minutes_included,
        minutes_used: plan.minutes_used,
        minutes_left: plan.minutes_left,
        daily_lead_limit: plan.daily_lead_limit,
        leads_today: Number(row.leads_today) || 0,
        leads_total: Number(row.leads_total) || 0,
        last_lead_at: row.last_lead_at || null,
        is_enabled: plan.is_enabled ? 1 : 0,
        created_at: row.created_at,
      };
    });

    const needle = String(search || '').trim().toLowerCase();
    const requested = String(filter || '').toLowerCase();
    const normalizedFilter = ['all', 'trial', 'paid', 'disabled'].includes(requested) ? requested : 'all';

    const filtered = accounts.filter((account) => {
      if (normalizedFilter === 'trial' && account.plan_type !== 'trial' && account.plan_type !== 'demo') return false;
      if (normalizedFilter === 'paid' && !(account.plan_type === 'solo' || account.plan_type === 'paid' || account.subscription_status === 'active')) return false;
      if (normalizedFilter === 'disabled' && account.is_enabled !== 0) return false;
      if (!needle) return true;
      return [account.business_name, account.owner_name, account.owner_email, account.contact_email, account.phone_number, account.owner_phone]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle));
    });

    return { accounts: filtered, all: accounts, filter: normalizedFilter };
  }

  function getAdminSummary({ filter = 'all', search = '' } = {}) {
    const { accounts, all } = listBusinessAccounts({ filter, search });
    const enabled = all.filter((account) => account.is_enabled === 1);
    const isPaid = (account) => account.plan_type === 'solo' || account.plan_type === 'paid' || account.subscription_status === 'active';
    const isTrialOrDemo = (account) => account.plan_type === 'trial' || account.plan_type === 'demo';
    return {
      accounts,
      kpis: {
        total_businesses: all.length,
        trial_demo_accounts: enabled.filter(isTrialOrDemo).length,
        paid_accounts: enabled.filter(isPaid).length,
        total_minutes_remaining: all.reduce((sum, account) => sum + Math.max(0, Number(account.minutes_left) || 0), 0),
      },
      counts: {
        all: all.length,
        trial: all.filter(isTrialOrDemo).length,
        paid: all.filter(isPaid).length,
        disabled: all.filter((account) => account.is_enabled === 0).length,
      },
    };
  }

  function setBusinessEnabled(plumberId, enabled) {
    const row = db.prepare('SELECT * FROM plumbers WHERE id = ?').get(plumberId);
    if (!row) return { ok: false, reason: 'business_not_found' };
    const next = enabled === undefined || enabled === null
      ? (Number(row.is_enabled) === 0 ? 1 : 0)
      : (enabled ? 1 : 0);
    // `active` is deliberately untouched: number lookups must still resolve the
    // business so the disabled guard answers instead of falling back to the
    // default demo account.
    db.prepare(`UPDATE plumbers SET is_enabled = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?`)
      .run(next, plumberId);
    const updated = db.prepare('SELECT * FROM plumbers WHERE id = ?').get(plumberId);
    return { ok: true, business: { ...updated, ...planSnapshot(updated) } };
  }

  function updateBusinessMinutes({ plumberId, includedMinutes, addMinutes }) {
    const row = db.prepare('SELECT * FROM plumbers WHERE id = ?').get(plumberId);
    if (!row) return { ok: false, reason: 'business_not_found' };
    let nextIncluded = Math.max(0, Math.round(Number(row.minutes_included) || 0));
    const setTo = Number(includedMinutes);
    const add = Number(addMinutes);
    if (includedMinutes !== undefined && includedMinutes !== null && includedMinutes !== '' && Number.isFinite(setTo) && setTo >= 0) {
      nextIncluded = Math.round(setTo);
    } else if (Number.isFinite(add) && add !== 0) {
      nextIncluded = Math.max(0, nextIncluded + Math.round(add));
    } else {
      return { ok: false, reason: 'missing_minutes' };
    }
    db.prepare(`UPDATE plumbers SET minutes_included = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?`)
      .run(nextIncluded, plumberId);
    db.prepare(`UPDATE subscriptions SET included_minutes = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE plumber_id = ?`)
      .run(nextIncluded, plumberId);
    const updated = db.prepare('SELECT * FROM plumbers WHERE id = ?').get(plumberId);
    return { ok: true, business: { ...updated, ...planSnapshot(updated) } };
  }

  function createAdminSession({ token, expiresAt }) {
    db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').run(new Date().toISOString());
    db.prepare('INSERT INTO admin_sessions (id, expires_at) VALUES (?, ?)').run(token, expiresAt);
    return token;
  }

  function getAdminSession(token) {
    if (!token) return null;
    return db.prepare('SELECT * FROM admin_sessions WHERE id = ? AND expires_at > ?').get(token, new Date().toISOString()) || null;
  }

  function deleteAdminSession(token) {
    if (token) db.prepare('DELETE FROM admin_sessions WHERE id = ?').run(token);
  }

  return {
    db, normalizePhone, getDefaultPlumber, getPlumberById, findPlumberByTelnyxNumber, resolvePlumberForCall, findPlumberForDodo,
    recordWebhookEventOnce, markWebhookProcessed, createOrUpdateLead, listCallLog, formatCallDuration, normalizeIsoTimestamp, savePushSubscription,
    deactivatePushEndpoint, listActivePushSubscriptions, markPushSent, upsertDodoSubscription,
    assignTelephonyNumberToPlumber, getPlumberSubscription,
    getUserByEmail, createShopUser, setUserLastLogin, createTrialShop,
    createSession, getSessionUser, deleteSession, deleteExpiredSessions,
    planSnapshot, countLeadsToday, listBusinessAccounts, getAdminSummary,
    setBusinessEnabled, updateBusinessMinutes,
    createAdminSession, getAdminSession, deleteAdminSession,
    listNumberPool, addPoolNumbers, assignPoolNumberToBusiness, claimNextPoolNumber,
    releasePoolNumber, togglePoolNumber, deletePoolNumber, setPoolNumberForwardingTarget,
    formatPhoneNumber, extractAreaCode, parseNumberList,
    TRIAL_DAILY_LEAD_CAP, TRIAL_MINUTES, SOLO_MINUTES, TRIAL_LENGTH_DAYS
  };
}
