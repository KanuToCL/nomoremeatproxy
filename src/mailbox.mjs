// File mailbox for handing a call to a Claude chat that is listening in the desktop app.
// Message text lives here only until the reply is collected; the ledger still holds none.
//
// Layout under <state>/inbox:
//   listeners/<key>.json   heartbeat of the chat attending one peer name in one project
//   requests/<id>.json     posted by a caller, not yet taken by the listener
//   delivered/<id>.json    taken by the listener, not yet answered
//   replies/<id>.json      answered, not yet collected by the caller
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { claimListener, liveListener } from './listener-lease.mjs';
import { writeState } from './writable.mjs';

export { LISTENER_MAX_AGE_MS } from './listener-lease.mjs';
const STALE_FILE_MS = 24 * 60 * 60 * 1000;
const STAGES = Object.freeze(['requests', 'delivered', 'replies']);
const SAFE_NAME = /^[A-Za-z0-9._-]{1,80}$/;

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const fileName = (requestId) => `${SAFE_NAME.test(requestId) ? requestId : sha256(requestId)}.json`;

// Windows compares paths without case, and the same folder must give one key from any shell.
export function mailboxKey({ project, peer }, platform = process.platform) {
  const folder = platform === 'win32' ? project.toLowerCase() : project;
  return sha256(`${folder}\n${peer}`).slice(0, 16);
}

// Limit: removals (rmSync) are not wrapped; a folder that refuses them refuses this first.
function writeJson(file, value) {
  writeState(() => {
    mkdirSync(path.dirname(file), { recursive: true });
    // Written whole and then renamed, so a reader never sees half a file.
    const partial = `${file}.${process.pid}.tmp`;
    writeFileSync(partial, JSON.stringify(value));
    renameSync(partial, file);
  });
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

const listJson = (dir) => (existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.json')) : []);

export function openMailbox(stateDir, { now = () => Date.now() } = {}) {
  const root = path.join(stateDir, 'inbox');
  const stageFile = (stage, requestId) => path.join(root, stage, fileName(requestId));
  const listenerFile = (box) => path.join(root, 'listeners', `${mailboxKey(box)}.json`);

  const mailbox = {
    // --- listener side ---
    claimListener(box, session) {
      return claimListener({ file: listenerFile(box), peer: box.peer, session, now, writeJson, collect: () => mailbox.collect(box) });
    },
    // Takes every waiting request addressed to this box, oldest first.
    collect(box) {
      const key = mailboxKey(box);
      const dir = path.join(root, 'requests');
      const waiting = listJson(dir)
        .map((name) => ({ name, request: readJson(path.join(dir, name)) }))
        .filter(({ request }) => request?.key === key)
        .sort((a, b) => a.request.at - b.request.at);
      const taken = [];
      for (const { name, request } of waiting) {
        writeState(() => mkdirSync(path.join(root, 'delivered'), { recursive: true }));
        try {
          const file = path.join(root, 'delivered', name);
          // A repost of an id already taken or answered is dropped, not printed again. Callers
          // refuse a retry of a taken id and remove their repost when they take a waiting
          // answer; this catches a repost that slips in between. Limit: once the answer is
          // collected nothing is left to match, so a resend forced past the ledger is handed
          // over again.
          if (existsSync(file) || existsSync(path.join(root, 'replies', name))) {
            rmSync(path.join(dir, name), { force: true });
            continue;
          }
          renameSync(path.join(dir, name), file);
          // The file is named so a listener whose notice was cut short can read the whole text.
          taken.push({ ...request, file });
        } catch {
          // The caller withdrew it in the meantime.
        }
      }
      return taken;
    },
    answer(requestId, reply) {
      const open = ['requests', 'delivered'].some((stage) => existsSync(stageFile(stage, requestId)));
      if (!open) throw new Error(`no open request "${requestId}" in the mailbox`);
      writeJson(stageFile('replies', requestId), { requestId, reply, at: now() });
      rmSync(stageFile('requests', requestId), { force: true });
      rmSync(stageFile('delivered', requestId), { force: true });
    },
    // Removes leftovers of calls nobody came back for.
    purge() {
      for (const stage of STAGES) {
        const dir = path.join(root, stage);
        for (const name of listJson(dir)) {
          const file = path.join(dir, name);
          if (now() - statSync(file).mtimeMs > STALE_FILE_MS) rmSync(file, { force: true });
        }
      }
    },

    // --- caller side ---

    listener(box) {
      return liveListener(listenerFile(box), now);
    },
    // Every chat that is listening now, in any project and under any peer name.
    listeners() {
      const dir = path.join(root, 'listeners');
      return listJson(dir).map((name) => liveListener(path.join(dir, name), now)).filter(Boolean);
    },
    post({ project, peer, requestId, from, hop, maxHops, message }) {
      writeJson(stageFile('requests', requestId), { key: mailboxKey({ project, peer }), requestId, from, hop, maxHops, message, at: now() });
    },
    // The reply, or null while there is none. Reading it clears it, and a retry's repost with
    // it: removed first, so the listener never finds the repost without the reply beside it.
    takeReply(requestId) {
      const file = stageFile('replies', requestId);
      const stored = readJson(file);
      if (!stored) return null;
      rmSync(stageFile('requests', requestId), { force: true });
      rmSync(file, { force: true });
      return stored.reply;
    },
    // True while a listener holds the request: taken and not yet answered. Purge ends it after a day.
    taken(requestId) {
      return existsSync(stageFile('delivered', requestId));
    },
    // True when the request had not been taken yet and is now gone, so nothing was delivered.
    withdraw(requestId) {
      const file = stageFile('requests', requestId);
      if (!existsSync(file)) return false;
      rmSync(file, { force: true });
      return true;
    },
  };
  return mailbox;
}
