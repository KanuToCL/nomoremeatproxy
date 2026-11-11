// Hands a call to a Claude chat that is listening in the desktop app, so that chat answers
// itself. The alternative, a headless run on the same session, would be a second writer.
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_MS = 500;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const notSent = (message) => Object.assign(new Error(message), { notSent: true });
const HELD = 'the request was already handed to a listening chat and its answer has not come; send a new request if it is still needed';

export async function deliverToAttended({ mailbox, box, listener, request, timeoutMs = DEFAULT_TIMEOUT_MS, pollMs = POLL_MS, sleep = wait, now = () => Date.now() }) {
  mailbox.post({ ...box, ...request });
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const reply = mailbox.takeReply(request.requestId);
    if (reply !== null) return { threadId: listener.session, reply, delivery: 'attended', continued: true };
    if (!mailbox.listener(box) && mailbox.withdraw(request.requestId)) {
      throw notSent('the attended Claude chat stopped listening before it took the message');
    }
    await sleep(pollMs);
  }
  if (mailbox.withdraw(request.requestId)) throw notSent('the attended Claude chat did not take the message in time');
  throw new Error(`the attended Claude chat took the message but did not answer within ${Math.round(timeoutMs / 1000)} s`);
}

// Sends to the listening chat when there is one and the caller did not name a destination;
// otherwise, or when that chat cannot take the message, runs headless.
export function routeClaude({ mailbox, headless, isWaitingOn, deliver = deliverToAttended }) {
  return async (args) => {
    if (args.noWait) throw notSent('sending without waiting is only available for Codex peers');
    // A resend of a request a chat still holds is refused at once, listening or not: a chat
    // that stopped listening may still be working on it, and a headless run would be a copy.
    if (!args.pinned && mailbox.taken(args.requestId)) throw Object.assign(new Error(HELD), { refused: true });
    const box = { project: args.cwd, peer: args.peer };
    const listener = args.pinned ? null : mailbox.listener(box);
    // A chat that is itself waiting for this caller's answer cannot reply; a headless run can.
    if (!listener || isWaitingOn({ project: args.cwd, from: args.peer, peer: args.from })) return headless(args);
    const request = { requestId: args.requestId, from: args.from, hop: args.hop, maxHops: args.maxHops, message: args.message };
    try {
      return await deliver({ mailbox, box, listener, request, timeoutMs: args.timeoutMs });
    } catch (error) {
      if (!error.notSent) throw error;
      return headless(args);
    }
  };
}

// For a retry: the answer may have arrived after the caller stopped waiting.
export const recoverAttendedReply = (mailbox) => async ({ requestId }) => {
  const reply = mailbox.takeReply(requestId);
  return reply === null ? null : { reply, delivery: 'attended' };
};
