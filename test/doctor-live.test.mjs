import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { liveExitCode, runLiveChecks, runWithDeadline } from '../src/doctor-live.mjs';

// Nothing here calls a real peer: `run` stands in for `nomeat call`.
const SESSION = '00000000-0000-4000-8000-000000000002';
const IDENTITY = 'someone@example.com';
const READY = [
  { id: 'codex-cli', status: 'found' },
  { id: 'codex-auth', status: 'found' },
  { id: 'claude-cli', status: 'found' },
  { id: 'claude-auth', status: 'found' },
];
const withStatus = (id, status) => READY.map((c) => (c.id === id ? { ...c, status } : c));
const result = (outcome, status = 0) => ({ status, stdout: JSON.stringify(outcome), timedOut: false });
const answered = (extra = {}) => result({ state: 'answered', threadId: 't', reply: 'ok', ...extra });

function fakeRun(byPeer) {
  const calls = [];
  return { calls, run: async (peer, requestId) => (calls.push({ peer, requestId }), byPeer[peer]) };
}

test('both sides answering, and the Claude chat opener starting, pass with exit code 0', async () => {
  const fake = fakeRun({ astra: answered({ delivery: 'direct' }), fable: answered({ app: { opened: true } }) });
  const live = await runLiveChecks({ checks: READY, run: fake.run });
  assert.deepEqual(live.sides, [
    { side: 'codex', peer: 'astra', cliFound: true, answered: true, appOpened: null, ok: true, detail: '' },
    { side: 'claude', peer: 'fable', cliFound: true, answered: true, appOpened: true, ok: true, detail: '' },
  ]);
  assert.equal(liveExitCode(live), 0);
});

test('each side is called once, with its own generated request id', async () => {
  const fake = fakeRun({ astra: answered(), fable: answered({ app: { opened: true } }) });
  await runLiveChecks({ checks: READY, run: fake.run });
  assert.deepEqual(fake.calls.map((c) => c.peer), ['astra', 'fable']);
  for (const { requestId } of fake.calls) assert.match(requestId, /^[0-9a-f-]{36}$/);
  assert.notEqual(fake.calls[0].requestId, fake.calls[1].requestId);
});

test('a side is not run unless its command line and its sign-in are both found', async () => {
  for (const [id, status] of [['codex-cli', 'missing'], ['codex-cli', 'warning'], ['codex-auth', 'warning'], ['codex-auth', 'unknown'], ['codex-auth', 'missing']]) {
    const fake = fakeRun({ fable: answered({ app: { opened: true } }) });
    const live = await runLiveChecks({ checks: withStatus(id, status), run: fake.run });
    assert.deepEqual(fake.calls.map((c) => c.peer), ['fable'], `${id} ${status}`);
    assert.equal(live.sides[0].detail, 'not run: the command line or the subscription sign-in was not found');
    assert.equal(liveExitCode(live), 1);
  }
});

test('a failed call fails its side with fixed wording, never the vendor output', async () => {
  const refused = { status: 1, stdout: '', stderr: `nomeat failed: API Error 400 for ${IDENTITY} (session ${SESSION})`, timedOut: false };
  const live = await runLiveChecks({ checks: READY, run: fakeRun({ astra: answered(), fable: refused }).run });
  assert.deepEqual(live.sides[1], { side: 'claude', peer: 'fable', cliFound: true, answered: false, appOpened: null, ok: false, detail: 'not answered: exit code 1' });
  assert.equal(liveExitCode(live), 1);
});

test('a note or opener reason from the result is not repeated, and the reply is never reported', async () => {
  const fake = fakeRun({
    astra: result({ state: 'refused', note: `refused for ${IDENTITY}` }, 3),
    fable: answered({ reply: `private words ${IDENTITY}`, app: { opened: false, reason: `spawn /home/${IDENTITY}/claude ENOENT` } }),
  });
  const live = await runLiveChecks({ checks: READY, run: fake.run });
  assert.equal(live.sides[0].detail, 'not answered: state refused, exit code 3');
  assert.equal(live.sides[1].detail, 'answered, but the chat opener did not start');
  assert.equal(live.sides[1].ok, false);
  assert.ok(!JSON.stringify(live).includes(IDENTITY));
});

test('an uncertain result, or a call ended at the deadline, is reported as uncertain and not retried', async () => {
  const fake = fakeRun({ astra: result({ state: 'uncertain', threadId: 't' }, 3), fable: { status: null, stdout: '', timedOut: true, treeEnded: true } });
  const live = await runLiveChecks({ checks: READY, run: fake.run });
  assert.match(live.sides[0].detail, /^uncertain: .*not retried/);
  assert.match(live.sides[1].detail, /deadline; the process tree was ended; delivery uncertain, not retried/);
  assert.equal(fake.calls.length, 2);
});

test('a call whose processes could not be ended says so instead of claiming the tree ended', async () => {
  const fake = fakeRun({ astra: answered(), fable: { status: null, stdout: '', timedOut: true, treeEnded: false } });
  const live = await runLiveChecks({ checks: READY, run: fake.run });
  assert.equal(live.sides[1].detail, 'no answer before the deadline; ending its processes did not succeed, some may still run; delivery uncertain, not retried');
  assert.equal(live.ok, false);
});

test('the deadline settles the call even when cleanup fails and the process never closes', async () => {
  const pids = [];
  const started = Date.now();
  const ended = await runWithDeadline(['-e', 'setInterval(() => {}, 1e9)'], { deadlineMs: 500, endTree: (pid) => (pids.push(pid), false) });
  const took = Date.now() - started;
  process.kill(pids[0]);
  assert.deepEqual({ timedOut: ended.timedOut, treeEnded: ended.treeEnded, status: ended.status }, { timedOut: true, treeEnded: false, status: null });
  // Settled at the deadline, not when the process closed: it was still running.
  assert.ok(took < 3000, `settled after ${took} ms`);
});

// Real processes: a wrapper that starts a child and both run forever. On Windows Node already
// ends a wrapper's ordinary children with it (they share a job object), so the child there is
// detached: only a walk of the process tree ends it. Elsewhere it stays in the wrapper's group.
test('the deadline ends the whole process tree, not only the wrapper', async () => {
  const pidFile = path.join(mkdtempSync(path.join(os.tmpdir(), 'nomeat-live-')), 'child.pid');
  const wrapper = `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { detached: process.platform === 'win32', stdio: 'ignore' });
    require('node:fs').writeFileSync(process.argv[1], String(child.pid));
    setInterval(() => {}, 1e9);`;
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const ended = await runWithDeadline(['-e', wrapper, pidFile], { deadlineMs: 1500 });
  assert.equal(ended.timedOut, true);
  assert.equal(ended.treeEnded, true);
  assert.ok(existsSync(pidFile), 'the wrapper started its child');
  const childPid = Number(readFileSync(pidFile, 'utf8'));
  for (let i = 0; i < 20 && alive(childPid); i += 1) await sleep(100);
  const survived = alive(childPid);
  if (survived) process.kill(childPid);
  assert.equal(survived, false, 'the child must not outlive the deadline');
});
