// ---------------------------------------------------------------------------
// Chat analytics — SEPARATE SQLite database, never the customer/lead database.
//
// Default path is CHAT_ANALYTICS_DB_PATH (/var/data/callflow-gemini/chat_analytics.db
// in production). If that path cannot be opened, we fall back to
// ./data/chat_analytics.db and, failing that, disable recording entirely — the
// website must never break because analytics is unavailable.
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS page_views (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    referrer TEXT,
    session_id TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  );
  CREATE INDEX IF NOT EXISTS idx_pv_path ON page_views(path);
  CREATE INDEX IF NOT EXISTS idx_pv_created ON page_views(created_at);

  CREATE TABLE IF NOT EXISTS chat_events (
    id TEXT PRIMARY KEY,
    event TEXT NOT NULL,
    path TEXT,
    session_id TEXT,
    detail TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  );
  CREATE INDEX IF NOT EXISTS idx_ce_event ON chat_events(event);
  CREATE INDEX IF NOT EXISTS idx_ce_created ON chat_events(created_at);

  CREATE TABLE IF NOT EXISTS chat_leads (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    contact TEXT NOT NULL,
    business_trade TEXT,
    city_zip TEXT,
    message TEXT,
    path TEXT,
    session_id TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  );
  CREATE INDEX IF NOT EXISTS idx_cl_created ON chat_leads(created_at);
`;

const clean = (value, max) => {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
};

export function initChatAnalytics(configuredPath = process.env.CHAT_ANALYTICS_DB_PATH) {
  const attempts = [configuredPath, path.resolve('./data/chat_analytics.db')].filter(Boolean);
  let db = null;
  let usedPath = null;
  let lastError = null;

  for (const attempt of attempts) {
    try {
      const resolved = path.resolve(String(attempt));
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      const candidate = new Database(resolved);
      candidate.pragma('journal_mode = WAL');
      candidate.pragma('busy_timeout = 5000');
      candidate.exec(SCHEMA);
      db = candidate;
      usedPath = resolved;
      break;
    } catch (err) {
      lastError = err;
    }
  }

  const noop = () => null;
  if (!db) {
    console.warn(`[chat] analytics DISABLED — ${lastError?.message || 'no writable path'}`);
    return { enabled: false, path: null, recordPageView: noop, recordEvent: noop, recordLead: noop, stats: noop };
  }
  console.log(`[chat] analytics db: ${usedPath}`);

  const insertPageView = db.prepare('INSERT INTO page_views (id, path, referrer, session_id) VALUES (?, ?, ?, ?)');
  const insertEvent = db.prepare('INSERT INTO chat_events (id, event, path, session_id, detail) VALUES (?, ?, ?, ?, ?)');
  const insertLead = db.prepare(`INSERT INTO chat_leads (id, name, contact, business_trade, city_zip, message, path, session_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

  function recordPageView({ path: pagePath, referrer, sessionId } = {}) {
    try {
      insertPageView.run(crypto.randomUUID(), clean(pagePath, 300) || '/', clean(referrer, 300), clean(sessionId, 64));
      return true;
    } catch (err) {
      console.warn(`[chat] page_view not stored: ${err.message}`);
      return false;
    }
  }

  function recordEvent({ event, path: pagePath, sessionId, detail } = {}) {
    try {
      insertEvent.run(crypto.randomUUID(), clean(event, 60) || 'unknown', clean(pagePath, 300), clean(sessionId, 64), clean(detail, 200));
      return true;
    } catch (err) {
      console.warn(`[chat] event not stored: ${err.message}`);
      return false;
    }
  }

  function recordLead({ name, contact, businessTrade, cityZip, message, path: pagePath, sessionId } = {}) {
    const cleanName = clean(name, 120);
    const cleanContact = clean(contact, 160);
    if (!cleanName || !cleanContact) return null;
    const id = crypto.randomUUID();
    try {
      insertLead.run(
        id,
        cleanName,
        cleanContact,
        clean(businessTrade, 80),
        clean(cityZip, 80),
        clean(message, 1000),
        clean(pagePath, 300),
        clean(sessionId, 64)
      );
      return { id };
    } catch (err) {
      console.warn(`[chat] lead not stored: ${err.message}`);
      return null;
    }
  }

  function stats() {
    try {
      return {
        db_path: usedPath,
        page_views: db.prepare('SELECT COUNT(*) AS c FROM page_views').get().c,
        chat_events: db.prepare('SELECT COUNT(*) AS c FROM chat_events').get().c,
        chat_leads: db.prepare('SELECT COUNT(*) AS c FROM chat_leads').get().c,
      };
    } catch {
      return null;
    }
  }

  return { enabled: true, path: usedPath, recordPageView, recordEvent, recordLead, stats };
}
