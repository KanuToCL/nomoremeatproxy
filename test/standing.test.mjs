import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { callPeer } from '../src/call.mjs';
import { openLedger } from '../src/ledger.mjs';
import { openMailbox } from '../src/mailbox.mjs';
import { attendedChats, nameStandingThread, standingFeedback, standingSnapshot } from '../src/standing.mjs';

const CHAT = '11111111-1111-4111-8111-111111111111';
const ROUTE = Object.freeze({ project: '/work/app', from: 'astra', peer: 'fable' });
const PEER = Object.freeze({ name: 'fable', vendor: 'claude', model: 'claude-test' });

// The real ledger and mailbox on a throwaway folder: the guard reads both.
function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nomeat-standing-'));
  const ledger = openLedger(dir);
  const mailbox = openMailbox(dir);
  return { ledger, mailbox, attendedChat: attendedChats({ ledger, mailbox }) };
}

test('a thread that never answered from its app can be named as the standing one', () => {
  const { ledger, attendedChat } = setup();
  ledger.append({ requestId: 'req-1', ...ROUTE, state: 'answered', threadId: 'thread-1', delivery: 'headless' });
  nameStandingThread({ ledger, attendedChat, route: ROUTE, threadId: 'thread-1' });
  assert.equal(ledger.standingThread(ROUTE), 'thread-1');
});

test('a chat that has answered from its app cannot be named, however its id is written', () => {
  const { ledger, attendedChat } = setup();
  ledger.append({ requestId: 'req-1', ...ROUTE, project: '/work/other', state: 'answered', threadId: CHAT, delivery: 'attended' });
  for (const id of [CHAT, `local_${CHAT}`, CHAT.toUpperCase()]) {
    assert.throws(() => nameStandingThread({ ledger, attendedChat, route: ROUTE, threadId: id }), /has answered from its app/);
  }
  assert.equal(ledger.standingThread(ROUTE), null);
});

test('a chat that is listening now cannot be named, even when it listens for another project', (t) => {
  const { ledger, mailbox, attendedChat } = setup();
  const lease = mailbox.claimListener({ project: '/work/other', peer: 'opus' }, `local_${CHAT}`);
  t.after(() => lease.release?.());
  assert.throws(() => nameStandingThread({ ledger, attendedChat, route: ROUTE, threadId: CHAT }), /is listening in its app/);
  assert.equal(ledger.standingThread(ROUTE), null);
});

test('a call that would make such a chat the standing thread is refused before anything is sent', async () => {
  const { ledger, attendedChat } = setup();
  ledger.append({ requestId: 'old-1', ...ROUTE, state: 'answered', threadId: CHAT, delivery: 'attended' });
  const sent = [];
  const adapter = async (args) => sent.push(args);
  const outcome = await callPeer(
    { peer: PEER, message: 'ping', from: 'astra', project: '/work/app', requestId: 'req-1', threadId: CHAT, makeStanding: true },
    { ledger, adapters: { claude: adapter }, attendedChat },
  );
  assert.equal(outcome.state, 'refused');
  assert.match(outcome.note, /answers from its own app/);
  assert.deepEqual(sent, []);
  assert.deepEqual(ledger.history('req-1'), []);
  assert.equal(ledger.standingThread(ROUTE), null);
});

// --- what `nomeat standing` prints ---

const cli = fileURLToPath(new URL('../bin/nomeat.mjs', import.meta.url));
const standing = (dir) => {
  const run = spawnSync(process.execPath, [cli, 'standing', '--to', 'fable', '--from', 'astra', '--cwd', path.join(dir, 'app')], {
    env: { ...process.env, NOMEAT_STATE_DIR: dir },
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
};

test('standing that finds nothing names the state folder it read and that both sides must share it', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nomeat-standing-'));
  const shown = standing(dir);
  assert.equal(shown.threadId, null);
  assert.equal(shown.stateDir, dir);
  assert.match(shown.note, /in this state folder; both sides must use the same one \(NOMEAT_STATE_DIR\)/);
});

test('standing that finds a thread adds no note', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nomeat-standing-'));
  openLedger(dir).append({ project: path.join(dir, 'app'), from: 'astra', peer: 'fable', state: 'standing', threadId: 'thread-1' });
  const shown = standing(dir);
  assert.equal(shown.threadId, 'thread-1');
  assert.equal(Object.hasOwn(shown, 'note'), false);
});

test('the same call without --standing still goes where it says and names nothing', async () => {
  const { ledger, attendedChat } = setup();
  ledger.append({ requestId: 'old-1', ...ROUTE, state: 'answered', threadId: CHAT, delivery: 'attended' });
  const adapter = async (args) => ({ threadId: args.threadId, reply: 'pong', delivery: 'headless' });
  const outcome = await callPeer(
    { peer: PEER, message: 'ping', from: 'astra', project: '/work/app', requestId: 'req-1', threadId: CHAT },
    { ledger, adapters: { claude: adapter }, attendedChat },
  );
  assert.equal(outcome.state, 'answered');
  assert.equal(ledger.standingThread(ROUTE), null);
});

test('clearing restores unnamed fallback semantics by appending, without removing earlier events', () => {
  const { ledger, attendedChat } = setup();
  ledger.append({ requestId: 'answer', ...ROUTE, state: 'answered', threadId: 'fallback', delivery: 'headless' });
  const before = standingSnapshot(ledger, ROUTE);
  nameStandingThread({ ledger, attendedChat, route: ROUTE, threadId: 'named' });
  assert.equal(standingSnapshot(ledger, ROUTE).destination, 'named');
  nameStandingThread({ ledger, attendedChat, route: ROUTE, threadId: null });
  assert.deepEqual(standingSnapshot(ledger, ROUTE), before);
  nameStandingThread({ ledger, attendedChat, route: ROUTE, threadId: null });
  assert.deepEqual(standingSnapshot(ledger, ROUTE), before);
  assert.deepEqual(ledger.entries().map(event => event.threadId), ['fallback', 'named', null, null]);
});

test('binding feedback is route-scoped, restores named or unnamed destinations and claims no delivery test', () => {
  const { ledger } = setup();
  const before = standingSnapshot(ledger, ROUTE);
  const after = { standing: 'destination', fallback: null, destination: 'destination' };
  const result = standingFeedback({ route: ROUTE, before, after, executable: '/node', cli: '/bridge/bin/nomeat.mjs', stateDir: '/state' });
  assert.equal(result.change, 'new chat -> destination');
  assert.match(result.affected, /--from "astra".*--to "fable".*no --thread or --new/);
  assert.match(result.unaffected, /Explicit --thread.*other projects\/callers\/peers.*Nothing was sent/);
  assert.equal(result.restore.args.at(-1), '--clear');
  assert.equal(result.note, 'routing configured; delivery not tested');
  const named = standingFeedback({ route: ROUTE, before: after, after: before, executable: '/node', cli: '/bridge/bin/nomeat.mjs', stateDir: '/state' });
  assert.deepEqual(named.restore.args.slice(-2), ['--thread', 'destination']);
});

test('restoration commands quote outside route values for the native shell', () => {
  const args = { route: { ...ROUTE, from: "caller's $name" }, before: { standing: null, destination: 'new chat' }, after: { destination: 'next' }, executable: 'node', cli: '/bridge/cli', stateDir: '/state' };
  assert.ok(standingFeedback({ ...args, platform: 'win32' }).restore.command.includes("& 'node'"));
  assert.ok(standingFeedback({ ...args, platform: 'win32' }).restore.command.includes("'caller''s $name'"));
  assert.ok(standingFeedback({ ...args, platform: 'linux' }).restore.command.includes("'caller'\\''s $name'"));
  assert.match(standingFeedback({ ...args, platform: 'win32' }).restore.command, /finally.*\$env:NOMEAT_STATE_DIR = \$oldState/);
  assert.ok(standingFeedback({ ...args, platform: 'linux' }).restore.command.startsWith('NOMEAT_STATE_DIR='));
});
