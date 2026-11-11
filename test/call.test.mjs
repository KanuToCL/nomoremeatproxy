import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { callCodex } from '../src/adapters/codex.mjs';
import { callPeer, stampMessage, threadTitle } from '../src/call.mjs';
import { recoverAttendedReply } from '../src/adapters/claude-attended.mjs';
import { openLedger } from '../src/ledger.mjs';
import { openMailbox } from '../src/mailbox.mjs';

const PEER = Object.freeze({ name: 'sol', vendor: 'codex', model: 'gpt-6-sol' });

// The real ledger on a throwaway directory, so routing and dedupe are tested as they run.
const freshLedger = () => openLedger(mkdtempSync(path.join(os.tmpdir(), 'nomeat-call-')));
const states = (ledger, requestId) => ledger.history(requestId).map((entry) => entry.state);

function recordingAdapter(reply = 'pong') {
  const calls = [];
  const adapter = async (args) => {
    calls.push(args);
    const threadId = args.threadId ?? `thread-${calls.length}`;
    args.onThread(threadId);
    return { threadId, reply };
  };
  return { adapter, calls };
}

const request = (overrides = {}) => ({ peer: PEER, message: 'ping', from: 'fable', project: '/work/app', requestId: 'req-1', ...overrides });

// --- outcome and records ---

test('an answered call returns the reply and records submitting, thread, answered', async () => {
  const ledger = freshLedger();
  const outcome = await callPeer(request(), { ledger, adapters: { codex: recordingAdapter().adapter } });
  assert.deepEqual(outcome, { requestId: 'req-1', peer: 'sol', vendor: 'codex', model: 'gpt-6-sol', state: 'answered', threadId: 'thread-1', continued: false, reply: 'pong' });
  assert.deepEqual(states(ledger, 'req-1'), ['submitting', 'thread', 'answered']);
});

test('a peer without a model leaves the model to the adapter and out of the result and records', async () => {
  const ledger = freshLedger();
  const { adapter, calls } = recordingAdapter();
  const outcome = await callPeer(request({ peer: { name: 'sol', vendor: 'codex', model: undefined } }), { ledger, adapters: { codex: adapter } });
  assert.equal(calls[0].model, undefined);
  assert.equal(Object.hasOwn(outcome, 'model'), false);
  assert.ok(ledger.history('req-1').every((entry) => !Object.hasOwn(entry, 'model')));
});

test('the outgoing message names the caller, request and hop, and keeps the original text', () => {
  const stamped = stampMessage({ message: 'review `a.js`\nplease', from: 'astra', requestId: 'req-9', hop: 2, maxHops: 4 });
  const [header, blank, ...body] = stamped.split('\n');
  // The opening words and the request marker are relied on elsewhere; the rest is kept short.
  assert.equal(header, '[nomeat call from astra; request req-9; hop 2/4; AI, not user]');
  assert.equal(blank, '');
  assert.equal(body.join('\n'), 'review `a.js`\nplease');
});

const UNLISTED = 'The owner may not see this chat: put any question for the owner in your answer, marked for the owner, not in a question card.';

test('a message for a chat the owner may not see carries one more line after the header', () => {
  const stamped = stampMessage({ message: 'hi', from: 'astra', requestId: 'req-9', hop: 1, maxHops: 4, unlisted: true });
  assert.deepEqual(stamped.split('\n'), ['[nomeat call from astra; request req-9; hop 1/4; AI, not user]', UNLISTED, '', 'hi']);
});

test('the line goes into a Codex chat the bridge makes now or made earlier, not into one it did not make', async () => {
  const ledger = freshLedger();
  const sent = [];
  // Like a direct Codex turn: only the call that makes a thread reports its access.
  const codex = async (args) => (sent.push(args.message), { threadId: args.threadId ?? 'thread-new', reply: 'ok', ...(args.threadId ? {} : { access: 'read-only' }) });
  await callPeer(request({ requestId: 'req-1' }), { ledger, adapters: { codex } });
  await callPeer(request({ requestId: 'req-2', threadId: 'thread-new' }), { ledger, adapters: { codex } });
  await callPeer(request({ requestId: 'req-3', threadId: 'thread-of-the-app' }), { ledger, adapters: { codex } });
  assert.deepEqual(sent.map((message) => message.includes(UNLISTED)), [true, true, false]);
});

test('a message to a Claude peer never carries the line', async () => {
  const sent = [];
  const claude = async (args) => (sent.push(args.message), { threadId: 'session-1', reply: 'ok' });
  await callPeer(request({ peer: { name: 'fable', vendor: 'claude' } }), { ledger: freshLedger(), adapters: { claude } });
  assert.equal(sent[0].includes(UNLISTED), false);
});

test('the ledger stores a hash of the message, not its text', async () => {
  const ledger = freshLedger();
  await callPeer(request({ message: 'secret plan' }), { ledger, adapters: { codex: recordingAdapter().adapter } });
  const entries = ledger.history('req-1');
  assert.equal(entries[0].messageSha256, createHash('sha256').update('secret plan').digest('hex'));
  assert.ok(!JSON.stringify(entries).includes('secret plan'));
});

test('the ledger records the sizes of message and reply and the reported token use, not the text', async () => {
  const ledger = freshLedger();
  const usage = { totalTokens: 58093, cachedInputTokens: 0, outputTokens: 4, reasoningTokens: 0 };
  const measured = async (args) => ({ threadId: 'thread-1', reply: 'four', usage, delivery: 'direct' });
  const outcome = await callPeer(request({ message: 'secret plan' }), { ledger, adapters: { codex: measured } });
  const [submitting, answered] = ledger.history('req-1');
  assert.equal(submitting.messageChars, 'secret plan'.length);
  assert.equal(answered.replyChars, 'four'.length);
  assert.deepEqual(answered.usage, usage);
  assert.ok(!JSON.stringify(ledger.history('req-1')).includes('four'));
  // The caller's result stays as small as before.
  assert.equal(Object.hasOwn(outcome, 'usage'), false);
});

test('a missing request id is generated and returned', async () => {
  const outcome = await callPeer(request({ requestId: undefined }), { ledger: freshLedger(), adapters: { codex: recordingAdapter().adapter }, newId: () => 'generated-1' });
  assert.equal(outcome.requestId, 'generated-1');
});

test('an adapter failure is recorded and rethrown', async () => {
  const ledger = freshLedger();
  const failing = async () => {
    throw new Error('vendor down');
  };
  await assert.rejects(callPeer(request(), { ledger, adapters: { codex: failing } }), /vendor down/);
  assert.deepEqual(states(ledger, 'req-1'), ['submitting', 'failed']);
  assert.equal(ledger.history('req-1')[1].error, 'vendor down');
});

// --- duplicates and limits ---

test('a request id that was already answered is not sent again', async () => {
  const ledger = freshLedger();
  const { adapter, calls } = recordingAdapter();
  await callPeer(request(), { ledger, adapters: { codex: adapter } });
  const second = await callPeer(request(), { ledger, adapters: { codex: adapter } });
  assert.equal(second.state, 'duplicate');
  assert.equal(second.threadId, 'thread-1');
  assert.equal(calls.length, 1);
});

test('an attempt with no recorded answer is reported uncertain and not resent', async () => {
  const ledger = freshLedger();
  ledger.append({ requestId: 'req-1', state: 'submitting' });
  ledger.append({ requestId: 'req-1', state: 'thread', threadId: 'thread-7' });
  const { adapter, calls } = recordingAdapter();
  const outcome = await callPeer(request(), { ledger, adapters: { codex: adapter } });
  assert.equal(outcome.state, 'uncertain');
  assert.equal(outcome.threadId, 'thread-7');
  assert.equal(calls.length, 0);
});

test('force resends an uncertain request', async () => {
  const ledger = freshLedger();
  ledger.append({ requestId: 'req-1', state: 'submitting' });
  const { adapter, calls } = recordingAdapter();
  const outcome = await callPeer(request({ force: true }), { ledger, adapters: { codex: adapter } });
  assert.equal(outcome.state, 'answered');
  assert.equal(calls.length, 1);
});

test('a failure known to precede sending can be retried with the same request id', async () => {
  const ledger = freshLedger();
  const refused = async () => {
    throw Object.assign(new Error('thread unavailable'), { notSent: true });
  };
  await assert.rejects(callPeer(request(), { ledger, adapters: { codex: refused } }));
  const { adapter, calls } = recordingAdapter();
  const retry = await callPeer(request(), { ledger, adapters: { codex: adapter } });
  assert.equal(retry.state, 'answered');
  assert.equal(calls.length, 1);
});

test('a failure after sending leaves the request uncertain', async () => {
  const ledger = freshLedger();
  const timedOut = async () => {
    throw new Error('no reply in time');
  };
  await assert.rejects(callPeer(request(), { ledger, adapters: { codex: timedOut } }));
  const { adapter, calls } = recordingAdapter();
  const retry = await callPeer(request(), { ledger, adapters: { codex: adapter } });
  assert.equal(retry.state, 'uncertain');
  assert.equal(calls.length, 0);
});

test('an uncertain request whose answer is already in the thread is recovered, not resent', async () => {
  const ledger = freshLedger();
  ledger.append({ requestId: 'req-1', state: 'submitting' });
  ledger.append({ requestId: 'req-1', state: 'thread', threadId: 'thread-7' });
  const { adapter, calls } = recordingAdapter();
  const asked = [];
  const recover = async (query) => {
    asked.push(query);
    return { reply: 'the earlier answer' };
  };
  const outcome = await callPeer(request(), { ledger, adapters: { codex: adapter }, recoverers: { codex: recover } });
  assert.deepEqual(asked, [{ threadId: 'thread-7', marker: 'request req-1;', requestId: 'req-1' }]);
  assert.equal(outcome.state, 'answered');
  assert.equal(outcome.recovered, true);
  assert.equal(outcome.reply, 'the earlier answer');
  assert.equal(calls.length, 0);
  // The recovered thread is now the one later calls continue.
  const next = await callPeer(request({ requestId: 'req-2' }), { ledger, adapters: { codex: adapter } });
  assert.equal(next.threadId, 'thread-7');
});

// A first attempt into an existing Codex thread sends no model, so a retry must not report one.
async function retryOfExistingThread({ answer, recover, named = [], peer = PEER }) {
  const ledger = freshLedger();
  const first = answer ? recordingAdapter().adapter : async () => { throw new Error('no reply in time'); };
  const call = request({ peer, threadId: 'thread-1', named });
  await (answer ? callPeer(call, { ledger, adapters: { codex: first } }) : assert.rejects(callPeer(call, { ledger, adapters: { codex: first } })));
  return callPeer(call, { ledger, adapters: { codex: recordingAdapter().adapter }, recoverers: recover ? { codex: recover } : {} });
}

test('a duplicate of a call that sent no model reports none', async () => {
  const outcome = await retryOfExistingThread({ answer: true });
  assert.equal(outcome.state, 'duplicate');
  assert.equal(Object.hasOwn(outcome, 'model'), false);
});

test('an uncertain retry of a call that sent no model reports none', async () => {
  const outcome = await retryOfExistingThread({ answer: false });
  assert.equal(outcome.state, 'uncertain');
  assert.equal(Object.hasOwn(outcome, 'model'), false);
});

test('a recovered answer to a call that sent no model reports none', async () => {
  const outcome = await retryOfExistingThread({ answer: false, recover: async () => ({ reply: 'earlier' }) });
  assert.equal(outcome.recovered, true);
  assert.equal(Object.hasOwn(outcome, 'model'), false);
});

test('a retry of a call that sent a model still reports it', async () => {
  const outcome = await retryOfExistingThread({ answer: false, named: ['model'], recover: async () => ({ reply: 'earlier' }) });
  assert.equal(outcome.recovered, true);
  assert.equal(outcome.model, 'gpt-6-sol');
});

test('an uncertain request stays uncertain when the thread holds no finished answer', async () => {
  const ledger = freshLedger();
  ledger.append({ requestId: 'req-1', state: 'submitting' });
  ledger.append({ requestId: 'req-1', state: 'thread', threadId: 'thread-7' });
  const { adapter, calls } = recordingAdapter();
  const outcome = await callPeer(request(), { ledger, adapters: { codex: adapter }, recoverers: { codex: async () => null } });
  assert.equal(outcome.state, 'uncertain');
  assert.equal(calls.length, 0);
});

test('an attempt the adapter refuses ends as refused with its note, and a retry looks for the answer first', async () => {
  const ledger = freshLedger();
  const refusing = async () => {
    throw Object.assign(new Error('already handed over'), { refused: true });
  };
  const outcome = await callPeer(request({ force: true }), { ledger, adapters: { codex: refusing } });
  assert.equal(outcome.state, 'refused');
  assert.equal(outcome.note, 'already handed over');
  assert.equal(outcome.threadId, null);
  const { adapter, calls } = recordingAdapter();
  assert.equal((await callPeer(request(), { ledger, adapters: { codex: adapter } })).state, 'uncertain');
  assert.equal(calls.length, 0);
});

test('a hop beyond the limit is refused without contacting the peer or the ledger', async () => {
  const ledger = freshLedger();
  const { adapter, calls } = recordingAdapter();
  const outcome = await callPeer(request({ hop: 5, maxHops: 4 }), { ledger, adapters: { codex: adapter } });
  assert.equal(outcome.state, 'refused');
  assert.equal(calls.length, 0);
  assert.deepEqual(ledger.history('req-1'), []);
});

// --- sending without waiting ---

const queueing = (calls = []) => async (args) => {
  calls.push(args);
  return { threadId: args.threadId, delivery: 'queued' };
};

// The real Codex adapter with a faked command line: `queueError` is how the queue command fails.
// Its help offers `--resume` but no daemon commands.
function failingQueue(queueError) {
  const queued = [];
  const runCli = async (args) => {
    if (args[0] !== 'queue' || args[1] === '--help') return { stdout: '--resume', stderr: '' };
    queued.push(args);
    throw queueError();
  };
  return { queued, codex: (args) => callCodex({ ...args, runCli }) };
}

test('a queue command that ran and failed, such as a resume past its time limit, is never queued again by a retry', async () => {
  const ledger = freshLedger();
  const cli = failingQueue(() => new Error('codex queue failed: timed out'));
  const send = () => callPeer(request({ threadId: 'thread-open', noWait: true }), { ledger, adapters: { codex: cli.codex } });
  await assert.rejects(send(), /timed out/);
  assert.equal(ledger.history('req-1').at(-1).sent, true);
  const retry = await send();
  assert.equal(retry.state, 'uncertain');
  assert.equal(cli.queued.length, 1);
});

test('a queue command that never started is not sent, so a retry may queue it', async () => {
  const ledger = freshLedger();
  const cli = failingQueue(() => Object.assign(new Error('spawn codex ENOENT'), { notStarted: true }));
  const send = () => callPeer(request({ threadId: 'thread-open', noWait: true }), { ledger, adapters: { codex: cli.codex } });
  await assert.rejects(send(), (error) => error.notSent === true);
  await assert.rejects(send(), (error) => error.notSent === true);
  assert.equal(cli.queued.length, 2);
});

test('a message sent without waiting is recorded as sent, carries no reply, and is not sent twice', async () => {
  const ledger = freshLedger();
  const calls = [];
  const outcome = await callPeer(request({ threadId: 'thread-open', noWait: true }), { ledger, adapters: { codex: queueing(calls) } });
  assert.equal(calls[0].noWait, true);
  assert.equal(outcome.state, 'sent');
  assert.equal(outcome.delivery, 'queued');
  assert.equal(Object.hasOwn(outcome, 'reply'), false);
  assert.match(outcome.note, /will not come back/);
  assert.deepEqual(states(ledger, 'req-1'), ['submitting', 'sent']);
  const again = await callPeer(request({ threadId: 'thread-open', noWait: true }), { ledger, adapters: { codex: queueing(calls) } });
  assert.equal(again.state, 'duplicate');
  assert.equal(calls.length, 1);
});

test('a warning from the delivery reaches the result; without one there is no field', async () => {
  const warned = async (args) => ({ threadId: args.threadId, delivery: 'queued', warning: 'could not resume' });
  const outcome = await callPeer(request({ threadId: 'thread-open', noWait: true }), { ledger: freshLedger(), adapters: { codex: warned } });
  assert.equal(outcome.state, 'sent');
  assert.equal(outcome.warning, 'could not resume');
  const quiet = await callPeer(request({ threadId: 'thread-open', noWait: true }), { ledger: freshLedger(), adapters: { codex: queueing() } });
  assert.equal(Object.hasOwn(quiet, 'warning'), false);
});

test('a message sent without waiting is not a call still waiting for its answer', async () => {
  const ledger = freshLedger();
  await callPeer(request({ threadId: 'thread-open', noWait: true }), { ledger, adapters: { codex: queueing() } });
  assert.equal(ledger.openCall({ project: '/work/app', from: 'fable', peer: 'sol', maxAgeMs: 60_000 }), null);
});

test('a message sent without waiting does not change the thread later calls continue', async () => {
  const ledger = freshLedger();
  const { adapter, calls } = recordingAdapter();
  await callPeer(request({ requestId: 'req-1' }), { ledger, adapters: { codex: adapter } });
  await callPeer(request({ requestId: 'req-2', threadId: 'thread-open', noWait: true }), { ledger, adapters: { codex: queueing() } });
  await callPeer(request({ requestId: 'req-3' }), { ledger, adapters: { codex: adapter } });
  assert.equal(calls[1].threadId, 'thread-1');
});

// --- which thread a call lands in ---

test('a second call from the same caller to the same peer in the same project continues the thread', async () => {
  const ledger = freshLedger();
  const { adapter, calls } = recordingAdapter();
  await callPeer(request({ requestId: 'req-1' }), { ledger, adapters: { codex: adapter } });
  const second = await callPeer(request({ requestId: 'req-2' }), { ledger, adapters: { codex: adapter } });
  assert.equal(calls[1].threadId, 'thread-1');
  assert.equal(second.threadId, 'thread-1');
  assert.equal(second.continued, true);
});

const ROUTE = Object.freeze({ project: '/work/app', from: 'fable', peer: 'sol' });

test('a side thread started as new is not continued by later calls; the standing thread is', async () => {
  const ledger = freshLedger();
  const { adapter, calls } = recordingAdapter();
  await callPeer(request({ requestId: 'req-1' }), { ledger, adapters: { codex: adapter } });
  const side = await callPeer(request({ requestId: 'req-2', newThread: true }), { ledger, adapters: { codex: adapter } });
  const next = await callPeer(request({ requestId: 'req-3' }), { ledger, adapters: { codex: adapter } });
  assert.equal(calls[1].threadId, undefined);
  assert.equal(side.continued, false);
  assert.equal(side.threadId, 'thread-2');
  assert.equal(next.threadId, 'thread-1');
});

test('an explicit thread used for one call does not replace the standing thread', async () => {
  const ledger = freshLedger();
  const { adapter } = recordingAdapter();
  await callPeer(request({ requestId: 'req-1' }), { ledger, adapters: { codex: adapter } });
  await callPeer(request({ requestId: 'req-2', threadId: 'thread-other' }), { ledger, adapters: { codex: adapter } });
  const next = await callPeer(request({ requestId: 'req-3' }), { ledger, adapters: { codex: adapter } });
  assert.equal(next.threadId, 'thread-1');
});

test('naming a thread as standing moves later calls to it, whether it is new or an existing one', async () => {
  const ledger = freshLedger();
  const { adapter } = recordingAdapter();
  await callPeer(request({ requestId: 'req-1' }), { ledger, adapters: { codex: adapter } });
  const renamed = await callPeer(request({ requestId: 'req-2', newThread: true, makeStanding: true }), { ledger, adapters: { codex: adapter } });
  const afterNew = await callPeer(request({ requestId: 'req-3' }), { ledger, adapters: { codex: adapter } });
  assert.equal(afterNew.threadId, renamed.threadId);
  await callPeer(request({ requestId: 'req-4', threadId: 'thread-chosen', makeStanding: true }), { ledger, adapters: { codex: adapter } });
  const afterChosen = await callPeer(request({ requestId: 'req-5' }), { ledger, adapters: { codex: adapter } });
  assert.equal(afterChosen.threadId, 'thread-chosen');
});

test('a message sent without waiting can name its thread as standing', async () => {
  const ledger = freshLedger();
  await callPeer(request({ requestId: 'req-1' }), { ledger, adapters: { codex: recordingAdapter().adapter } });
  await callPeer(request({ requestId: 'req-2', threadId: 'thread-open', noWait: true, makeStanding: true }), { ledger, adapters: { codex: queueing() } });
  assert.equal(ledger.standingThread(ROUTE), 'thread-open');
});

test('a route from before standing threads existed continues its last answered thread, which then becomes standing', async () => {
  const ledger = freshLedger();
  ledger.append({ requestId: 'old-1', ...ROUTE, state: 'answered', threadId: 'thread-old' });
  assert.equal(ledger.standingThread(ROUTE), null);
  const { adapter } = recordingAdapter();
  const first = await callPeer(request({ requestId: 'req-1' }), { ledger, adapters: { codex: adapter } });
  assert.equal(first.threadId, 'thread-old');
  assert.equal(ledger.standingThread(ROUTE), 'thread-old');
});

test('a side thread on a route from before standing threads existed does not take over', async () => {
  const ledger = freshLedger();
  ledger.append({ requestId: 'old-1', ...ROUTE, state: 'answered', threadId: 'thread-old' });
  const { adapter } = recordingAdapter();
  const side = await callPeer(request({ requestId: 'req-1', newThread: true }), { ledger, adapters: { codex: adapter } });
  assert.notEqual(side.threadId, 'thread-old');
  assert.equal(ledger.standingThread(ROUTE), null);
  const next = await callPeer(request({ requestId: 'req-2' }), { ledger, adapters: { codex: adapter } });
  assert.equal(next.threadId, 'thread-old');
  assert.equal(ledger.standingThread(ROUTE), 'thread-old');
});

test('a route whose only call was a side thread starts its standing thread at the next ordinary call', async () => {
  const ledger = freshLedger();
  const { adapter, calls } = recordingAdapter();
  const side = await callPeer(request({ requestId: 'req-1', newThread: true }), { ledger, adapters: { codex: adapter } });
  const next = await callPeer(request({ requestId: 'req-2' }), { ledger, adapters: { codex: adapter } });
  assert.equal(calls[1].threadId, undefined);
  assert.notEqual(next.threadId, side.threadId);
  assert.equal(ledger.standingThread(ROUTE), next.threadId);
});

test('a first call into an exact thread does not make that thread the standing one', async () => {
  const ledger = freshLedger();
  const { adapter, calls } = recordingAdapter();
  await callPeer(request({ requestId: 'req-1', threadId: 'thread-manual' }), { ledger, adapters: { codex: adapter } });
  assert.equal(ledger.standingThread(ROUTE), null);
  const next = await callPeer(request({ requestId: 'req-2' }), { ledger, adapters: { codex: adapter } });
  assert.equal(calls[1].threadId, undefined);
  assert.notEqual(next.threadId, 'thread-manual');
  assert.equal(ledger.standingThread(ROUTE), next.threadId);
});

test('a chat that answered while attended is never named as the standing thread', async () => {
  const ledger = freshLedger();
  const attended = async () => ({ threadId: 'live-chat', reply: 'from the chat itself', delivery: 'attended', continued: true });
  await callPeer(request({ requestId: 'req-1', makeStanding: true }), { ledger, adapters: { codex: attended } });
  assert.equal(ledger.standingThread(ROUTE), null);
});

test('naming the standing thread is not a step of the request that caused it', async () => {
  const ledger = freshLedger();
  await callPeer(request({ requestId: 'req-1' }), { ledger, adapters: { codex: recordingAdapter().adapter } });
  assert.equal(ledger.standingThread(ROUTE), 'thread-1');
  assert.deepEqual(states(ledger, 'req-1'), ['submitting', 'thread', 'answered']);
});

test('another caller, peer or project gets its own thread', async () => {
  const ledger = freshLedger();
  const { adapter, calls } = recordingAdapter();
  await callPeer(request({ requestId: 'req-1' }), { ledger, adapters: { codex: adapter } });
  await callPeer(request({ requestId: 'req-2', from: 'opus' }), { ledger, adapters: { codex: adapter } });
  await callPeer(request({ requestId: 'req-3', project: '/work/other' }), { ledger, adapters: { codex: adapter } });
  await callPeer(request({ requestId: 'req-4', peer: { ...PEER, name: 'astra' } }), { ledger, adapters: { codex: adapter } });
  assert.deepEqual(calls.slice(1).map((call) => call.threadId), [undefined, undefined, undefined]);
});

test('an explicit thread wins over the remembered one', async () => {
  const ledger = freshLedger();
  const { adapter, calls } = recordingAdapter();
  await callPeer(request({ requestId: 'req-1' }), { ledger, adapters: { codex: adapter } });
  await callPeer(request({ requestId: 'req-2', threadId: 'thread-chosen' }), { ledger, adapters: { codex: adapter } });
  assert.equal(calls[1].threadId, 'thread-chosen');
});

test('a failed call is not remembered as the thread to continue', async () => {
  const ledger = freshLedger();
  const failing = async (args) => {
    args.onThread('thread-broken');
    throw new Error('vendor down');
  };
  await assert.rejects(callPeer(request({ requestId: 'req-1' }), { ledger, adapters: { codex: failing } }));
  const { adapter, calls } = recordingAdapter();
  await callPeer(request({ requestId: 'req-2' }), { ledger, adapters: { codex: adapter } });
  assert.equal(calls[0].threadId, undefined);
});

// --- what the adapter is given ---

test('the adapter receives the model, effort, access level, project and a title', async () => {
  const { adapter, calls } = recordingAdapter();
  await callPeer(request({ effort: 'ultra', write: true, message: 'Review the plan' }), { ledger: freshLedger(), adapters: { codex: adapter } });
  const [call] = calls;
  assert.equal(call.model, 'gpt-6-sol');
  assert.equal(call.effort, 'ultra');
  assert.equal(call.write, true);
  assert.equal(call.cwd, '/work/app');
  assert.equal(call.title, 'fable to sol [app]: Review the plan');
  // The marker must appear in the message so the turn can be found in the thread later.
  assert.ok(call.message.includes(call.marker));
  assert.equal(call.marker, 'request req-1;');
});

// A direct-turn stand-in that reports the level it was given, as the Codex adapter does.
function settingsAdapter() {
  const calls = [];
  const adapter = async (args) => {
    calls.push(args);
    return { threadId: args.threadId ?? 'thread-new', reply: 'ok', delivery: 'direct', ...(args.effort ? { effort: args.effort } : {}) };
  };
  return { adapter, calls };
}

test('an existing Codex thread with nothing named keeps its own model and level', async () => {
  const { adapter, calls } = settingsAdapter();
  const outcome = await callPeer(request({ threadId: 'thread-1', effort: 'ultra', named: [] }), { ledger: freshLedger(), adapters: { codex: adapter } });
  assert.equal(calls[0].model, undefined);
  assert.equal(calls[0].effort, undefined);
  assert.equal(Object.hasOwn(outcome, 'model'), false);
  assert.equal(Object.hasOwn(outcome, 'effort'), false);
});

test('an existing Codex thread gets the level the caller named, but not the peer model', async () => {
  const { adapter, calls } = settingsAdapter();
  const outcome = await callPeer(request({ threadId: 'thread-1', effort: 'low', named: ['effort'] }), { ledger: freshLedger(), adapters: { codex: adapter } });
  assert.deepEqual({ model: calls[0].model, effort: calls[0].effort }, { model: undefined, effort: 'low' });
  assert.equal(Object.hasOwn(outcome, 'model'), false);
  assert.equal(outcome.effort, 'low');
});

test('an existing Codex thread gets the model the caller named, but not the peer level', async () => {
  const { adapter, calls } = settingsAdapter();
  const named = { ...PEER, model: 'gpt-6-other' };
  const outcome = await callPeer(request({ peer: named, threadId: 'thread-1', effort: 'ultra', named: ['model'] }), { ledger: freshLedger(), adapters: { codex: adapter } });
  assert.deepEqual({ model: calls[0].model, effort: calls[0].effort }, { model: 'gpt-6-other', effort: undefined });
  assert.equal(outcome.model, 'gpt-6-other');
  assert.equal(Object.hasOwn(outcome, 'effort'), false);
});

test('a standing Codex thread continued without names keeps its own settings', async () => {
  const ledger = freshLedger();
  const { adapter, calls } = settingsAdapter();
  await callPeer(request({ effort: 'ultra', named: [] }), { ledger, adapters: { codex: adapter } });
  await callPeer(request({ requestId: 'req-2', effort: 'ultra', named: [] }), { ledger, adapters: { codex: adapter } });
  assert.deepEqual(calls.map((call) => [call.threadId, call.model, call.effort]), [[undefined, 'gpt-6-sol', 'ultra'], ['thread-new', undefined, undefined]]);
});

test('a new Codex thread still gets the peer model and level', async () => {
  const { adapter, calls } = settingsAdapter();
  const outcome = await callPeer(request({ newThread: true, effort: 'ultra', named: [] }), { ledger: freshLedger(), adapters: { codex: adapter } });
  assert.deepEqual({ model: calls[0].model, effort: calls[0].effort }, { model: 'gpt-6-sol', effort: 'ultra' });
  assert.equal(outcome.model, 'gpt-6-sol');
});

test('a continued Claude session is still given the peer model and level', async () => {
  const { adapter, calls } = settingsAdapter();
  const claude = { name: 'opus', vendor: 'claude', model: 'claude-opus-test' };
  const outcome = await callPeer(request({ peer: claude, threadId: 'session-1', effort: 'high', named: [] }), { ledger: freshLedger(), adapters: { claude: adapter } });
  assert.deepEqual({ model: calls[0].model, effort: calls[0].effort }, { model: 'claude-opus-test', effort: 'high' });
  assert.equal(outcome.model, 'claude-opus-test');
});

test('the way the message was delivered is reported when the adapter states it', async () => {
  const queued = async (args) => ({ threadId: args.threadId, reply: 'ok', delivery: 'queued' });
  const outcome = await callPeer(request({ threadId: 'thread-open' }), { ledger: freshLedger(), adapters: { codex: queued } });
  assert.equal(outcome.delivery, 'queued');
});

test('the adapter learns who calls whom, the request, and whether the destination was named', async () => {
  const { adapter, calls } = recordingAdapter();
  const ledger = freshLedger();
  await callPeer(request({ requestId: 'req-1', hop: 2 }), { ledger, adapters: { codex: adapter } });
  await callPeer(request({ requestId: 'req-2', threadId: 'thread-chosen' }), { ledger, adapters: { codex: adapter } });
  await callPeer(request({ requestId: 'req-3', newThread: true }), { ledger, adapters: { codex: adapter } });
  const { requestId, from, peer, hop, maxHops, pinned } = calls[0];
  assert.deepEqual({ requestId, from, peer, hop, maxHops, pinned }, { requestId: 'req-1', from: 'fable', peer: 'sol', hop: 2, maxHops: 4, pinned: false });
  assert.deepEqual(calls.slice(1).map((call) => call.pinned), [true, true]);
});

test('a chat that took the call while attended counts as continued and is not resumed later', async () => {
  const ledger = freshLedger();
  const { adapter, calls } = recordingAdapter();
  await callPeer(request({ requestId: 'req-1' }), { ledger, adapters: { codex: adapter } });
  const attended = async () => ({ threadId: 'live-chat', reply: 'from the chat itself', delivery: 'attended', continued: true });
  const outcome = await callPeer(request({ requestId: 'req-2' }), { ledger, adapters: { codex: attended } });
  assert.equal(outcome.threadId, 'live-chat');
  assert.equal(outcome.continued, true);
  assert.equal(outcome.delivery, 'attended');
  // The next unattended call goes back to the thread the bridge may safely resume.
  await callPeer(request({ requestId: 'req-3' }), { ledger, adapters: { codex: adapter } });
  assert.equal(calls[1].threadId, 'thread-1');
});

test('a retry asks the recoverer even when no thread was recorded for the first attempt', async () => {
  const ledger = freshLedger();
  ledger.append({ requestId: 'req-1', state: 'submitting' });
  const outcome = await callPeer(request(), {
    ledger,
    adapters: { codex: recordingAdapter().adapter },
    recoverers: { codex: async ({ requestId }) => ({ reply: `late answer to ${requestId}` }) },
  });
  assert.equal(outcome.state, 'answered');
  assert.equal(outcome.recovered, true);
  assert.equal(outcome.reply, 'late answer to req-1');
});

test('a thread title is one line and cut to a readable length', () => {
  const title = threadTitle({ from: 'astra', peer: 'fable', project: '/work/app', message: `line one\n\tline two ${'x'.repeat(80)}` });
  assert.ok(!/[\n\t]/.test(title));
  // "astra to fable [app]: " plus 60 characters of text plus "..."
  assert.equal(title.length, 'astra to fable [app]: '.length + 60 + 3);
  assert.ok(title.startsWith('astra to fable [app]: line one line two xxx'));
});

test('a thread title names the project folder, from a Windows or a POSIX path', () => {
  const title = (project) => threadTitle({ from: 'astra', peer: 'fable', project, message: 'hi' });
  assert.equal(title('C:\\work\\shop'), 'astra to fable [shop]: hi');
  assert.equal(title('/home/someone/shop'), 'astra to fable [shop]: hi');
  assert.equal(title('/home/someone/shop/'), 'astra to fable [shop]: hi');
});

// --- what the call could do: access and thinking level ---

test('the access and thinking level an adapter applied are recorded and reported', async () => {
  const ledger = freshLedger();
  const direct = async () => ({ threadId: 'thread-new', reply: 'ok', delivery: 'direct', access: 'read-only', effort: 'ultra' });
  const outcome = await callPeer(request({ effort: 'ultra' }), { ledger, adapters: { codex: direct } });
  assert.equal(outcome.access, 'read-only');
  assert.equal(outcome.effort, 'ultra');
  const answered = ledger.history('req-1').find((entry) => entry.state === 'answered');
  assert.deepEqual({ access: answered.access, effort: answered.effort }, { access: 'read-only', effort: 'ultra' });
});

test('a later queued call reports the access the thread was created with, and no thinking level', async () => {
  const ledger = freshLedger();
  const created = async () => ({ threadId: 'thread-1', reply: 'ok', delivery: 'direct', access: 'write' });
  await callPeer(request({ requestId: 'req-1', write: true }), { ledger, adapters: { codex: created } });
  const calls = [];
  const outcome = await callPeer(request({ requestId: 'req-2', threadId: 'thread-1', noWait: true, effort: 'ultra' }), { ledger, adapters: { codex: queueing(calls) } });
  // The adapter is told what the ledger knows, so it can refuse a write the thread lacks.
  assert.equal(calls[0].threadAccess, 'write');
  assert.equal(outcome.access, 'write');
  assert.equal(Object.hasOwn(outcome, 'effort'), false);
  assert.equal(ledger.threadAccess('thread-1'), 'write');
});

test('a call with write into a thread the bridge did not make reports write and records no thread access', async () => {
  const ledger = freshLedger();
  const resumed = async () => ({ threadId: 'thread-app', reply: 'ok', delivery: 'direct', access: 'write' });
  const outcome = await callPeer(request({ threadId: 'thread-app', write: true }), { ledger, adapters: { codex: resumed } });
  assert.equal(outcome.access, 'write');
  // The resume may not have stuck in the app, so a later queued write is still refused.
  assert.equal(ledger.threadAccess('thread-app'), null);
});

// --- settings the delivery could not apply ---

test('a queued call reports the model and level the caller named as not applied', async () => {
  const queued = async (args) => ({ threadId: args.threadId, reply: 'ok', delivery: 'queued' });
  const outcome = await callPeer(request({ threadId: 'thread-open', effort: 'low', named: ['effort'] }), { ledger: freshLedger(), adapters: { codex: queued } });
  assert.deepEqual(outcome.notApplied, ['effort']);
});

test('a message sent without waiting into the queue reports a named model as not applied', async () => {
  const outcome = await callPeer(request({ threadId: 'thread-open', noWait: true, named: ['model'] }), { ledger: freshLedger(), adapters: { codex: queueing() } });
  assert.equal(outcome.state, 'sent');
  assert.deepEqual(outcome.notApplied, ['model']);
});

test('an attended answer reports both named settings as not applied', async () => {
  const attended = async () => ({ threadId: 'live-chat', reply: 'ok', delivery: 'attended', continued: true });
  const outcome = await callPeer(request({ effort: 'max', named: ['model', 'effort'] }), { ledger: freshLedger(), adapters: { codex: attended } });
  assert.deepEqual(outcome.notApplied, ['model', 'effort']);
});

test('a late attended answer found by a retry still reports the named settings as not applied', async () => {
  const ledger = freshLedger();
  const mailbox = openMailbox(mkdtempSync(path.join(os.tmpdir(), 'nomeat-call-')));
  // The first attempt: the chat took the message but did not answer in time.
  ledger.append({ requestId: 'req-1', state: 'submitting' });
  ledger.append({ requestId: 'req-1', state: 'failed', sent: true });
  mailbox.post({ project: '/work/app', peer: 'fable', requestId: 'req-1', from: 'astra', hop: 1, maxHops: 4, message: 'ping' });
  mailbox.collect({ project: '/work/app', peer: 'fable' });
  const retry = () => callPeer(request({ named: ['model'] }), { ledger, adapters: {}, recoverers: { codex: recoverAttendedReply(mailbox) } });
  // Nothing found yet, so nothing is reported as dropped either.
  assert.equal(Object.hasOwn(await retry(), 'notApplied'), false);
  mailbox.answer('req-1', 'late answer');
  const outcome = await retry();
  assert.equal(outcome.recovered, true);
  assert.deepEqual(outcome.notApplied, ['model']);
});

test('a direct call applies what was named and reports nothing dropped', async () => {
  const direct = async () => ({ threadId: 'thread-new', reply: 'ok', delivery: 'direct', effort: 'low' });
  const outcome = await callPeer(request({ effort: 'low', named: ['model', 'effort'] }), { ledger: freshLedger(), adapters: { codex: direct } });
  assert.equal(Object.hasOwn(outcome, 'notApplied'), false);
});

test('a queued call that only carried the peer defaults reports nothing dropped', async () => {
  const queued = async (args) => ({ threadId: args.threadId, reply: 'ok', delivery: 'queued' });
  const outcome = await callPeer(request({ threadId: 'thread-open', effort: 'ultra', named: [] }), { ledger: freshLedger(), adapters: { codex: queued } });
  assert.equal(Object.hasOwn(outcome, 'notApplied'), false);
});

test('a thread with no recorded access reports none and tells the adapter it is unknown', async () => {
  const calls = [];
  const outcome = await callPeer(request({ threadId: 'thread-app', noWait: true }), { ledger: freshLedger(), adapters: { codex: queueing(calls) } });
  assert.equal(calls[0].threadAccess, null);
  assert.equal(Object.hasOwn(outcome, 'access'), false);
});
