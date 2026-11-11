// Per-install consent and durable Desktop work; never store prompts, replies or target paths.
// Public API: bind/disable, enqueue, due/work, report/retry, status.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { checkStateDir, writeState } from './writable.mjs';

export const REMINDER_MS = 5 * 60_000;
export const MAX_NOTICES = 3;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function sessionId(value) {
  const id = String(value ?? '').replace(/^local_/, '').toLowerCase();
  if (!UUID.test(id)) throw new Error('Expected a Claude Desktop session UUID');
  return id;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS coordinator (singleton INTEGER PRIMARY KEY CHECK(singleton=1), box TEXT NOT NULL, session TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS jobs (target TEXT PRIMARY KEY, state TEXT NOT NULL, receipt TEXT, notified INTEGER, verified INTEGER, attempts INTEGER NOT NULL DEFAULT 0);
`;
const counts = (db) => Object.fromEntries(db.prepare('SELECT state, COUNT(*) AS n FROM jobs GROUP BY state').all().map(r => [r.state, r.n]));
const bound = (db) => db.prepare('SELECT box, session FROM coordinator').get();
const matches = (db, box, session) => {
  const current = bound(db);
  return current && current.box === box && current.session === session;
};

export function remoteStore(dir, { now = Date.now } = {}) {
  const file = path.join(dir, 'remote-control.sqlite');
  function access(fn, { create = false, write = false, absent = null } = {}) {
    if (!create && !existsSync(file)) {
      checkStateDir(dir);
      return absent;
    }
    const SQLite = process.getBuiltinModule('node:sqlite')?.DatabaseSync;
    if (!SQLite) throw new Error('Remote Control provisioning requires Node.js with built-in SQLite');
    return writeState(() => {
      if (create) mkdirSync(dir, { recursive: true });
      const db = new SQLite(file);
      try {
        db.exec('PRAGMA busy_timeout=5000');
        if (write) db.exec('BEGIN IMMEDIATE');
        if (create) db.exec(SCHEMA);
        const result = fn(db);
        if (write) db.exec('COMMIT');
        return result;
      } finally { db.close(); }
    });
  }
  return {
    bind(box, session) {
      session = sessionId(session);
      return access(db => {
        if (bound(db) && !matches(db, box, session)) throw new Error('A different coordinator is bound; disable the old binding first');
        db.prepare('INSERT OR IGNORE INTO coordinator VALUES(1, ?, ?)').run(box, session);
        return { enabled: true, coordinator: session };
      }, { create: true, write: true });
    },
    disable() {
      return access(db => {
        db.exec("DELETE FROM coordinator; UPDATE jobs SET state='cancelled', receipt=NULL WHERE state IN ('pending','approval-required','unavailable')");
        return { enabled: false };
      }, { write: true, absent: { enabled: false } });
    },
    enqueue(target) {
      target = sessionId(target);
      return access(db => {
        if (!bound(db)) return { state: 'not-configured' };
        db.prepare("INSERT OR IGNORE INTO jobs(target, state) VALUES(?, 'pending')").run(target);
        return { state: db.prepare('SELECT state FROM jobs WHERE target=?').get(target).state };
      }, { write: true, absent: { state: 'not-configured' } });
    },
    due(box, session) {
      return access(db => {
        if (!matches(db, box, session)) return [];
        const when = now();
        db.prepare("UPDATE jobs SET state='unavailable', receipt=NULL WHERE state='pending' AND attempts>=? AND notified<=?").run(MAX_NOTICES, when - REMINDER_MS);
        const rows = db.prepare("SELECT target FROM jobs WHERE state='pending' AND (notified IS NULL OR notified<=?) ORDER BY notified, rowid LIMIT 8").all(when - REMINDER_MS);
        const mark = db.prepare('UPDATE jobs SET notified=?, attempts=attempts+1, receipt=COALESCE(receipt,?) WHERE target=?');
        for (const { target } of rows) mark.run(when, randomUUID(), target);
        return rows.map(r => r.target);
      }, { write: true, absent: [] });
    },
    work(box, session) {
      return access(db => matches(db, box, session)
        ? db.prepare("SELECT target, receipt, attempts FROM jobs WHERE state='pending' AND receipt IS NOT NULL ORDER BY rowid").all() : [], { absent: [] });
    },
    report(target, receipt, result) {
      target = sessionId(target);
      if (!['active', 'approval-required', 'unavailable'].includes(result)) throw new Error('Result must be active, approval-required, or unavailable');
      const recorded = access(db => {
        const job = db.prepare('SELECT state, receipt FROM jobs WHERE target=?').get(target);
        if (!bound(db) || !receipt || job?.receipt !== receipt || !['pending', result].includes(job.state)) {
          throw new Error('No matching outstanding Desktop verification');
        }
        if (job.state === 'pending') db.prepare('UPDATE jobs SET state=?, verified=? WHERE target=?').run(result, result === 'active' ? now() : null, target);
        return { target, state: result };
      }, { write: true });
      if (!recorded) throw new Error('No Remote Control configuration');
      return recorded;
    },
    retry(target) {
      target = sessionId(target);
      const changed = access(db => bound(db) && db.prepare("UPDATE jobs SET state='pending', receipt=NULL, notified=NULL, attempts=0 WHERE target=? AND state IN ('approval-required','unavailable')").run(target).changes, { write: true });
      if (!changed) throw new Error('No eligible blocked job; only bridge-created jobs can be retried');
      return { target, state: 'pending' };
    },
    status(target) {
      if (target) target = sessionId(target);
      return access(db => ({
        enabled: Boolean(bound(db)), coordinator: bound(db)?.session ?? null,
        ...(target ? { target, job: db.prepare('SELECT state, attempts, verified AS verifiedAtMs FROM jobs WHERE target=?').get(target) ?? null } : { counts: counts(db) }),
      }), { absent: { enabled: false, ...(target ? { target, job: null } : { counts: {} }) } });
    },
  };
}
