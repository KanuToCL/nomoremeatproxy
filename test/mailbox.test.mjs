import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { LISTENER_MAX_AGE_MS, mailboxKey, openMailbox } from '../src/mailbox.mjs';

const tempDir = () => mkdtempSync(path.join(os.tmpdir(), 'nomeat-mailbox-'));
const BOX = Object.freeze({ project: '/work/app', peer: 'fable' });
const request = (overrides = {}) => ({ ...BOX, requestId: 'req-1', from: 'astra', hop: 1, maxHops: 4, message: 'ping', ...overrides });

function clock(start = 1_000_000) {
  let time = start;
  return { now: () => time, advance: (ms) => (time += ms) };
}

// --- who is listening ---

test('nobody is listening until a chat beats, and a stale beat stops counting', () => {
  const time = clock();
  const mailbox = openMailbox(tempDir(), { now: time.now });
  assert.equal(mailbox.listener(BOX), null);
  mailbox.claimListener(BOX, 'session-1');
  assert.deepEqual(mailbox.listener(BOX), { session: 'session-1' });
  time.advance(LISTENER_MAX_AGE_MS + 1);
  assert.equal(mailbox.listener(BOX), null);
});

test('a chat that stops listening is gone at once', () => {
  const mailbox = openMailbox(tempDir());
  mailbox.claimListener(BOX, 'session-1').release();
  assert.equal(mailbox.listener(BOX), null);
});

test('a listener counts only for its own project and peer name', () => {
  const mailbox = openMailbox(tempDir());
  mailbox.claimListener(BOX, 'session-1');
  assert.equal(mailbox.listener({ ...BOX, peer: 'opus' }), null);
  assert.equal(mailbox.listener({ ...BOX, project: '/work/other' }), null);
});

test('on Windows the key ignores the case of the project path, elsewhere it does not', () => {
  const upper = { project: 'D:\\Work\\App', peer: 'fable' };
  const lower = { project: 'd:\\work\\app', peer: 'fable' };
  assert.equal(mailboxKey(upper, 'win32'), mailboxKey(lower, 'win32'));
  assert.notEqual(mailboxKey(upper, 'linux'), mailboxKey(lower, 'linux'));
});

// --- a request on its way in ---

test('a posted request is handed to its listener once, with its text and sender', () => {
  const mailbox = openMailbox(tempDir());
  mailbox.post(request());
  const [taken, ...rest] = mailbox.collect(BOX);
  assert.deepEqual(rest, []);
  assert.equal(taken.requestId, 'req-1');
  assert.equal(taken.from, 'astra');
  assert.equal(taken.message, 'ping');
  // The whole text stays readable on disk until the request is answered.
  assert.equal(JSON.parse(readFileSync(taken.file, 'utf8')).message, 'ping');
  assert.deepEqual(mailbox.collect(BOX), []);
});

test('a request for another project or peer is left for its own listener', () => {
  const mailbox = openMailbox(tempDir());
  mailbox.post(request({ peer: 'opus' }));
  assert.deepEqual(mailbox.collect(BOX), []);
  assert.equal(mailbox.collect({ ...BOX, peer: 'opus' }).length, 1);
});

test('waiting requests are handed over oldest first', () => {
  const time = clock();
  const mailbox = openMailbox(tempDir(), { now: time.now });
  mailbox.post(request({ requestId: 'b-second' }));
  time.advance(-5000);
  mailbox.post(request({ requestId: 'a-first-by-time' }));
  assert.deepEqual(mailbox.collect(BOX).map((taken) => taken.requestId), ['a-first-by-time', 'b-second']);
});

test('a retry under an id the listener already took is not handed over again, and gets the first answer', () => {
  const mailbox = openMailbox(tempDir());
  mailbox.post(request());
  assert.equal(mailbox.collect(BOX).length, 1);
  // Retried while the chat still holds the first copy: nothing new to print.
  mailbox.post(request());
  assert.deepEqual(mailbox.collect(BOX), []);
  // It counts as taken, so the caller keeps waiting instead of running it elsewhere.
  assert.equal(mailbox.withdraw('req-1'), false);
  mailbox.answer('req-1', 'pong');
  // Retried again while the answer waits to be collected.
  mailbox.post(request());
  assert.deepEqual(mailbox.collect(BOX), []);
  assert.equal(mailbox.takeReply('req-1'), 'pong');
});

test('a request not yet taken can be withdrawn, a taken one cannot', () => {
  const mailbox = openMailbox(tempDir());
  mailbox.post(request({ requestId: 'req-1' }));
  assert.equal(mailbox.withdraw('req-1'), true);
  assert.deepEqual(mailbox.collect(BOX), []);
  mailbox.post(request({ requestId: 'req-2' }));
  mailbox.collect(BOX);
  assert.equal(mailbox.withdraw('req-2'), false);
});

// --- the answer on its way back ---

test('an answer reaches the caller once and closes the request', () => {
  const mailbox = openMailbox(tempDir());
  mailbox.post(request());
  mailbox.collect(BOX);
  assert.equal(mailbox.takeReply('req-1'), null);
  mailbox.answer('req-1', 'pong');
  assert.equal(mailbox.takeReply('req-1'), 'pong');
  assert.equal(mailbox.takeReply('req-1'), null);
  assert.throws(() => mailbox.answer('req-1', 'again'), /no open request "req-1"/);
});

test('answering a request that was never posted is refused', () => {
  assert.throws(() => openMailbox(tempDir()).answer('req-unknown', 'pong'), /no open request/);
});

test('a request id that is not a safe file name still makes the round trip', () => {
  const mailbox = openMailbox(tempDir());
  const requestId = '../odd id: with/slashes';
  mailbox.post(request({ requestId }));
  assert.equal(mailbox.collect(BOX)[0].requestId, requestId);
  mailbox.answer(requestId, 'pong');
  assert.equal(mailbox.takeReply(requestId), 'pong');
});

// --- leftovers ---

test('purge removes what nobody came back for after a day and keeps recent files', () => {
  const dir = tempDir();
  openMailbox(dir).post(request({ requestId: 'req-old' }));
  openMailbox(dir).purge();
  assert.equal(openMailbox(dir).collect(BOX).length, 1);
  openMailbox(dir).answer('req-old', 'late');
  const twoDaysOn = () => Date.now() + 2 * 24 * 60 * 60 * 1000;
  openMailbox(dir, { now: twoDaysOn }).purge();
  assert.equal(openMailbox(dir).takeReply('req-old'), null);
});
