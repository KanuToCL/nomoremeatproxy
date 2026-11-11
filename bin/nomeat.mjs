#!/usr/bin/env node
// Entry point: parse arguments, wire the pieces, print one JSON result.
// Sections: help / call and standing / history / listener and reply / follow-up / dispatch.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { callClaude, openInClaudeApp } from '../src/adapters/claude.mjs';
import { recoverAttendedReply, routeClaude } from '../src/adapters/claude-attended.mjs';
import { callCodex, checkCodexRequest, recoverCodexReply } from '../src/adapters/codex.mjs';
import { openNewCodexThread } from '../src/adapters/codex-app.mjs';
import { callPeer } from '../src/call.mjs';
import { checkRequest, sentWithoutWaiting } from '../src/check.mjs';
import { findThreads, readConversation, readThread } from '../src/history/index.mjs';
import { validateCompactOptions } from '../src/history/compact.mjs';
import { defaultStateDir, openLedger } from '../src/ledger.mjs';
import { requestLine, runListener } from '../src/listen.mjs';
import { openMailbox } from '../src/mailbox.mjs';
import { orient } from '../src/orient.mjs';
import { DEFAULT_PEERS, resolvePeer } from '../src/peers.mjs';
import { notifyRemoteWork, provisionNewChat, remoteCommand } from '../src/remote-control.mjs';
import { remoteStore } from '../src/remote-control-store.mjs';
import { attendedChats, nameStandingThread, standingFeedback, standingSnapshot } from '../src/standing.mjs';
import { summarizeCalls } from '../src/stats.mjs';

const USAGE = `usage:
  nomeat call --to <peer> --from <caller> [--message <text>] [options]
  nomeat orient [--cwd <project>] [--from <caller>]
  nomeat standing --to <peer> --from <caller> [--thread <id> | --clear]
  nomeat find --side <codex|claude> [--search <title words>] [--text <message words>] [--project] [--limit <n>]
  nomeat read --side <codex|claude> --thread <id> [--turns <n>] [--budget <bytes>] [--cursor <cursor>] [--tools | --raw]
  nomeat listen --as <peer> [--thread <this chat's id>] [--once]
  nomeat reply --request-id <id> [--message <text>]
  nomeat check [--request-id <id>] [--since <ISO date>]
  nomeat stats [--since <ISO date>]
  nomeat peers
  nomeat remote-control enable --as <peer> --thread <listening Desktop chat ID> [--cwd <project>]
  nomeat remote-control status [--target <id>] | disable | retry --target <id>

call: the message is read from stdin when --message is omitted. Without --thread, the call
goes to a Claude chat that is listening (see listen), or else continues the standing thread
between this caller and peer in this project. The first call names that thread.
  --thread <id>        send into this exact thread; the standing thread stays as it is
  --new                start a side thread; later calls still continue the standing one
  --standing           make the thread of this call the standing one from now on
  --effort <level>     thinking level, passed to the vendor as given (default: the peer's)
  --model <id>         override the peer's default model
  --write              let the peer edit files in the working directory (default: read-only)
  --no-open            do not open a new chat in the peer's desktop app to list it there
  --no-remote-control  skip automatic Remote Control setup for this new chat
  --no-wait            send and return at once; the reply does not come back to this call
                       (Codex peers, into a thread the Codex app has open)
  --request-id <id>    reuse on a retry so the message is not sent twice
  --force              resend although the ledger shows an earlier attempt
  --hop <n>            position in the exchange, starting at 1
  --max-hops <n>       hop limit (default 4)
  --cwd <dir>          project directory for the peer (default: current)

listen: run by a Claude chat in its app so that calls to that peer name in this project reach
the chat itself. Prints one JSON line per incoming request; answer each with reply.
Only one chat can listen per project and peer. Pass --thread to allow that chat to restart
without waiting for its old heartbeat to expire. --once (needs --thread) exits after the first
output, for running as a background command; start it again at once to keep listening.

standing: show which thread calls between this caller and peer continue in this project.
With --thread, name that thread as the standing one; --clear restores unnamed fallback
behavior. Both append ledger events, send nothing and print a restoration command.

orient: resolved project (--cwd or current directory), state access advisory, outgoing and
incoming routes, listener registrations and role-specific next steps. No writes or messages.
Registrations and permission checks do not prove delivery or sandbox write access.

read: compact user/assistant conversation by default, newest 2 visible turns in chronological
order. --tools includes tool details. Synthetic notifications/compaction context are counted
but excluded. --budget bounds the entire minified JSON plus newline in UTF-8 bytes (default
16000, minimum 2048). --max-chars limits each text fragment (default 4000 UTF-16 units).
Use nextCursor with --cursor (same side/thread/--tools) to continue, including inside long
messages; once complete, olderCursor reads the preceding visible-turn window. --turns is
ignored on continuation. --raw restores the old tool-inclusive shape,
raw-turn selection and per-item --max-chars clipping; it cannot use --tools/--budget/--cursor.

find: --search matches titles. --text finds chats where one message of the person or the
assistant holds all the words, in the most recent chats only; with both, both must match.
--project keeps only chats whose folder is this project (or --cwd), so a chat is found even
when its title does not mention the project.

check: follow up on a message sent with --no-wait. Says whether the peer has not started on
it, is working on it, or has finished, and gives the reply when there is one. Without
--request-id it checks every such message of this project from the last 24 hours.

exit codes: 0 done, 1 failed, 2 usage, 3 not sent (duplicate, uncertain or refused)`;

const NOT_SENT = new Set(['duplicate', 'uncertain', 'refused']);
// How long a sent call is assumed to be still running: the adapters' own time limit.
const OPEN_CALL_MAX_AGE_MS = 10 * 60 * 1000;

class UsageError extends Error {}

function positiveInteger(value, name) {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new UsageError(`${name} must be a positive safe integer`);
  return number;
}

const print = (value) => console.log(JSON.stringify(value, null, 2));

async function runCall(values) {
  if (!values.to) throw new UsageError('--to is required');
  if (!values.from) throw new UsageError('--from is required: name the assistant that is calling');
  const message = values.message ?? readFileSync(0, 'utf8');
  if (!message.trim()) throw new UsageError('the message is empty');
  const peer = resolvePeer(values.to, { model: values.model, effort: values.effort });
  const project = path.resolve(values.cwd ?? process.cwd());
  const stateDir = defaultStateDir();
  const ledger = openLedger(stateDir);
  const mailbox = openMailbox(stateDir);
  const claude = routeClaude({
    mailbox,
    headless: callClaude,
    isWaitingOn: (route) => Boolean(ledger.openCall({ ...route, maxAgeMs: OPEN_CALL_MAX_AGE_MS })),
  });
  const outcome = await callPeer(
    {
      peer,
      message,
      from: values.from,
      project,
      threadId: values.thread,
      newThread: values.new,
      makeStanding: values.standing,
      noWait: values.wait === false,
      requestId: values['request-id'],
      effort: peer.effort,
      // Only what the caller typed: a dropped peer default is not worth reporting.
      named: ['model', 'effort'].filter((name) => values[name] !== undefined),
      write: values.write,
      force: values.force,
      hop: positiveInteger(values.hop, '--hop'),
      maxHops: positiveInteger(values['max-hops'], '--max-hops'),
    },
    {
      ledger,
      adapters: { codex: callCodex, claude },
      recoverers: { codex: recoverCodexReply, claude: recoverAttendedReply(mailbox) },
      attendedChat: attendedChats({ ledger, mailbox }),
    },
  );
  // New Claude sessions are listed in the app by default, so the owner sees them as chats.
  const open = values.open ?? !outcome.continued;
  if (open && outcome.state === 'answered' && peer.vendor === 'claude') {
    outcome.app = await openInClaudeApp(outcome.threadId, { cwd: project });
    provisionNewChat({
      outcome, vendor: peer.vendor, optOut: values['remote-control'] === false, store: remoteStore(stateDir),
      createdForRequest: id => ledger.history(outcome.requestId).some(r => r.state === 'thread' && r.threadId === id),
    });
  }
  // A Codex thread the call created is opened by its link, so that the Codex app lists it.
  if (peer.vendor === 'codex') await openNewCodexThread({ outcome, optOut: values.open === false });
  print(outcome);
  return NOT_SENT.has(outcome.state) ? 3 : 0;
}

async function runStanding(values) {
  if (!values.to) throw new UsageError('--to is required');
  if (!values.from) throw new UsageError('--from is required: name the assistant that calls');
  if (values.clear && values.thread !== undefined) throw new UsageError('--clear and --thread cannot be used together');
  if (values.thread !== undefined && !values.thread.trim()) throw new UsageError('--thread is empty');
  const route = { project: path.resolve(values.cwd ?? process.cwd()), from: values.from, peer: resolvePeer(values.to).name };
  const stateDir = defaultStateDir();
  const ledger = openLedger(stateDir);
  const before = standingSnapshot(ledger, route);
  if (values.thread || values.clear) {
    nameStandingThread({ ledger, attendedChat: attendedChats({ ledger, mailbox: openMailbox(stateDir) }), route, threadId: values.clear ? null : values.thread });
  }
  const threadId = ledger.standingThread(route);
  // Until a standing thread is named, calls continue the last answered one.
  const untilNamed = threadId ? undefined : ledger.lastThread(route);
  const changed = Boolean(values.thread || values.clear);
  const missing = threadId || untilNamed ? null : ledger.notFound('no standing or answered thread for this route');
  print({ ...route, threadId, ...(threadId ? {} : { untilNamed }),
    ...(missing ? { stateDir: missing.stateDir, [changed ? 'stateNote' : 'note']: missing.note } : {}),
    ...(changed ? standingFeedback({ route, before, after: standingSnapshot(ledger, route), executable: process.execPath, cli: fileURLToPath(import.meta.url), stateDir }) : {}),
  });
  return 0;
}

async function runFind(values) {
  const project = values.project ? path.resolve(values.cwd ?? process.cwd()) : undefined;
  if (values.text !== undefined && !values.text.trim()) throw new UsageError('--text is empty');
  print(await findThreads({ side: values.side, search: values.search, text: values.text, limit: positiveInteger(values.limit, '--limit'), project }));
  return 0;
}

async function runRead(values) {
  const side = values.side?.toLowerCase();
  if (!['codex', 'claude'].includes(side)) throw new UsageError('--side must be one of: codex, claude');
  if (!values.thread) throw new UsageError('--thread is required');
  if (values.raw && (values.tools || values.budget !== undefined || values.cursor !== undefined)) throw new UsageError('--raw cannot use --tools, --budget or --cursor');
  const options = { side, threadId: values.thread,
    turns: positiveInteger(values.turns, '--turns'), maxChars: positiveInteger(values['max-chars'], '--max-chars'),
    budget: positiveInteger(values.budget, '--budget'), cursor: values.cursor, tools: values.tools,
  };
  if (values.raw) print(await readThread(options));
  else {
    try { validateCompactOptions(options); } catch (error) { throw new UsageError(error.message); }
    process.stdout.write(`${JSON.stringify(await readConversation(options))}\n`);
  }
  return 0;
}

async function runListen(values) {
  if (!values.as) throw new UsageError('--as is required: the peer name this chat answers to');
  const box = { project: path.resolve(values.cwd ?? process.cwd()), peer: resolvePeer(values.as).name };
  // The claim kept after a --once exit can only be taken over by a start that names the chat.
  if (values.once && !values.thread) throw new UsageError('--once needs --thread, so that the next start can take over');
  const mailbox = openMailbox(defaultStateDir());
  let stopped = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => (stopped = true));
  let printed = false;
  const line = (value) => {
    console.log(JSON.stringify(value));
    printed = true;
  };
  // With --once: stop after the round that printed something, and keep the claim for the next start.
  const done = () => values.once && printed;
  await runListener({
    mailbox,
    box,
    session: values.thread ?? null,
    onHeartbeat: notifyRemoteWork({
      store: remoteStore(defaultStateDir()), box, session: values.thread,
      emit: line, warn: (note) => console.error(note),
    }),
    stopped: () => stopped || done(),
    holdClaim: () => !stopped && done(),
    // One line per request: the app turns each line into a notification for the chat.
    emit: (request) => line(requestLine(request)),
  });
  return 0;
}

async function runReply(values) {
  if (!values['request-id']) throw new UsageError('--request-id is required');
  const reply = values.message ?? readFileSync(0, 'utf8');
  if (!reply.trim()) throw new UsageError('the reply is empty');
  openMailbox(defaultStateDir()).answer(values['request-id'], reply);
  print({ requestId: values['request-id'], state: 'replied' });
  return 0;
}

const DAY_MS = 24 * 60 * 60 * 1000;

async function runCheck(values) {
  const ledger = openLedger(defaultStateDir());
  const checkers = { codex: checkCodexRequest };
  if (values['request-id']) {
    print(await checkRequest(values['request-id'], { ledger, checkers }));
    return 0;
  }
  const project = path.resolve(values.cwd ?? process.cwd());
  const since = values.since ?? new Date(Date.now() - DAY_MS).toISOString();
  const results = [];
  for (const requestId of sentWithoutWaiting(ledger.entries(), { project, since })) {
    results.push(await checkRequest(requestId, { ledger, checkers }));
  }
  print({ project, since, requests: results });
  return 0;
}

async function runStats(values) {
  const project = path.resolve(values.cwd ?? process.cwd());
  print({
    project,
    since: values.since ?? null,
    groups: summarizeCalls(openLedger(defaultStateDir()).entries(), { project, since: values.since }),
    note: 'Token figures exist only where the vendor reports them to the bridge: direct Codex calls and headless Claude calls. They cover the peer that answered, not the caller.',
  });
  return 0;
}

const COMMANDS = Object.freeze({
  orient: async values => { print(orient({ cwd: values.cwd, from: values.from })); return 0; },
  call: runCall,
  standing: runStanding,
  find: runFind,
  read: runRead,
  listen: runListen,
  reply: runReply,
  check: runCheck,
  stats: runStats,
  peers: async () => {
    print(DEFAULT_PEERS);
    return 0;
  },
});

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    allowNegative: true,
    options: {
      to: { type: 'string' },
      from: { type: 'string' },
      as: { type: 'string' },
      message: { type: 'string' },
      thread: { type: 'string' },
      effort: { type: 'string' },
      model: { type: 'string' },
      'request-id': { type: 'string' },
      hop: { type: 'string' },
      'max-hops': { type: 'string' },
      cwd: { type: 'string' },
      side: { type: 'string' },
      search: { type: 'string' },
      text: { type: 'string' },
      since: { type: 'string' },
      limit: { type: 'string' },
      turns: { type: 'string' },
      'max-chars': { type: 'string' },
      budget: { type: 'string' },
      cursor: { type: 'string' },
      tools: { type: 'boolean', default: false },
      raw: { type: 'boolean', default: false },
      clear: { type: 'boolean', default: false },
      open: { type: 'boolean' },
      'remote-control': { type: 'boolean' },
      target: { type: 'string' },
      receipt: { type: 'string' },
      result: { type: 'string' },
      wait: { type: 'boolean' },
      new: { type: 'boolean', default: false },
      standing: { type: 'boolean', default: false },
      project: { type: 'boolean', default: false },
      write: { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      once: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  const command = positionals[0];
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (command === 'remote-control') {
    const dir = defaultStateDir();
    print(remoteCommand(positionals[1], values, { store: remoteStore(dir), mailbox: openMailbox(dir) }));
    return 0;
  }
  if (!command || !Object.hasOwn(COMMANDS, command)) {
    throw new UsageError(command ? `unknown command "${command}"` : 'a command is required');
  }
  return COMMANDS[command](values);
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    const usage = error instanceof UsageError || error.code?.startsWith?.('ERR_PARSE_ARGS');
    console.error(usage ? `${error.message}\n\n${USAGE}` : `nomeat failed: ${error.message}`);
    process.exit(usage ? 2 : 1);
  },
);
