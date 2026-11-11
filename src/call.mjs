// One call from an assistant to a peer: pick the thread, bound the exchange, refuse
// duplicates, and record every state before and after the vendor is contacted.
import { createHash, randomUUID } from 'node:crypto';

export const DEFAULT_MAX_HOPS = 4;
const TITLE_TEXT_LENGTH = 60;

const NOTES = Object.freeze({
  sent: 'sent without waiting; the reply will not come back to this call',
  duplicate: 'this request was already sent or answered; read the thread instead of sending again',
  uncertain: 'an earlier attempt may have been delivered; inspect the thread, then resend with --force only if the message is absent',
  attendedStanding: 'that chat answers from its own app, and the standing thread is continued without the app; nothing was sent. Send with --thread alone, or name another thread',
});

// Deliveries where the peer's own app runs the turn with the chat's own model and level.
const RUNS_AS_IS = new Set(['queued', 'attended']);

// `named` lists the settings the caller gave itself, not the peer's defaults.
const dropped = (delivery, named) => (RUNS_AS_IS.has(delivery) && named?.length ? { notApplied: named } : {});

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

// Unique text inside the header, used to find this request's turn in a thread later.
export const requestMarker = (requestId) => `request ${requestId};`;

// Seen on macOS: the Codex app did not list a chat the bridge made until it re-read its list, and
// a question card raised there never reached the owner although the card tool answered accepted.
const UNLISTED_CHAT = 'The owner may not see this chat: put any question for the owner in your answer, marked for the owner, not in a question card.';

// The recipient must be able to tell a peer's message from the owner's own words. Kept to
// one short line: it is sent with every message. The opening words are what the calling
// rules tell an assistant to look for, and the request marker is what recovery searches for.
// `unlisted` adds one line for a chat the owner may not see.
export function stampMessage({ message, from, requestId, hop, maxHops, unlisted = false }) {
  const header = `[nomeat call from ${from}; ${requestMarker(requestId)} hop ${hop}/${maxHops}; AI, not user]`;
  return `${header}${unlisted ? `\n${UNLISTED_CHAT}` : ''}\n\n${message}`;
}

// Shown in the peer's app so the owner can tell bridge threads, and their projects, apart.
export function threadTitle({ from, peer, project, message }) {
  const text = message.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  const shown = text.length > TITLE_TEXT_LENGTH ? `${text.slice(0, TITLE_TEXT_LENGTH)}...` : text;
  // Both separators, so a Windows path is read correctly on any platform.
  const folder = project.split(/[\\/]/).filter(Boolean).at(-1);
  return `${from} to ${peer} [${folder}]: ${shown}`;
}

function priorOutcome(history) {
  const threadId = history.findLast((entry) => entry.threadId)?.threadId ?? null;
  if (history.some((entry) => entry.state === 'answered' || entry.state === 'sent')) return { state: 'duplicate', threadId };
  const lastAttempt = history.findLast((entry) => entry.state === 'submitting' || entry.state === 'failed');
  if (!lastAttempt) return null;
  // A failure known to have happened before anything was sent is safe to retry.
  if (lastAttempt.state === 'failed' && lastAttempt.sent === false) return null;
  return { state: 'uncertain', threadId };
}

// How the caller steered this call away from the route's default thread, if it did.
const steering = (request) => (request.threadId ? 'thread' : request.newThread ? 'new' : null);

// An explicit thread wins, and a new thread starts fresh. Otherwise the standing conversation
// between this caller and peer in this project continues; where none has been named yet, the
// last answered thread that no caller steered does.
function chooseThread(request, ledger, route) {
  if (request.threadId) return request.threadId;
  if (request.newThread) return null;
  return ledger.standingThread(route) ?? ledger.lastThread(route);
}

// A thread becomes the standing one when the caller says so, or when the route has none and
// the caller did not steer this call: a side thread or an exact thread must not take over by
// being first or recent. A chat that answers from its app is never named: the standing
// thread is continued without the app.
function nameStanding({ request, ledger, route, result, attendedChat }) {
  if (!result.threadId || result.delivery === 'attended' || attendedChat(result.threadId)) return;
  const first = !steering(request) && !ledger.standingThread(route);
  // Recorded for the route, not under the request id: it is not a step of that request.
  if (request.makeStanding || first) ledger.append({ ...route, state: 'standing', threadId: result.threadId });
}

// Before reporting an uncertain delivery, look in the thread: the answer may already be there.
async function recoverAnswer({ prior, recover, requestId }) {
  if (prior.state !== 'uncertain' || !recover) return null;
  return recover({ threadId: prior.threadId, marker: requestMarker(requestId), requestId });
}

// `attendedChat` says why a chat cannot be a standing thread, or null when it can.
export async function callPeer(request, { ledger, adapters, recoverers = {}, attendedChat = () => null, newId = randomUUID }) {
  const { peer, message, from, project, effort, write = false, force = false } = request;
  const hop = request.hop ?? 1;
  const maxHops = request.maxHops ?? DEFAULT_MAX_HOPS;
  const requestId = request.requestId ?? newId();
  // A peer without a model uses the vendor's default, and the result then has no model field.
  const header = (model) => ({ requestId, peer: peer.name, vendor: peer.vendor, ...(model == null ? {} : { model }) });
  let base = header(peer.model);
  const route = { project, from, peer: peer.name };

  if (hop > maxHops) {
    const note = `hop ${hop} exceeds the limit of ${maxHops}; put the open question to the owner instead of calling again`;
    return { ...base, state: 'refused', threadId: request.threadId ?? null, note };
  }
  // A fresh request sends nothing before the adapter is called: a failure up to there, such as
  // a state folder that cannot be read or written, is marked not sent. Once an earlier attempt
  // is found, it may have been delivered, so a failure while recovering it is not marked.
  let adapter, threadId, threadAccess, prior, model = peer.model, level = effort;
  try {
    if (request.makeStanding && request.threadId && attendedChat(request.threadId)) {
      return { ...base, state: 'refused', threadId: request.threadId, note: NOTES.attendedStanding };
    }
    const history = ledger.history(requestId);
    prior = force ? null : priorOutcome(history);
    if (prior) {
      // Report the model the earlier attempt sent, which a call into an existing thread may not have.
      base = header(history.findLast((entry) => entry.state === 'submitting')?.model);
      const found = await recoverAnswer({ prior, recover: recoverers[peer.vendor], requestId });
      if (!found) return { ...base, ...prior, note: NOTES[prior.state] };
      ledger.append({ requestId, ...route, state: 'answered', threadId: prior.threadId, recovered: true });
      // A recoverer states the delivery only when it knows it; Codex's cannot tell direct from queued.
      return { ...base, state: 'answered', threadId: prior.threadId, continued: true, recovered: true, ...dropped(found.delivery, request.named), reply: found.reply };
    }

    adapter = adapters[peer.vendor];
    if (!adapter) throw new Error(`no adapter for vendor "${peer.vendor}"`);
    threadId = chooseThread(request, ledger, route);
    // An existing Codex thread keeps its own model and level unless the caller named one; the
    // peer's defaults are for a new thread. A Claude session is still given the peer's model.
    if (peer.vendor === 'codex' && threadId) {
      const named = request.named ?? [];
      if (!named.includes('model')) model = undefined;
      if (!named.includes('effort')) level = undefined;
      base = header(model);
    }
    const steered = steering(request);
    threadAccess = ledger.threadAccess(threadId);
    // Written last before contacting the vendor, so that a crash mid-send reads as "maybe
    // delivered" and a failure before it leaves no entry that would block a retry.
    ledger.append({ ...base, ...route, state: 'submitting', hop, threadId, ...(steered ? { steered } : {}), messageSha256: sha256(message), messageChars: message.length });
  } catch (error) {
    if (!prior) Object.assign(error, { notSent: true, message: `${error.message}; nothing was sent` });
    throw error;
  }

  try {
    // A Codex chat the bridge makes: in this call, or in an earlier one, whose access only the
    // creating call records. Limit: a creating call whose answer was never recorded is missed.
    const unlisted = peer.vendor === 'codex' && (!threadId || Boolean(threadAccess));
    const result = await adapter({
      threadId: threadId ?? undefined,
      message: stampMessage({ message, from, requestId, hop, maxHops, unlisted }),
      marker: requestMarker(requestId),
      title: threadTitle({ from, peer: peer.name, project, message }),
      model,
      effort: level,
      write,
      threadAccess,
      cwd: project,
      onThread: (id) => ledger.append({ requestId, state: 'thread', threadId: id }),
      // For an adapter that can choose between destinations.
      requestId,
      from,
      peer: peer.name,
      hop,
      maxHops,
      pinned: Boolean(request.threadId || request.newThread),
      noWait: Boolean(request.noWait),
    });
    const delivery = result.delivery ? { delivery: result.delivery } : {};
    // A delivery that went through but with something the caller should know.
    const warning = result.warning ? { warning: result.warning } : {};
    // A Codex turn that sets no access runs with the thread's own, so the ledger says what that is.
    const access = result.access ?? (peer.vendor === 'codex' ? ledger.threadAccess(result.threadId) : null);
    const applies = result.effort ? { effort: result.effort } : {};
    const notApplied = dropped(result.delivery, request.named);
    const applied = { ...(access ? { access } : {}), ...applies };
    // Only the call that made a thread records its access: a later resume with write may not stick.
    const recorded = threadId ? applies : applied;
    nameStanding({ request, ledger, route, result, attendedChat });
    if (request.noWait) {
      ledger.append({ requestId, ...route, state: 'sent', threadId: result.threadId, ...delivery, ...recorded });
      return { ...base, state: 'sent', threadId: result.threadId, continued: Boolean(threadId), ...delivery, ...applied, ...notApplied, ...warning, note: NOTES.sent };
    }
    // Sizes and the vendor's token figures, for measuring what calls cost. Never the text.
    const cost = { replyChars: result.reply.length, ...(result.usage ? { usage: result.usage } : {}) };
    ledger.append({ requestId, ...route, state: 'answered', threadId: result.threadId, ...delivery, ...recorded, ...cost });
    return { ...base, state: 'answered', threadId: result.threadId, continued: result.continued ?? Boolean(threadId), ...delivery, ...applied, ...notApplied, ...warning, reply: result.reply };
  } catch (error) {
    ledger.append({ requestId, state: 'failed', sent: !error.notSent, error: error.message });
    // An adapter that refuses an attempt says why. Recorded as possibly sent, since an earlier
    // attempt was, so a later retry looks for the answer first.
    if (error.refused) return { ...base, state: 'refused', threadId: request.threadId ?? null, note: error.message };
    throw error;
  }
}
