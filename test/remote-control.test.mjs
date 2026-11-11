import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { mailboxKey, openMailbox } from '../src/mailbox.mjs';
import { runListener } from '../src/listen.mjs';
import { notifyRemoteWork, provisionNewChat, remoteCommand } from '../src/remote-control.mjs';
import { MAX_NOTICES, REMINDER_MS, remoteStore } from '../src/remote-control-store.mjs';

const coordinator = '11111111-1111-4111-8111-111111111111';
const target = '22222222-2222-4222-8222-222222222222';
const other = '33333333-3333-4333-8333-333333333333';
const box = { project: path.resolve('coordinator-project'), peer: 'fable' };
const key = mailboxKey(box);
const identity = { as: 'fable', thread: coordinator, cwd: box.project };

function setup(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nomeat-rc-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let time = 1000;
  return { dir, store: remoteStore(dir, { now: () => time }), mailbox: openMailbox(dir), advance: ms => (time += ms) };
}

function provision(store, overrides = {}, call = {}) {
  const outcome = { state: 'answered', continued: false, delivery: 'headless', threadId: target, app: { opened: true }, ...overrides };
  provisionNewChat({ outcome, vendor: 'claude', store, createdForRequest: () => true, ...call });
  return outcome;
}

test('opt-in checks the live Desktop identity; unconfigured installs make no state file', (t) => {
  const { dir, store, mailbox } = setup(t);
  assert.equal(provision(store).app.remoteControl.state, 'not-configured');
  assert.deepEqual(readdirSync(dir), []);
  assert.throws(() => remoteCommand('enable', identity, { store, mailbox }), /listener/);
  mailbox.claimListener(box, other);
  assert.throws(() => remoteCommand('enable', identity, { store, mailbox }), /must match/);
  assert.throws(() => remoteCommand('enable', { ...identity, as: 'astra' }, { store, mailbox }), /Desktop peer/);
});

test('only newly opened headless Claude chats enroll; arbitrary IDs, resumes and opt-outs never do', (t) => {
  const { store } = setup(t);
  store.bind(key, coordinator);
  for (const [change, call] of [
    [{ continued: true }, {}], [{ continued: undefined }, {}], [{ delivery: 'attended' }, {}],
    [{ state: 'duplicate' }, {}], [{ app: { opened: false } }, {}], [{ app: undefined }, {}],
    [{}, { optOut: true }], [{}, { vendor: 'codex' }],
  ]) assert.equal(provision(store, change, call).app?.remoteControl, undefined);
  assert.deepEqual(store.status().counts, {});
  assert.equal(provision(store, { threadId: other }, { createdForRequest: id => id === target }).app.remoteControl.state, 'setup-error');
  assert.deepEqual(store.status().counts, {});
  assert.equal(provision(store, { threadId: '../not-a-chat' }).app.remoteControl.state, 'setup-error');
  assert.equal(provision(store).app.remoteControl.state, 'pending');
  assert.equal(provision(store).app.remoteControl.state, 'pending');
  assert.deepEqual(store.status().counts, { pending: 1 });
});

test('durable offline work wakes only its bound coordinator across folders and batches without user text', (t) => {
  const { dir, store, mailbox } = setup(t);
  mailbox.claimListener(box, coordinator);
  remoteCommand('enable', { ...identity, thread: 'local_' + coordinator }, { store, mailbox });
  provision(store, { message: 'private prompt', cwd: '/private/project', reply: 'private reply' });
  provision(store, { threadId: other });
  const reopened = remoteStore(dir);
  const notices = [];
  const run = (b, s) => notifyRemoteWork({store: reopened, box: b, session: s, emit: n => notices.push(n), warn: assert.fail})();
  run({ ...box, project: '/different' }, coordinator);
  run(box, target);
  assert.equal(notices.length, 0);
  run(box, coordinator);
  run(box, coordinator);
  assert.equal(notices.length, 1);
  const { jobs } = remoteCommand('work', identity, { store: reopened, mailbox });
  assert.deepEqual(jobs.map(j => j.target), [target, other]);
  assert.doesNotMatch(JSON.stringify({ notices, jobs }), /private (prompt|reply)|private\/project/);
  assert.equal(reopened.work(key, other).length, 0);
  assert.equal(reopened.status(target).job.state, 'pending');
  reopened.report(target, jobs[0].receipt, 'active');
  assert.equal(reopened.status(target).job.state, 'active');
  assert.ok(reopened.status(target).job.verifiedAtMs > 0);
  assert.equal(reopened.status(other).job.state, 'pending');
});

test('lost notices retry; wrong or cancelled receipts cannot mark a different chat active', (t) => {
  const { store, advance } = setup(t);
  store.bind(key, coordinator);
  store.enqueue(target);
  store.enqueue(other);
  assert.equal(store.due(key, coordinator).length, 2);
  const receipt = store.work(key, coordinator)[0].receipt;
  assert.throws(() => store.report(other, receipt, 'active'), /matching/);
  assert.throws(() => store.report(target, receipt, 'on'), /Result must/);
  advance(REMINDER_MS - 1);
  assert.deepEqual(store.due(key, coordinator), []);
  advance(1);
  assert.equal(store.due(key, coordinator).length, 2);
  assert.equal(store.work(key, coordinator)[0].receipt, receipt);
  store.disable();
  assert.throws(() => store.report(target, receipt, 'active'), /matching/);
  assert.deepEqual(store.due(key, coordinator), []);
  assert.equal(store.status(target).job.state, 'cancelled');
});

test('platform refusal stays visible until explicitly retried; retry cannot enroll an unrelated session', (t) => {
  const { store } = setup(t);
  store.bind(key, coordinator);
  assert.throws(() => store.bind(key, other), /different coordinator/);
  assert.throws(() => store.retry(other), /eligible/);
  store.enqueue(target);
  store.due(key, coordinator);
  const receipt = store.work(key, coordinator)[0].receipt;
  store.report(target, receipt, 'approval-required');
  assert.equal(store.status(target).job.verifiedAtMs, null);
  assert.deepEqual(store.due(key, coordinator), []);
  store.retry(target);
  assert.throws(() => store.report(target, receipt, 'active'), /matching/);
  assert.deepEqual(store.due(key, coordinator), [target]);
});

test('unanswered jobs stop waking Desktop after three notices and can be explicitly retried', (t) => {
  const { store, advance } = setup(t);
  store.bind(key, coordinator);
  store.enqueue(target);
  for (let attempt = 1; attempt <= MAX_NOTICES; attempt++) {
    assert.deepEqual(store.due(key, coordinator), [target]);
    assert.equal(store.work(key, coordinator)[0].attempts, attempt);
    advance(REMINDER_MS);
  }
  assert.deepEqual(store.due(key, coordinator), []);
  assert.equal(store.status(target).job.state, 'unavailable');
  advance(24 * 60 * 60_000);
  assert.deepEqual(store.due(key, coordinator), []);
  assert.deepEqual(store.work(key, coordinator), []);
  store.retry(target);
  assert.deepEqual(store.due(key, coordinator), [target]);
  assert.equal(store.work(key, coordinator)[0].attempts, 1);
});

test('the live listener runs the Desktop hook on startup and each heartbeat, not each poll', async (t) => {
  const { mailbox } = setup(t);
  let time = 0;
  const beats = [];
  await runListener({ mailbox, box, session: coordinator, emit: assert.fail,
    now: () => time, pollMs: 1000, beatMs: 5000, stopped: () => time >= 11000,
    sleep: async (ms) => { time += ms; }, onHeartbeat: () => beats.push(time) });
  assert.deepEqual(beats, [0, 5000, 10000]);
});

test('setup errors never erase the answer or cause a second call', () => {
  const failures = { enqueue() { throw new Error('out of space'); } };
  const result = provision(failures, { reply: 'answer' });
  assert.equal(result.state, 'answered');
  assert.equal(result.reply, 'answer');
  assert.deepEqual(result.app.remoteControl, { state: 'setup-error', reason: 'out of space' });
});
