// One live listener per project/peer on this machine. The JSON heartbeat stays readable
// by existing callers. A SQLite writer lock serializes the check and file operations across
// processes; the OS releases it on crash. No lock is held while a listener sleeps or emits.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

export const LISTENER_MAX_AGE_MS = 20_000;
// How long a claim stays live after `listen --once` exits, while the chat finishes its turn.
export const HELD_CLAIM_MS = 5 * 60_000;

function heartbeat(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function liveListener(file, now) {
  // Discovery is advisory: as before the guard, an unreadable heartbeat means no
  // known listener. Writers use the strict read under the lock and never guess ownership.
  let beat;
  try {
    beat = heartbeat(file);
  } catch {
    return null;
  }
  return beat && now() - beat.at <= LISTENER_MAX_AGE_MS ? { session: beat.session } : null;
}

function locked(file, operation) {
  // Load the built-in only on the listener path. Node 22.15+ ships it; no npm install.
  const DatabaseSync = process.getBuiltinModule('node:sqlite')?.DatabaseSync;
  if (!DatabaseSync) throw new Error('listening requires a Node.js 22.15+ build with built-in SQLite');
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
    return operation();
  } finally {
    db.close(); // ends the lock-only transaction, including when operation throws
  }
}

export function claimListener({ file, peer, session = null, now, writeJson, collect }) {
  mkdirSync(path.dirname(file), { recursive: true });
  const exclusive = (fn) => locked(`${file}.lock.sqlite`, fn);
  const run = randomUUID();
  const beat = (ahead = 0) => writeJson(file, { session, run, at: now() + ahead });
  const owns = () => heartbeat(file)?.run === run;

  exclusive(() => {
    const previous = heartbeat(file);
    if (previous && now() - previous.at <= LISTENER_MAX_AGE_MS) {
      // Two anonymous processes cannot establish that they belong to the same chat.
      // A pre-guard listener cannot be fenced, even if it has the same session id.
      if (!session || previous.session !== session || !previous.run) {
        throw new Error(`${peer} already has a listener for this project (${previous.session || 'unknown chat'}); stop it first or wait for its last heartbeat to expire`);
      }
    }
    beat();
  });

  return {
    poll(renew) {
      return exclusive(() => {
        if (!owns()) return null; // replaced; never refresh or consume another run's work
        if (renew) beat();
        return collect();
      });
    },
    release() {
      exclusive(() => {
        if (owns()) rmSync(file);
      });
    },
    // Leaves the claim live for HELD_CLAIM_MS, so callers keep waiting in the inbox and the
    // same chat's next start (same session) takes it over. The beat is stamped ahead so the
    // usual freshness check expires it then. Limit: a restart later than that lets calls
    // fall back to the standing chat, and a chat that stopped for good holds callers that long.
    hold() {
      exclusive(() => {
        if (owns()) beat(HELD_CLAIM_MS - LISTENER_MAX_AGE_MS);
      });
    },
  };
}
