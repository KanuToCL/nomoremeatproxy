import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import readline from 'node:readline';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { callCodex } from '../src/adapters/codex.mjs';
import { openNewCodexThread } from '../src/adapters/codex-app.mjs';
import { SERVER_STILL_RUNNING, withCodexServer } from '../src/adapters/codex-transport.mjs';

// Every test runs the real call and transport against a stand-in server: nothing reaches Codex.
const THREAD = '00000000-0000-7000-8000-000000000002';
const line = (message) => `${JSON.stringify(message)}\n`;

// A stand-in for the spawned `codex app-server`, speaking JSON lines on in-memory streams. It
// runs one turn that answers "the answer". Told to stop, it ends `endAfterMs` later, or never
// with null; with `endEarly` it ends right after the handshake. Steps go to `log`.
function fakeServer(log, { endAfterMs = 30, endEarly = false, killThrows = false } = {}) {
  return () => {
    const server = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough() });
    const end = () => {
      log.push('ended');
      server.stdout.end();
      server.emit('exit', 0, null);
      server.emit('close', 0, null);
    };
    server.kill = () => {
      log.push('signalled');
      if (killThrows) throw new Error('kill failed');
      if (endAfterMs !== null && !endEarly) setTimeout(end, endAfterMs);
      return true;
    };
    const results = { 'thread/start': { thread: { id: THREAD } }, 'turn/start': { turn: { id: 'turn-1' } } };
    readline.createInterface({ input: server.stdin }).on('line', (text) => {
      const { id, method } = JSON.parse(text);
      if (id === undefined) return;
      server.stdout.write(line({ id, result: results[method] ?? {} }));
      if (method === 'initialize' && endEarly) setImmediate(end);
      if (method === 'turn/start') {
        const item = { type: 'agentMessage', text: 'the answer', phase: 'final_answer' };
        server.stdout.write(line({ method: 'item/completed', params: { threadId: THREAD, turnId: 'turn-1', item } }));
        server.stdout.write(line({ method: 'turn/completed', params: { threadId: THREAD, turn: { id: 'turn-1', status: 'completed' } } }));
      }
    });
    return server;
  };
}

// A stand-in for the link opener: logs its start and exits with code 0.
const fakeOpener = (log) => () => {
  log.push('opener started');
  const child = new EventEmitter();
  process.nextTick(() => child.emit('exit', 0, null));
  return child;
};

const callWith = (server, exitTimeoutMs) =>
  callCodex({ message: 'hi', title: 't', cwd: '/work', timeoutMs: 5000, withServer: (work, options) => withCodexServer(work, { ...options, start: server, ...(exitTimeoutMs ? { exitTimeoutMs } : {}) }) });

const createdOutcome = (result) => ({ state: 'answered', continued: false, ...result });

test("a call returns only after the bridge's Codex server has ended, so its new thread is opened after that", async () => {
  const log = [];
  const result = await callWith(fakeServer(log));
  log.push('answered');
  const outcome = createdOutcome(result);
  await openNewCodexThread({ outcome, optOut: false, platform: 'win32', start: fakeOpener(log) });
  assert.deepEqual(log, ['signalled', 'ended', 'answered', 'opener started']);
  assert.equal(result.reply, 'the answer');
  assert.equal(Object.hasOwn(result, 'warning'), false);
  assert.deepEqual(outcome.app, { opened: true });
});

test('a server that has not ended at the limit leaves the call answered with a warning, and the link is opened anyway with a reason', async () => {
  const log = [];
  const result = await callWith(fakeServer(log, { endAfterMs: null }), 20);
  assert.equal(result.reply, 'the answer');
  assert.equal(result.warning, SERVER_STILL_RUNNING);
  const outcome = createdOutcome(result);
  await openNewCodexThread({ outcome, optOut: false, platform: 'win32', start: fakeOpener(log) });
  assert.deepEqual(log, ['signalled', 'opener started']);
  const early = `${SERVER_STILL_RUNNING}, so the chat may not come up in the app until its link is opened again`;
  assert.deepEqual(outcome.app, { opened: true, reason: early });

  // An opener that fails as well keeps both reasons, the server's first.
  const failing = createdOutcome(result);
  const missing = () => {
    const child = new EventEmitter();
    process.nextTick(() => child.emit('error', Object.assign(new Error('spawn cmd.exe ENOENT'), { code: 'ENOENT' })));
    return child;
  };
  await openNewCodexThread({ outcome: failing, optOut: false, platform: 'win32', start: missing });
  assert.deepEqual(failing.app, { opened: false, supported: false, reason: `${early}; cmd.exe was not found, so nothing was opened` });
});

test('a stop signal that throws does not lose the answer', async () => {
  const log = [];
  const result = await callWith(fakeServer(log, { killThrows: true }), 20);
  assert.equal(result.reply, 'the answer');
  assert.equal(result.warning, SERVER_STILL_RUNNING);
});

test('a server that ended before it was told to stop costs no wait', async () => {
  const log = [];
  let stillRunning = false;
  // The limit is short: a wait that missed the earlier end would reach it and report the server.
  const answer = await withCodexServer(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    return 'done';
  }, { start: fakeServer(log, { endEarly: true }), exitTimeoutMs: 50, onStillRunning: () => (stillRunning = true) });
  assert.equal(answer, 'done');
  assert.equal(stillRunning, false);
  assert.deepEqual(log, ['ended', 'signalled']);
});
