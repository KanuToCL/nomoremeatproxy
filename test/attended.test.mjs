import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { deliverToAttended, recoverAttendedReply, routeClaude } from '../src/adapters/claude-attended.mjs';
import { requestLine, runListener } from '../src/listen.mjs';
import { LISTENER_MAX_AGE_MS, openMailbox } from '../src/mailbox.mjs';

const BOX = Object.freeze({ project: '/work/app', peer: 'fable' });
const args = (overrides = {}) => ({ cwd: '/work/app', peer: 'fable', from: 'astra', requestId: 'req-1', hop: 1, maxHops: 4, message: 'ping', pinned: false, ...overrides });

// The real mailbox on a throwaway folder, with a clock the test moves by hand.
function setup() {
  let time = 1_000_000;
  const now = () => time;
  const mailbox = openMailbox(mkdtempSync(path.join(os.tmpdir(), 'nomeat-attended-')), { now });
  const headlessCalls = [];
  const headless = async (received) => {
    headlessCalls.push(received);
    return { threadId: 'headless-thread', reply: 'headless answer' };
  };
  // Each pause of the waiting caller advances the clock and lets the "chat" act.
  const route = ({ onPause = () => {}, isWaitingOn = () => false, timeoutMs } = {}) =>
    routeClaude({
      mailbox,
      headless,
      isWaitingOn,
      deliver: (options) =>
        deliverToAttended({
          ...options,
          timeoutMs: timeoutMs ?? options.timeoutMs,
          now,
          pollMs: 1000,
          sleep: async (ms) => {
            time += ms;
            onPause();
          },
        }),
    });
  return { mailbox, headlessCalls, route, advance: (ms) => (time += ms) };
}

// --- where a call goes ---

test('with no chat listening the call runs headless', async () => {
  const { route, headlessCalls } = setup();
  const result = await route()(args());
  assert.equal(result.reply, 'headless answer');
  assert.equal(headlessCalls.length, 1);
});

test('a listening chat takes the call and its answer comes back as attended', async () => {
  const { mailbox, route, headlessCalls } = setup();
  const lease = mailbox.claimListener(BOX, 'session-1');
  const answerOnce = () => {
    for (const taken of lease.poll(true)) mailbox.answer(taken.requestId, `seen: ${taken.message}`);
  };
  const result = await route({ onPause: answerOnce })(args());
  assert.deepEqual(result, { threadId: 'session-1', reply: 'seen: ping', delivery: 'attended', continued: true });
  assert.equal(headlessCalls.length, 0);
});

test('a call that names its destination is never rerouted to the listening chat', async () => {
  const { mailbox, route, headlessCalls } = setup();
  mailbox.claimListener(BOX, 'session-1');
  await route()(args({ pinned: true, threadId: 'thread-chosen' }));
  assert.equal(headlessCalls[0].threadId, 'thread-chosen');
  assert.deepEqual(mailbox.collect(BOX), []);
});

test('a listening chat that is waiting on this caller is bypassed, since it could not answer', async () => {
  const { mailbox, route, headlessCalls } = setup();
  mailbox.claimListener(BOX, 'session-1');
  const asked = [];
  const isWaitingOn = (query) => {
    asked.push(query);
    return true;
  };
  await route({ isWaitingOn })(args());
  // The question is whether the peer has an open call to the caller, in this project.
  assert.deepEqual(asked, [{ project: '/work/app', from: 'fable', peer: 'astra' }]);
  assert.equal(headlessCalls.length, 1);
});

test('sending without waiting to a Claude peer is refused before anything is sent', async () => {
  const { mailbox, route, headlessCalls } = setup();
  mailbox.claimListener(BOX, 'session-1');
  await assert.rejects(route()(args({ noWait: true })), (error) => {
    assert.match(error.message, /only available for Codex peers/);
    assert.equal(error.notSent, true);
    return true;
  });
  assert.equal(headlessCalls.length, 0);
  assert.deepEqual(mailbox.collect(BOX), []);
});

// --- when the chat does not answer ---

test('a chat that stops listening before taking the message is replaced by a headless run', async () => {
  const { mailbox, route, headlessCalls } = setup();
  mailbox.claimListener(BOX, 'session-1');
  const result = await route({ onPause: () => {} })(args({ timeoutMs: LISTENER_MAX_AGE_MS * 10 }));
  assert.equal(result.reply, 'headless answer');
  assert.equal(headlessCalls.length, 1);
  // The request was taken back, so the chat cannot answer it later as well.
  assert.deepEqual(mailbox.collect(BOX), []);
});

test('a message the chat took but did not answer in time fails without a second copy being run', async () => {
  const { mailbox, route, headlessCalls } = setup();
  const lease = mailbox.claimListener(BOX, 'session-1');
  const takeOnly = () => {
    lease.poll(true);
  };
  await assert.rejects(route({ onPause: takeOnly, timeoutMs: 5000 })(args()), (error) => {
    assert.match(error.message, /took the message but did not answer within 5 s/);
    assert.notEqual(error.notSent, true);
    return true;
  });
  assert.equal(headlessCalls.length, 0);
});

test('an answer that arrives after the caller gave up is found by a retry, once', async () => {
  const { mailbox } = setup();
  mailbox.post({ ...BOX, requestId: 'req-1', from: 'astra', hop: 1, maxHops: 4, message: 'ping' });
  mailbox.collect(BOX);
  const recover = recoverAttendedReply(mailbox);
  assert.equal(await recover({ requestId: 'req-1' }), null);
  mailbox.answer('req-1', 'late answer');
  assert.deepEqual(await recover({ requestId: 'req-1' }), { reply: 'late answer', delivery: 'attended' });
  assert.equal(await recover({ requestId: 'req-1' }), null);
});

// --- a retry of a request the chat already took ---

test('a retry that finds the answer waiting takes it and leaves nothing for the listener to print', async () => {
  const { mailbox, route } = setup();
  const lease = mailbox.claimListener(BOX, 'session-1');
  mailbox.post({ ...BOX, requestId: 'req-1', from: 'astra', hop: 1, maxHops: 4, message: 'ping' });
  lease.poll(true);
  mailbox.answer('req-1', 'pong');
  // The retry posts, then takes the waiting answer at once.
  assert.equal((await route()(args())).reply, 'pong');
  assert.deepEqual(lease.poll(true), []);
});

test('a resend of a request the chat took but has not answered is refused at once, listening or not', async () => {
  const { mailbox, route, headlessCalls } = setup();
  const lease = mailbox.claimListener(BOX, 'session-1');
  mailbox.post({ ...BOX, requestId: 'req-1', from: 'astra', hop: 1, maxHops: 4, message: 'ping' });
  lease.poll(true);
  const refusedAtOnce = (error) => {
    assert.equal(error.refused, true);
    assert.match(error.message, /already handed to a listening chat and its answer has not come; send a new request/);
    return true;
  };
  await assert.rejects(route({ onPause: () => assert.fail('the caller waited') })(args()), refusedAtOnce);
  assert.deepEqual(lease.poll(true), []);
  // A chat that stopped listening may still be working on it: no headless copy either.
  lease.release();
  await assert.rejects(route()(args()), refusedAtOnce);
  assert.equal(headlessCalls.length, 0);
});

// --- the listening loop ---

test('the listener announces itself, emits each request once and leaves when stopped', async () => {
  const { mailbox } = setup();
  mailbox.post({ ...BOX, requestId: 'req-1', from: 'astra', hop: 1, maxHops: 4, message: 'ping' });
  const emitted = [];
  let rounds = 0;
  await runListener({
    mailbox,
    box: BOX,
    session: 'session-1',
    emit: (taken) => emitted.push(taken.requestId),
    stopped: () => rounds >= 3,
    sleep: async () => {
      rounds += 1;
      // Seen from a caller while the loop is running.
      if (rounds === 1) assert.deepEqual(mailbox.listener(BOX), { session: 'session-1' });
    },
  });
  assert.deepEqual(emitted, ['req-1']);
  assert.equal(mailbox.listener(BOX), null);
});

// --- the line a request prints ---

const taken = (overrides = {}) => ({ key: 'k', at: 1, requestId: 'req-7', from: 'astra', hop: 2, maxHops: 4, file: '/inbox/delivered/req-7.json', message: 'ping', ...overrides });

test('a request line tells the chat to quote the message with its sender first, and how to reply', () => {
  const line = requestLine(taken());
  // Only these fields, in this order: the instruction before the message.
  assert.deepEqual(Object.keys(line), ['requestId', 'from', 'hop', 'maxHops', 'file', 'instruction', 'message']);
  assert.match(line.instruction, /^Before anything else you write in the chat, quote the whole message and name astra as its sender\./);
  assert.match(line.instruction, /read all of it from file first/);
  assert.match(line.instruction, /send that same answer with: nomeat reply --request-id req-7$/);
});

test('a long message is still the end of the printed line, after the instruction', () => {
  const message = 'x'.repeat(5000);
  const printed = JSON.stringify(requestLine(taken({ message })));
  assert.ok(printed.endsWith(`"message":"${message}"}`));
  assert.ok(printed.indexOf('"instruction":') < printed.indexOf('"message":'));
});
