// Which chat may be a route's standing thread, and naming one by hand.
//
// The standing thread is continued without the app. A Claude chat that answers from its app
// must therefore never be one: continuing it would put a second writer on a live chat.
import path from 'node:path';

// The desktop app shows a session id with a `local_` prefix; the files and the ledger do not.
const chatId = (id) => String(id ?? '').replace(/^local_/, '').toLowerCase();

// Returns a function that says why a chat cannot be a standing thread, or null when it can.
// A chat is known to answer from its app when it is listening now, in any project, or when
// the ledger holds an answer it gave that way.
export function attendedChats({ ledger, mailbox }) {
  return (threadId) => {
    const same = (other) => Boolean(other) && chatId(other) === chatId(threadId);
    if (mailbox.listeners().some((listener) => same(listener.session))) return 'is listening in its app';
    if (ledger.entries().some((entry) => entry.delivery === 'attended' && same(entry.threadId))) return 'has answered from its app';
    return null;
  };
}

export function nameStandingThread({ ledger, attendedChat, route, threadId }) {
  const reason = threadId === null ? null : attendedChat(threadId);
  if (reason) throw new Error(`chat ${threadId} ${reason}, so it cannot be the standing thread: that one is continued without the app`);
  return ledger.append({ ...route, state: 'standing', threadId });
}

export function standingSnapshot(ledger, route) {
  const standing = ledger.standingThread(route);
  const fallback = ledger.lastThread(route);
  return { standing, fallback, destination: standing ?? fallback ?? 'new chat' };
}

export function standingFeedback({ route, before, after, executable, cli, stateDir, platform = process.platform }) {
  const args = [cli, 'standing', '--to', route.peer, '--from', route.from, '--cwd', route.project,
    ...(before.standing === null ? ['--clear'] : ['--thread', before.standing])];
  // The display command is for the native shell; argv is also supplied without shell parsing.
  const quote = platform === 'win32'
    ? value => `'${value.replaceAll("'", "''")}'`
    : value => `'${value.replaceAll("'", "'\\''")}'`;
  const location = path.resolve(stateDir);
  const invocation = `${platform === 'win32' ? '& ' : ''}${[executable, ...args].map(quote).join(' ')}`;
  const command = platform === 'win32'
    ? `& { $oldState = $env:NOMEAT_STATE_DIR; try { $env:NOMEAT_STATE_DIR = ${quote(location)}; ${invocation} } finally { $env:NOMEAT_STATE_DIR = $oldState } }`
    : `NOMEAT_STATE_DIR=${quote(location)} ${invocation}`;
  return {
    before, after,
    change: `${before.destination} -> ${after.destination}`,
    affected: `Only future default calls with --cwd ${JSON.stringify(route.project)}, --from ${JSON.stringify(route.from)}, --to ${JSON.stringify(route.peer)} (no --thread or --new), when a Claude listener does not take precedence.`,
    unaffected: 'Explicit --thread calls, --new side threads, other projects/callers/peers, listener registrations, chat settings and past ledger events. Nothing was sent.',
    restore: { command, executable, args, environment: { NOMEAT_STATE_DIR: location } },
    note: 'routing configured; delivery not tested',
  };
}
