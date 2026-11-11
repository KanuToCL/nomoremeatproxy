// Wire new Claude Desktop imports to an owner's explicitly bound, attended coordinator.
// No headless fallback: only the Desktop session tools can change and verify this switch.
import path from 'node:path';
import { mailboxKey } from './mailbox.mjs';
import { resolvePeer } from './peers.mjs';
import { sessionId } from './remote-control-store.mjs';

export function provisionNewChat({ outcome, vendor, optOut, store, createdForRequest }) {
  if (vendor !== 'claude' || optOut || outcome.state !== 'answered' || outcome.delivery !== 'headless'
      || outcome.continued !== false || !outcome.app?.opened) return;
  // The ID is the session returned by this creation, never an ID in a user's prompt.
  try {
    if (!createdForRequest(outcome.threadId)) throw new Error('Desktop target differs from the session ID allocated by the bridge; not enrolled');
    outcome.app.remoteControl = store.enqueue(outcome.threadId);
  }
  catch (error) { outcome.app.remoteControl = { state: 'setup-error', reason: error.message }; }
}

function liveIdentity(values, mailbox) {
  const peer = resolvePeer(values.as);
  if (peer.vendor !== 'claude') throw new Error('The coordinator must be a Claude Desktop peer');
  const box = { peer: peer.name, project: path.resolve(values.cwd ?? process.cwd()) };
  const session = sessionId(values.thread);
  const live = mailbox.listener(box)?.session;
  if (!live || sessionId(live) !== session) throw new Error('Start the named Desktop chat listener in this project first; its ID must match --thread');
  return { key: mailboxKey(box), session };
}

export function remoteCommand(action, values, { store, mailbox }) {
  if (action === 'enable' || action === 'work') {
    const { key, session } = liveIdentity(values, mailbox);
    if (action === 'enable') return store.bind(key, session);
    return {
      jobs: store.work(key, session),
      instructions: 'For listed targets only, recheck work before acting. Call native get_session(local_<target>), set_remote_control(enabled=true) if needed, then get_session again. Report active only if that session shows remoteControlState on AND remoteControlActive true. If import or connection is delayed, leave pending. Report approval-required or unavailable if blocked. Never use headless or change global settings.',
      report: 'nomeat remote-control report --target <target> --receipt <receipt> --result active|approval-required|unavailable',
    };
  }
  if (action === 'disable') return store.disable();
  if (action === 'status') return store.status(values.target);
  if (action === 'report') return store.report(values.target, values.receipt, values.result);
  if (action === 'retry') return store.retry(values.target);
  throw new Error('remote-control needs enable, disable, status, work, report, or retry');
}

// The listener announces durable work, not a regular peer call. Missing Desktop/offline:
// jobs survive. Unacknowledged notices are reissued and enabling an already-on chat is safe.
export function notifyRemoteWork({ store, box, session, emit, warn }) {
  if (!session) return () => {};
  let lastError;
  return () => {
    try {
      const targets = store.due(mailboxKey(box), sessionId(session));
      if (targets.length) emit({
        kind: 'remote-control', message: 'ASK: Enable and verify Remote Control for new bridge chats. Run the work command below, follow its Desktop instructions, then report each result. Do not use nomeat reply.',
        args: ['remote-control', 'work', '--as', box.peer, '--thread', session, '--cwd', box.project],
      });
      lastError = undefined;
    } catch (error) {
      if (lastError !== error.message) warn(`Remote Control check skipped: ${error.message}`);
      lastError = error.message;
    }
  };
}
