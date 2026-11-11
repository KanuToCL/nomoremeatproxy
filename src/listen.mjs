// The listening loop a Claude chat runs in the desktop app: keep a heartbeat so callers know
// the chat is attended, and emit each incoming request once. Also the line printed for it.
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Every request line says how to show it, so the owner sees the incoming message even when
// the chat no longer remembers the rule. The instruction comes before the message, which
// comes last because a long notification is cut off at the end. Kept short: it is paid for
// on every request.
export function requestLine({ requestId, from, hop, maxHops, file, message }) {
  const instruction = `Before anything else you write in the chat, quote the whole message and name ${from} as its sender. If message is cut off in this line, read all of it from file first. Then write your answer, then send that same answer with: nomeat reply --request-id ${requestId}`;
  return { requestId, from, hop, maxHops, file, instruction, message };
}

// `holdClaim`, asked when the loop ends without an error, says whether to leave the claim live
// for the chat's next start (`listen --once`) instead of releasing it.
export async function runListener({ mailbox, box, session, emit, onHeartbeat = () => {}, stopped = () => false, holdClaim = () => false, sleep = wait, now = () => Date.now(), pollMs = 1000, beatMs = 5000 }) {
  const lease = mailbox.claimListener(box, session);
  let hold = false;
  try {
    mailbox.purge();
    let lastBeat = -Infinity;
    while (!stopped()) {
      const renew = now() - lastBeat >= beatMs;
      const requests = lease.poll(renew);
      if (requests === null) break;
      if (renew) lastBeat = now();
      for (const request of requests) emit(request);
      if (renew) onHeartbeat();
      await sleep(pollMs);
    }
    hold = holdClaim();
  } finally {
    if (hold) lease.hold();
    else lease.release();
  }
}
