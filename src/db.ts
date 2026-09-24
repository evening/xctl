import Database from 'better-sqlite3';
import { config, ensureHome } from './config.js';

export type DraftKind = 'reply' | 'dm' | 'accept';

export interface DraftOptions {
  /** dm: accept a pending message request before sending. */
  accept?: boolean;
}
/**
 * pending -> (approve) sending -> sent | failed | unconfirmed
 * pending -> rejected
 * "failed" means X or xctl rejected it *before* the send button was pressed; only then can it be approved again.
 */
export type DraftStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'unconfirmed' | 'rejected';

export interface DraftRow {
  id: number;
  kind: DraftKind;
  target: string;
  text: string;
  status: DraftStatus;
  created_at: string;
  updated_at: string;
  result: string | null;
  error: string | null;
  options: string | null;
}

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  ensureHome();
  db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS handled (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      note TEXT,
      handled_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      target TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      result TEXT,
      error TEXT
    );
    CREATE TABLE IF NOT EXISTS writes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      target TEXT NOT NULL,
      draft_id INTEGER,
      at_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      detail TEXT
    );
    CREATE INDEX IF NOT EXISTS writes_at ON writes(at_ms);
    CREATE TABLE IF NOT EXISTS pin_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at_ms INTEGER NOT NULL,
      ok INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  const cols = (db.prepare('PRAGMA table_info(drafts)').all() as { name: string }[]).map(c => c.name);
  if (!cols.includes('options')) db.exec('ALTER TABLE drafts ADD COLUMN options TEXT');
  return db;
}

const now = () => new Date().toISOString();

// ---- handled ----

export function idKind(id: string): 'tweet' | 'dm_message' | 'dm_conversation' | 'other' {
  if (/^\d{1,25}$/.test(id)) return 'tweet';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return 'dm_message';
  if (/^\d+:\d+$/.test(id)) return 'dm_conversation';
  return 'other';
}

export function markHandled(id: string, note?: string | null) {
  const d = getDb();
  const existing = d.prepare('SELECT * FROM handled WHERE id = ?').get(id) as any;
  if (existing) return { id, handled: true, already: true, kind: existing.kind, handled_at: existing.handled_at, note: existing.note };
  const at = now();
  d.prepare('INSERT INTO handled (id, kind, note, handled_at) VALUES (?, ?, ?, ?)').run(id, idKind(id), note ?? null, at);
  return { id, handled: true, already: false, kind: idKind(id), handled_at: at, note: note ?? null };
}

export function unmarkHandled(id: string) {
  const r = getDb().prepare('DELETE FROM handled WHERE id = ?').run(id);
  return { id, handled: false, removed: r.changes > 0 };
}

export function checkHandled(id: string) {
  const r = getDb().prepare('SELECT * FROM handled WHERE id = ?').get(id) as any;
  return r ? { id, handled: true, kind: r.kind, handled_at: r.handled_at, note: r.note } : { id, handled: false };
}

export function handledSet(ids: string[]): Set<string> {
  if (!ids.length) return new Set();
  const d = getDb();
  const out = new Set<string>();
  const stmt = d.prepare('SELECT id FROM handled WHERE id = ?');
  for (const id of ids) if (stmt.get(id)) out.add(id);
  return out;
}

/** Tweets that xctl itself replied to (from handled notes "replied <id>"), target id -> reply id. */
export function repliedViaXctl(ids: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const stmt = getDb().prepare("SELECT note FROM handled WHERE id = ? AND note LIKE 'replied %'");
  for (const id of ids) {
    const r = stmt.get(id) as { note: string } | undefined;
    if (r) out.set(id, r.note.slice('replied '.length));
  }
  return out;
}

// ---- XChat PIN attempts (outcome + time only; the PIN itself is never stored) ----

export function recordPinAttempt(ok: boolean): void {
  getDb().prepare('INSERT INTO pin_attempts (at_ms, ok) VALUES (?, ?)').run(Date.now(), ok ? 1 : 0);
}

/** Rejections in the last hour since the most recent success. */
export function recentPinFailures(): number {
  const d = getDb();
  const hourAgo = Date.now() - 3_600_000;
  const lastOk = (d.prepare('SELECT MAX(at_ms) AS t FROM pin_attempts WHERE ok = 1').get() as { t: number | null }).t ?? 0;
  return (d.prepare('SELECT COUNT(*) AS n FROM pin_attempts WHERE ok = 0 AND at_ms > ?').get(Math.max(hourAgo, lastOk)) as { n: number }).n;
}

// ---- small cache ----

export function kvGet(key: string): string | null {
  return (getDb().prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
}

export function kvSet(key: string, value: string): void {
  getDb().prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

// ---- drafts ----

export function createDraft(kind: DraftKind, target: string, text: string, options: DraftOptions = {}): { draft: DraftRow; duplicate: boolean } {
  const d = getDb();
  const opts = Object.keys(options).length ? JSON.stringify(options) : null;
  const dup = d
    .prepare("SELECT * FROM drafts WHERE kind = ? AND target = ? AND text = ? AND COALESCE(options, '') = COALESCE(?, '') AND status = 'pending'")
    .get(kind, target, text, opts) as DraftRow | undefined;
  if (dup) return { draft: dup, duplicate: true };
  const at = now();
  const info = d
    .prepare('INSERT INTO drafts (kind, target, text, status, created_at, updated_at, options) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(kind, target, text, 'pending', at, at, opts);
  return { draft: getDraft(Number(info.lastInsertRowid))!, duplicate: false };
}

export function getDraft(id: number): DraftRow | undefined {
  return getDb().prepare('SELECT * FROM drafts WHERE id = ?').get(id) as DraftRow | undefined;
}

export function listDrafts(status: DraftStatus | 'all', limit: number): DraftRow[] {
  const d = getDb();
  return (
    status === 'all'
      ? d.prepare('SELECT * FROM drafts ORDER BY id DESC LIMIT ?').all(limit)
      : d.prepare('SELECT * FROM drafts WHERE status = ? ORDER BY id DESC LIMIT ?').all(status, limit)
  ) as DraftRow[];
}

/** Atomic status transition; returns false if the draft was not in one of the expected states. */
export function transitionDraft(id: number, from: DraftStatus[], to: DraftStatus, fields: { result?: unknown; error?: unknown } = {}): boolean {
  const placeholders = from.map(() => '?').join(',');
  const r = getDb()
    .prepare(`UPDATE drafts SET status = ?, updated_at = ?, result = COALESCE(?, result), error = ? WHERE id = ? AND status IN (${placeholders})`)
    .run(to, now(), fields.result === undefined ? null : JSON.stringify(fields.result), fields.error === undefined ? null : JSON.stringify(fields.error), id, ...from);
  return r.changes > 0;
}

export function draftOut(r: DraftRow) {
  return {
    id: r.id,
    kind: r.kind,
    target: r.target,
    text: r.text,
    status: r.status,
    created_at: r.created_at,
    updated_at: r.updated_at,
    options: r.options ? (JSON.parse(r.options) as DraftOptions) : {},
    result: r.result ? JSON.parse(r.result) : null,
    error: r.error ? JSON.parse(r.error) : null,
  };
}

// ---- write rate limiting ----

export function writeAllowed(nowMs = Date.now()): { ok: true } | { ok: false; reason: string; retry_after_sec: number } {
  const d = getDb();
  // Every attempt that reached the send button counts, whatever its outcome.
  // Only messages count (accepting a request is audited but not rate limited).
  const counted = "kind IN ('reply', 'dm') AND status IN ('attempted', 'sent', 'unconfirmed', 'failed_after_send')";
  const last = d.prepare(`SELECT at_ms FROM writes WHERE ${counted} ORDER BY at_ms DESC LIMIT 1`).get() as { at_ms: number } | undefined;
  const minMs = config.writeMinIntervalSec * 1000;
  if (last && nowMs - last.at_ms < minMs) {
    return { ok: false, reason: `minimum ${config.writeMinIntervalSec}s between writes (XCTL_WRITE_MIN_INTERVAL_SEC)`, retry_after_sec: Math.ceil((minMs - (nowMs - last.at_ms)) / 1000) };
  }
  const hourAgo = nowMs - 3_600_000;
  const rows = d.prepare(`SELECT at_ms FROM writes WHERE ${counted} AND at_ms > ? ORDER BY at_ms ASC`).all(hourAgo) as { at_ms: number }[];
  if (config.writesPerHour > 0 && rows.length >= config.writesPerHour) {
    return { ok: false, reason: `hourly cap of ${config.writesPerHour} writes reached (XCTL_WRITES_PER_HOUR)`, retry_after_sec: Math.ceil((rows[0].at_ms + 3_600_000 - nowMs) / 1000) };
  }
  return { ok: true };
}

export function recordWrite(kind: DraftKind, target: string, draftId: number | null): number {
  const info = getDb().prepare("INSERT INTO writes (kind, target, draft_id, at_ms, status) VALUES (?, ?, ?, ?, 'attempted')").run(kind, target, draftId, Date.now());
  return Number(info.lastInsertRowid);
}

export function finishWrite(id: number, status: 'sent' | 'unconfirmed' | 'failed_after_send', detail?: unknown): void {
  getDb().prepare('UPDATE writes SET status = ?, detail = ? WHERE id = ?').run(status, detail === undefined ? null : JSON.stringify(detail), id);
}
