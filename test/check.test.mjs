import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { describeRequestTurn } from '../src/adapters/codex.mjs';
import { callPeer } from '../src/call.mjs';
import { checkRequest, sentWithoutWaiting } from '../src/check.mjs';
import { openLedger } from '../src/ledger.mjs';

const PEER = Object.freeze({ name: 'astra', vendor: 'codex', model: 'gpt-6-astra' });
const freshLedger = () => openLedger(mkdtempSync(path.join(os.tmpdir(), 'nomeat-check-')));
const queueing = async (args) => ({ threadId: args.threadId, delivery: 'queued' });
const send = (ledger, overrides = {}) =>
  callPeer({ peer: PEER, message: 'do the thing', from: 'fable', project: '/work/app', requestId: 'req-1', threadId: 'thread-open', noWait: true, ...overrides }, { ledger, adapters: { codex: queueing } });

// --- where a request stands in its thread ---

const MARKER = 'request req-1;';
const turn = (text, status, { reply, error } = {}) => ({
  status,
  items: [{ type: 'userMessage', content: [{ type: 'text', text }] }, ...(reply ? [{ type: 'agentMessage', text: reply }] : [])],
  ...(error ? { error: { message: error } } : {}),
});

test('a request whose turn is not in the thread is waiting, idle only when the newest turn is seen finished', () => {
  for (const status of ['completed', 'failed']) {
    assert.deepEqual(describeRequestTurn([turn('earlier', status)], MARKER), { state: 'waiting', idle: true });
  }
  // A running turn shows `interrupted` from outside, so neither it nor an empty thread is seen idle.
  assert.deepEqual(describeRequestTurn([turn('earlier', 'completed'), turn('other', 'interrupted')], MARKER), { state: 'waiting', idle: false });
  assert.deepEqual(describeRequestTurn([], MARKER), { state: 'waiting', idle: false });
});

test('a finished turn is answered and carries the reply; a failed one carries the error', () => {
  assert.deepEqual(describeRequestTurn([turn(`[${MARKER}] x`, 'completed', { reply: 'done' })], MARKER), { state: 'answered', reply: 'done' });
  assert.deepEqual(describeRequestTurn([turn(`[${MARKER}] x`, 'failed', { error: 'usage limit' })], MARKER), { state: 'failed', error: 'usage limit' });
});

test('any other status means the peer is still working, including the one a running turn shows from outside', () => {
  assert.equal(describeRequestTurn([turn(`[${MARKER}] x`, 'interrupted')], MARKER).state, 'running');
  assert.equal(describeRequestTurn([turn(`[${MARKER}] x`, 'inProgress')], MARKER).state, 'running');
});

// --- following up ---

test('a message sent without waiting is looked up in its thread by its request marker', async () => {
  const ledger = freshLedger();
  await send(ledger);
  const asked = [];
  const outcome = await checkRequest('req-1', {
    ledger,
    checkers: {
      codex: async (query) => {
        asked.push(query);
        return { state: 'answered', reply: 'done at 4848f92' };
      },
    },
  });
  assert.deepEqual(asked, [{ threadId: 'thread-open', marker: 'request req-1;' }]);
  assert.equal(outcome.state, 'answered');
  assert.equal(outcome.reply, 'done at 4848f92');
  assert.equal(outcome.peer, 'astra');
  assert.equal(outcome.threadId, 'thread-open');
});

const SENT_AT = Date.parse('2026-11-11T12:00:00Z');
const sentAtNoon = () => openLedger(mkdtempSync(path.join(os.tmpdir(), 'nomeat-check-')), { now: () => new Date(SENT_AT) });
const notStarted = async () => ({ state: 'waiting', idle: false });

test('a message not started a minute or more after sending, in a chat not seen idle, claims no cause', async () => {
  const ledger = sentAtNoon();
  await send(ledger);
  const waiting = await checkRequest('req-1', { ledger, checkers: { codex: notStarted }, now: () => SENT_AT + 60_000 });
  assert.equal(waiting.note, 'the peer has not started on it; cause unknown');
  assert.doesNotMatch(waiting.note, /queued|busy/);
});

test('a message sent under a minute ago and not started yet says how long ago, without a cause', async () => {
  const ledger = sentAtNoon();
  await send(ledger);
  const waiting = await checkRequest('req-1', { ledger, checkers: { codex: notStarted }, now: () => SENT_AT + 14_500 });
  assert.equal(waiting.note, 'sent 14 seconds ago; the peer has not started on it yet');
});

test('an idle chat under a minute after sending gets the same note, not advice to send again', async () => {
  const ledger = sentAtNoon();
  await send(ledger);
  const waiting = await checkRequest('req-1', { ledger, checkers: { codex: async () => ({ state: 'waiting', idle: true }) }, now: () => SENT_AT + 5_000 });
  assert.equal(waiting.idle, true);
  assert.equal(waiting.note, 'sent 5 seconds ago; the peer has not started on it yet');
});

// The ledger's clock, moved by hand, so each entry gets the time the test gives it.
function clockedLedger() {
  const clock = { time: SENT_AT };
  return { clock, ledger: openLedger(mkdtempSync(path.join(os.tmpdir(), 'nomeat-check-')), { now: () => new Date(clock.time) }) };
}
const idleCheck = { codex: async () => ({ state: 'waiting', idle: true }) };

test('the time since sending counts from a later success, not from an attempt that failed before sending', async () => {
  const { clock, ledger } = clockedLedger();
  const refused = async () => {
    throw Object.assign(new Error('codex queue did not start'), { notSent: true });
  };
  await assert.rejects(callPeer({ peer: PEER, message: 'do the thing', from: 'fable', project: '/work/app', requestId: 'req-1', threadId: 'thread-open', noWait: true }, { ledger, adapters: { codex: refused } }));
  clock.time += 3600_000;
  await send(ledger);
  const waiting = await checkRequest('req-1', { ledger, checkers: idleCheck, now: () => clock.time + 5_000 });
  assert.equal(waiting.note, 'sent 5 seconds ago; the peer has not started on it yet');
  assert.equal(waiting.sentAt, new Date(clock.time).toISOString());
});

test('the time since sending counts from the handover, not from the start of a slow queue', async () => {
  const { clock, ledger } = clockedLedger();
  const slowQueue = async (args) => {
    clock.time += 90_000;
    return { threadId: args.threadId, delivery: 'queued' };
  };
  await callPeer({ peer: PEER, message: 'do the thing', from: 'fable', project: '/work/app', requestId: 'req-1', threadId: 'thread-open', noWait: true }, { ledger, adapters: { codex: slowQueue } });
  const waiting = await checkRequest('req-1', { ledger, checkers: idleCheck, now: () => clock.time + 5_000 });
  assert.equal(waiting.note, 'sent 5 seconds ago; the peer has not started on it yet');
  assert.equal(waiting.sentAt, new Date(clock.time).toISOString());
});

test('a message not started in an idle chat a minute or more after sending says so and what to do', async () => {
  const ledger = sentAtNoon();
  await send(ledger);
  const waiting = await checkRequest('req-1', { ledger, checkers: { codex: async () => ({ state: 'waiting', idle: true }) }, now: () => SENT_AT + 60_000 });
  assert.equal(waiting.idle, true);
  assert.match(waiting.note, /idle and has not picked the message up/);
  assert.match(waiting.note, /open the chat in the Codex app/);
  assert.match(waiting.note, /new call that waits/);
});

test('a message the peer is working on says so in plain words', async () => {
  const ledger = freshLedger();
  await send(ledger);
  const running = await checkRequest('req-1', { ledger, checkers: { codex: async () => ({ state: 'running' }) } });
  assert.match(running.note, /working on it now/);
});

test('an unknown request id is reported as unknown without asking the vendor', async () => {
  const outcome = await checkRequest('never-sent', { ledger: freshLedger(), checkers: { codex: async () => assert.fail('asked the vendor') } });
  assert.equal(outcome.state, 'unknown');
});

test('an unknown request names the state folder that was read and that both sides must share it', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nomeat-check-'));
  const outcome = await checkRequest('never-sent', { ledger: openLedger(dir) });
  assert.equal(outcome.stateDir, dir);
  assert.equal(outcome.note, 'no such request in this state folder; both sides must use the same one (NOMEAT_STATE_DIR)');
});

test('a call that already returned its reply is not looked up again', async () => {
  const ledger = freshLedger();
  await callPeer({ peer: PEER, message: 'ping', from: 'fable', project: '/work/app', requestId: 'req-1' }, { ledger, adapters: { codex: async () => ({ threadId: 'thread-1', reply: 'pong' }) } });
  const outcome = await checkRequest('req-1', { ledger, checkers: { codex: async () => assert.fail('asked the vendor') } });
  assert.equal(outcome.state, 'answered');
  assert.match(outcome.note, /came back to the call/);
});

test('a delivery that cannot be checked from outside says so', async () => {
  const ledger = freshLedger();
  await send(ledger);
  const outcome = await checkRequest('req-1', { ledger, checkers: {} });
  assert.equal(outcome.state, 'sent');
  assert.match(outcome.note, /cannot be checked/);
});

// --- which messages to follow up ---

test('the messages to follow up are those sent without waiting in this project, since a given time', async () => {
  let time = Date.parse('2026-11-10T12:00:00Z');
  const ledger = openLedger(mkdtempSync(path.join(os.tmpdir(), 'nomeat-check-')), { now: () => new Date(time) });
  await send(ledger, { requestId: 'early' });
  time += 3600_000;
  await send(ledger, { requestId: 'late' });
  await send(ledger, { requestId: 'elsewhere', project: '/work/other' });
  await callPeer({ peer: PEER, message: 'ping', from: 'fable', project: '/work/app', requestId: 'waited' }, { ledger, adapters: { codex: async () => ({ threadId: 't', reply: 'pong' }) } });
  assert.deepEqual(sentWithoutWaiting(ledger.entries(), { project: '/work/app' }), ['early', 'late']);
  assert.deepEqual(sentWithoutWaiting(ledger.entries(), { project: '/work/app', since: '2026-11-10T12:30:00.000Z' }), ['late']);
});
