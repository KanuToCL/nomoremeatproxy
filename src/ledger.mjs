// Append-only delivery ledger. Holds ids, states and message hashes, never message text.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkStateDir, writeState } from './writable.mjs';

export function defaultStateDir(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.NOMEAT_STATE_DIR) return env.NOMEAT_STATE_DIR;
  // Not under AppData: Windows gives every Store app a private copy of that folder, so the
  // two desktop apps would each keep a ledger the other cannot see.
  if (platform === 'win32') return path.join(home, '.nomoremeatproxy');
  const stateHome = env.XDG_STATE_HOME ?? path.join(home, '.local', 'state');
  return path.join(stateHome, 'nomoremeatproxy');
}

function parseLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    // A crash can leave a torn last line; the entries before it are still valid.
    return null;
  }
}

export function openLedger(stateDir, { now = () => new Date(), readOnly = false } = {}) {
  const file = path.join(stateDir, 'ledger.jsonl');
  const readAll = () => {
    if (!readOnly && !existsSync(file)) {
      checkStateDir(stateDir);
      return [];
    }
    let contents;
    try {
      contents = readFileSync(file, 'utf8');
    } catch (error) {
      // existsSync also returns false for denied paths. A read-only report must not turn
      // unknown routes into "none", or probe for writes while checking a missing ledger.
      if (readOnly && error.code === 'ENOENT') return [];
      throw error;
    }
    return contents.split('\n').filter(Boolean).map(parseLine).filter(Boolean);
  };
  return {
    file,
    append(event) {
      if (readOnly) throw new Error('this ledger is read-only');
      const entry = { at: now().toISOString(), ...event };
      writeState(() => {
        mkdirSync(stateDir, { recursive: true });
        appendFileSync(file, `${JSON.stringify(entry)}\n`);
      });
      return entry;
    },
    entries() {
      return readAll();
    },
    history(requestId) {
      return readAll().filter((entry) => entry.requestId === requestId);
    },
    // For an answer that found nothing: names the folder read, as the other side may use another.
    notFound(what) {
      return { stateDir, note: `${what} in this state folder; both sides must use the same one (NOMEAT_STATE_DIR)` };
    },
    // The thread of the most recent answered call between this caller and peer in this project.
    // A chat that answered while attended in its app is left out: continuing it later would
    // mean a headless run on a session the app may still hold. So is the answer to a call the
    // caller steered into a new or an exact thread, recovered or not: such a thread must not
    // become the default by being recent.
    lastThread({ project, from, peer }) {
      const entries = readAll();
      const steered = new Set(entries.filter((entry) => entry.steered).map((entry) => entry.requestId));
      const entry = entries.findLast(
        (candidate) =>
          candidate.state === 'answered' &&
          candidate.threadId &&
          candidate.delivery !== 'attended' &&
          !steered.has(candidate.requestId) &&
          candidate.project === project &&
          candidate.from === from &&
          candidate.peer === peer,
      );
      return entry?.threadId ?? null;
    },
    // The thread named as the standing conversation between this caller and peer in this
    // project. Set explicitly or by the first call; a side thread never changes it.
    standingThread({ project, from, peer }) {
      const entry = readAll().findLast(
        (candidate) => candidate.state === 'standing' && candidate.project === project && candidate.from === from && candidate.peer === peer,
      );
      return entry?.threadId ?? null;
    },
    // The access the bridge recorded for a thread. The earliest record wins on purpose: it is
    // what the thread was created with, and a later resume with write may not have stuck.
    threadAccess(threadId) {
      if (!threadId) return null;
      return readAll().find((entry) => entry.threadId === threadId && entry.access)?.access ?? null;
    },
    // The newest call from this caller to this peer that is still waiting for its answer:
    // submitted, not answered, not failed, not sent without waiting, and recent enough to
    // still be running.
    openCall({ project, from, peer, maxAgeMs }) {
      const entries = readAll();
      const closed = new Set(entries.filter((entry) => ['answered', 'failed', 'sent'].includes(entry.state)).map((entry) => entry.requestId));
      const oldest = now().getTime() - maxAgeMs;
      return (
        entries.findLast(
          (entry) =>
            entry.state === 'submitting' &&
            entry.project === project &&
            entry.from === from &&
            entry.peer === peer &&
            !closed.has(entry.requestId) &&
            Date.parse(entry.at) >= oldest,
        ) ?? null
      );
    },
  };
}
