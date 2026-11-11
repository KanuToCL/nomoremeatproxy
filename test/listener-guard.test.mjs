import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runListener } from '../src/listen.mjs';
import { LISTENER_MAX_AGE_MS, mailboxKey, openMailbox } from '../src/mailbox.mjs';
import { HELD_CLAIM_MS } from '../src/listener-lease.mjs';
import { remoteStore } from '../src/remote-control-store.mjs';

const box = { project: process.cwd(), peer: 'fable' };
const request = { ...box, requestId: 'ping', from: 'astra', hop: 1, maxHops: 4, message: 'hello' };

function setup(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nomeat-lease-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let time = Date.now();
  return { dir, mailbox: openMailbox(dir, { now: () => time }), advance: (ms) => (time += ms) };
}

test('a second chat is refused by the CLI without collecting a request or silencing the first', (t) => {
  const { mailbox, dir } = setup(t);
  const first = mailbox.claimListener(box, 'one');
  mailbox.post(request);
  const cli = fileURLToPath(new URL('../bin/nomeat.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [cli, 'listen', '--as', box.peer, '--thread', 'two'], {
    env: { ...process.env, NOMEAT_STATE_DIR: dir }, encoding: 'utf8', timeout: 5000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /fable already has a listener.*one/);
  assert.equal(result.stdout, '');
  assert.deepEqual(mailbox.listener(box), { session: 'one' });
  assert.deepEqual(first.poll(false).map((r) => r.requestId), ['ping']);
});

test('a same-chat restart takes over; the previous loop neither collects nor removes its replacement', async (t) => {
  const { mailbox } = setup(t);
  let next;
  await runListener({
    mailbox, box, session: 'one',
    emit: () => assert.fail('replaced loop took the message'),
    sleep: async () => {
      assert.equal(next, undefined, 'previous loop kept running');
      next = mailbox.claimListener(box, 'one');
      mailbox.post(request);
    },
  });
  assert.deepEqual(mailbox.listener(box), { session: 'one' });
  assert.deepEqual(next.poll(false).map((r) => r.requestId), ['ping']);
  next.release();
  assert.equal(mailbox.listener(box), null);
});

test('a heartbeat is fresh at the TTL; after takeover a paused owner cannot revive or clear it', (t) => {
  const { mailbox, advance } = setup(t);
  const old = mailbox.claimListener(box, 'one');
  advance(LISTENER_MAX_AGE_MS);
  assert.throws(() => mailbox.claimListener(box, 'two'), /already has a listener/);
  advance(1);
  const current = mailbox.claimListener(box, 'two');
  mailbox.post(request);
  assert.equal(old.poll(true), null);
  old.release();
  assert.deepEqual(mailbox.listener(box), { session: 'two' });
  assert.deepEqual(current.poll(false).map((r) => r.requestId), ['ping']);
});

test('two unidentified listeners cannot claim a same-session restart', (t) => {
  const { mailbox } = setup(t);
  const owner = mailbox.claimListener(box);
  assert.throws(() => mailbox.claimListener(box), /unknown chat/);
  assert.throws(() => mailbox.claimListener(box, 'named'), /already has a listener/);
  owner.release();
  mailbox.claimListener(box, 'named');
  assert.throws(() => mailbox.claimListener(box), /already has a listener/);
});

test('an active legacy heartbeat stays visible and is not displaced during upgrade', (t) => {
  const { mailbox, dir } = setup(t);
  const listeners = path.join(dir, 'inbox', 'listeners');
  mkdirSync(listeners, { recursive: true });
  writeFileSync(path.join(listeners, mailboxKey(box) + '.json'), JSON.stringify({ session: 'one', at: Date.now() }));
  assert.deepEqual(mailbox.listener(box), { session: 'one' });
  assert.throws(() => mailbox.claimListener(box, 'two'), /already has a listener/);
  assert.throws(() => mailbox.claimListener(box, 'one'), /already has a listener/);
});

test('an exception in the running loop releases the lease', async (t) => {
  const { mailbox } = setup(t);
  mailbox.post(request);
  await assert.rejects(runListener({
    mailbox, box, session: 'one', emit: () => { throw new Error('output closed'); },
  }), /output closed/);
  assert.equal(mailbox.listener(box), null);
});

test('an unreadable heartbeat is absent to callers, but a claimant cannot overwrite it', (t) => {
  const { dir, mailbox } = setup(t);
  const file = path.join(dir, 'inbox', 'listeners', mailboxKey(box) + '.json');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '{broken');
  assert.equal(mailbox.listener(box), null);
  assert.throws(() => mailbox.claimListener(box, 'two'), SyntaxError);
  assert.equal(readFileSync(file, 'utf8'), '{broken');
});

// --- listen --once ---

const cli = fileURLToPath(new URL('../bin/nomeat.mjs', import.meta.url));
const listenOnce = (dir, ...extra) => spawnSync(process.execPath, [cli, 'listen', '--as', box.peer, '--once', ...extra], {
  env: { ...process.env, NOMEAT_STATE_DIR: dir }, encoding: 'utf8', timeout: 10000,
});

test('listen --once exits with code 0 after printing the first request, and keeps the claim', (t) => {
  const { mailbox, dir } = setup(t);
  mailbox.post(request);
  const result = listenOnce(dir, '--thread', 'one');
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  const printed = JSON.parse(lines[0]);
  assert.equal(printed.requestId, 'ping');
  // The printed line carries the instruction with the real sender and id, before the message.
  assert.deepEqual(Object.keys(printed), ['requestId', 'from', 'hop', 'maxHops', 'file', 'instruction', 'message']);
  assert.match(printed.instruction, /name astra as its sender.*nomeat reply --request-id ping$/);
  assert.equal(printed.message, 'hello');
  assert.deepEqual(mailbox.listener(box), { session: 'one' });
});

test('listen --once also exits after a Remote Control notice', (t) => {
  const { dir } = setup(t);
  const coordinator = '11111111-1111-4111-8111-111111111111';
  const store = remoteStore(dir);
  store.bind(mailboxKey(box), coordinator);
  store.enqueue('22222222-2222-4222-8222-222222222222');
  const result = listenOnce(dir, '--thread', coordinator);
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  const notice = JSON.parse(lines[0]);
  assert.equal(notice.kind, 'remote-control');
  // A notice is not a request: it gets no request instruction.
  assert.deepEqual(Object.keys(notice), ['kind', 'message', 'args']);
});

test('listen --once without --thread is a usage error', (t) => {
  const { dir } = setup(t);
  const result = listenOnce(dir);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--once needs --thread/);
});

// One --once run: it stops after its first output and holds the claim, as the CLI does.
async function onceRun(mailbox, session) {
  const emitted = [];
  await runListener({
    mailbox, box, session, sleep: async () => {},
    emit: (taken) => emitted.push(taken.requestId),
    stopped: () => emitted.length > 0,
    holdClaim: () => emitted.length > 0,
  });
  return emitted;
}

test('between two --once runs the chat still counts as listening, and the next run delivers what arrived', async (t) => {
  const { mailbox, advance } = setup(t);
  mailbox.post(request);
  assert.deepEqual(await onceRun(mailbox, 'one'), ['ping']);
  // The gap: a caller sees the chat listening, so its request waits in the inbox.
  advance(HELD_CLAIM_MS);
  assert.deepEqual(mailbox.listener(box), { session: 'one' });
  mailbox.post({ ...request, requestId: 'pong' });
  assert.throws(() => mailbox.claimListener(box, 'two'), /already has a listener/);
  assert.deepEqual(await onceRun(mailbox, 'one'), ['pong']);
});

test('without a next start the held claim expires, callers fall back and another chat may claim', async (t) => {
  const { mailbox, advance } = setup(t);
  mailbox.post(request);
  await onceRun(mailbox, 'one');
  advance(HELD_CLAIM_MS + 1);
  assert.equal(mailbox.listener(box), null);
  mailbox.claimListener(box, 'two');
  assert.deepEqual(mailbox.listener(box), { session: 'two' });
});

test('two independent processes starting together elect exactly one listener', { timeout: 10000 }, async (t) => {
  const { mailbox, dir } = setup(t);
  const moduleUrl = new URL('../src/mailbox.mjs', import.meta.url).href;
  const worker = `
    import { openMailbox } from ${JSON.stringify(moduleUrl)};
    const [dir, project, session] = process.argv.slice(1);
    process.once('message', () => {
      try {
        openMailbox(dir).claimListener({project, peer: 'fable'}, session);
        process.send({winner: session});
      } catch (error) { process.send({error: error.message}); }
      process.disconnect();
    });
    process.send('ready');
  `;
  const children = ['one', 'two'].map((id) => spawn(process.execPath,
    ['--input-type=module', '-e', worker, dir, box.project, id], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }));
  t.after(() => children.forEach((child) => { if (child.exitCode === null) child.kill(); }));
  await Promise.all(children.map(async (child) => assert.equal((await once(child, 'message'))[0], 'ready')));
  const results = Promise.all(children.map((child) => once(child, 'message').then(([result]) => result)));
  for (const child of children) child.send('go');
  const outcomes = await results;
  const winners = outcomes.filter((result) => result.winner);
  assert.equal(winners.length, 1, JSON.stringify(outcomes));
  assert.match(outcomes.find((result) => result.error)?.error ?? '', /already has a listener/);
  assert.deepEqual(mailbox.listener(box), { session: winners[0].winner });
});
