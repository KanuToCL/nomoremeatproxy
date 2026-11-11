import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { openInCodexApp, openNewCodexThread } from '../src/adapters/codex-app.mjs';

// The shape of a real Codex thread id (a UUID, version 7).
const THREAD = '00000000-0000-7000-8000-000000000001';
const LINK = `codex://threads/${THREAD}`;

// A stand-in for spawn: records what would be started, then fails to start with `error` or
// exits with `code` (0 by default). Nothing real is ever started.
function fakeStart({ error, code = 0 } = {}) {
  const starts = [];
  const start = (file, args, options) => {
    const child = new EventEmitter();
    starts.push({ file, args, options });
    process.nextTick(() => (error ? child.emit('error', error) : child.emit('exit', code, null)));
    return child;
  };
  return { starts, start };
}

// What callPeer returns for a call that created its thread.
const created = (overrides = {}) => ({ requestId: 'r-1', peer: 'astra', vendor: 'codex', state: 'answered', threadId: THREAD, continued: false, delivery: 'direct', reply: 'ok', ...overrides });

test('a thread the call created is opened once, by its link, with the opener of each system', async () => {
  const expected = {
    win32: ['cmd.exe', ['/c', 'start', '', LINK]],
    darwin: ['open', [LINK]],
    linux: ['xdg-open', [LINK]],
  };
  for (const [platform, [file, args]] of Object.entries(expected)) {
    const fake = fakeStart();
    const outcome = created();
    await openNewCodexThread({ outcome, optOut: false, platform, start: fake.start });
    assert.deepEqual(outcome.app, { opened: true }, platform);
    assert.equal(fake.starts.length, 1, platform);
    assert.deepEqual([fake.starts[0].file, fake.starts[0].args], [file, args], platform);
    assert.equal(fake.starts[0].options.detached, true);
    assert.equal(fake.starts[0].options.stdio, 'ignore');
  }
});

test('a continued thread is not opened', async () => {
  const fake = fakeStart();
  const outcome = created({ continued: true });
  await openNewCodexThread({ outcome, optOut: false, platform: 'win32', start: fake.start });
  assert.equal(Object.hasOwn(outcome, 'app'), false);
  assert.deepEqual(fake.starts, []);
});

test('with --no-open a created thread is not opened', async () => {
  const fake = fakeStart();
  const outcome = created();
  await openNewCodexThread({ outcome, optOut: true, platform: 'win32', start: fake.start });
  assert.equal(Object.hasOwn(outcome, 'app'), false);
  assert.deepEqual(fake.starts, []);
});

test('a call that was not answered opens nothing', async () => {
  // A sent call names an existing thread; a refused or duplicate one has no `continued` field.
  for (const outcome of [created({ state: 'sent' }), { state: 'refused', threadId: THREAD }, { state: 'duplicate', threadId: THREAD }]) {
    const fake = fakeStart();
    await openNewCodexThread({ outcome, optOut: false, platform: 'win32', start: fake.start });
    assert.equal(Object.hasOwn(outcome, 'app'), false, outcome.state);
    assert.deepEqual(fake.starts, []);
  }
});

test('an opener that fails leaves the call answered, not opened, with a reason', async () => {
  const outcome = created();
  await openNewCodexThread({ outcome, optOut: false, platform: 'darwin', start: fakeStart({ code: 1 }).start });
  assert.equal(outcome.state, 'answered');
  assert.deepEqual(outcome.app, { opened: false, reason: 'the opener exited with code 1' });

  const denied = created();
  const error = Object.assign(new Error('spawn open EACCES'), { code: 'EACCES' });
  await openNewCodexThread({ outcome: denied, optOut: false, platform: 'darwin', start: fakeStart({ error }).start });
  assert.equal(denied.state, 'answered');
  assert.deepEqual(denied.app, { opened: false, reason: 'the opener did not start: spawn open EACCES' });
});

test('an opener program that is not installed is reported as not supported, and the call stays answered', async () => {
  const outcome = created();
  const missing = Object.assign(new Error('spawn xdg-open ENOENT'), { code: 'ENOENT' });
  await openNewCodexThread({ outcome, optOut: false, platform: 'linux', start: fakeStart({ error: missing }).start });
  assert.equal(outcome.state, 'answered');
  assert.deepEqual(outcome.app, { opened: false, supported: false, reason: 'xdg-open was not found, so nothing was opened' });
});

test('an opener that throws while starting is reported, not thrown', async () => {
  const result = await openInCodexApp(THREAD, { platform: 'win32', start: () => { throw new Error('bad'); } });
  assert.deepEqual(result, { opened: false, reason: 'the opener did not start: bad' });
});

test('a thread id of the wrong shape is not opened, and the call is not failed', async () => {
  for (const threadId of ['x & calc', `${THREAD}&calc`, '../threads', '', undefined, null]) {
    const fake = fakeStart();
    const outcome = created({ threadId });
    await openNewCodexThread({ outcome, optOut: false, platform: 'win32', start: fake.start });
    assert.deepEqual(outcome.app, { opened: false, reason: 'the thread id is not a UUID, so nothing was opened' }, String(threadId));
    assert.deepEqual(fake.starts, []);
  }
});

test('on a platform with no known opener nothing is attempted, and it is reported as not supported', async () => {
  const fake = fakeStart();
  const result = await openInCodexApp(THREAD, { platform: 'aix', start: fake.start });
  assert.deepEqual(result, { opened: false, supported: false, reason: 'no opener for links is known on this platform, so nothing was attempted' });
  assert.deepEqual(fake.starts, []);
});
