// Following up on a message that was sent without waiting: has the peer started on it, is it
// still working, or did it finish, and with what words. The sender asks; nothing is resent.
import { requestMarker } from './call.mjs';

const NOTES = Object.freeze({
  returned: 'the reply came back to the call that sent it',
  uncheckable: 'this kind of delivery cannot be checked from outside; read the thread instead',
  // Only what is seen: the cause of a message not starting is not known.
  waiting: 'the peer has not started on it; cause unknown',
  idle: 'the chat is idle and has not picked the message up; open the chat in the Codex app, or send it again as a new call that waits (the queued copy may then run as well)',
  running: 'the peer is working on it now',
});

// Under a minute after sending, a message not started yet is no sign of a problem.
const RECENT_S = 60;

function noteFor(found, secondsAgo) {
  if (found.state !== 'waiting') return NOTES[found.state];
  if (secondsAgo < RECENT_S) return `sent ${secondsAgo} seconds ago; the peer has not started on it yet`;
  return found.idle ? NOTES.idle : NOTES.waiting;
}

export async function checkRequest(requestId, { ledger, checkers = {}, now = Date.now }) {
  const history = ledger.history(requestId);
  const sent = history.find((entry) => entry.state === 'submitting');
  if (!sent) return { requestId, state: 'unknown', ...ledger.notFound('no such request') };
  const threadId = history.findLast((entry) => entry.threadId)?.threadId ?? null;
  // The latest handover, so that a failed attempt or a slow queue before it is not counted as
  // time the message has waited; without one, the latest attempt.
  const handedOver = history.findLast((entry) => entry.state === 'sent') ?? history.findLast((entry) => entry.state === 'submitting');
  const base = { requestId, peer: sent.peer, threadId, sentAt: handedOver.at };
  if (history.some((entry) => entry.state === 'answered')) return { ...base, state: 'answered', note: NOTES.returned };
  const check = checkers[sent.vendor];
  if (!check || !threadId) return { ...base, state: 'sent', note: NOTES.uncheckable };
  const found = await check({ threadId, marker: requestMarker(requestId) });
  const note = noteFor(found, Math.max(0, Math.floor((now() - Date.parse(handedOver.at)) / 1000)));
  return { ...base, ...found, ...(note ? { note } : {}) };
}

// The requests of one project that were sent without waiting, newest last.
export function sentWithoutWaiting(entries, { project, since }) {
  const starts = new Map(entries.filter((entry) => entry.state === 'submitting').map((entry) => [entry.requestId, entry]));
  return entries
    .filter((entry) => entry.state === 'sent' && starts.get(entry.requestId)?.project === project && (!since || entry.at >= since))
    .map((entry) => entry.requestId);
}
