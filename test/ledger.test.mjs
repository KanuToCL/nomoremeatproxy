import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { defaultStateDir, openLedger } from '../src/ledger.mjs';

const tempDir = () => mkdtempSync(path.join(os.tmpdir(), 'nomeat-ledger-'));

test('history is empty before anything is written', () => {
  assert.deepEqual(openLedger(tempDir()).history('req-1'), []);
});

test('history returns only the entries of the requested id, in order', () => {
  const ledger = openLedger(tempDir());
  ledger.append({ requestId: 'req-1', state: 'submitting' });
  ledger.append({ requestId: 'req-2', state: 'submitting' });
  ledger.append({ requestId: 'req-1', state: 'answered' });
  assert.deepEqual(ledger.history('req-1').map((entry) => entry.state), ['submitting', 'answered']);
});

test('entries survive reopening the ledger, as after a restart', () => {
  const dir = tempDir();
  openLedger(dir).append({ requestId: 'req-1', state: 'answered', threadId: 'thread-1' });
  assert.equal(openLedger(dir).history('req-1')[0].threadId, 'thread-1');
});

test('entries carry the time of writing', () => {
  const ledger = openLedger(tempDir(), { now: () => new Date('2026-11-10T12:00:00Z') });
  assert.equal(ledger.append({ requestId: 'req-1', state: 'submitting' }).at, '2026-11-10T12:00:00.000Z');
});

test('a torn last line does not hide earlier entries', () => {
  const ledger = openLedger(tempDir());
  ledger.append({ requestId: 'req-1', state: 'submitting' });
  appendFileSync(ledger.file, '{"requestId":"req-1","state":"answ');
  assert.deepEqual(ledger.history('req-1').map((entry) => entry.state), ['submitting']);
});

test('NOMEAT_STATE_DIR overrides the platform default', () => {
  assert.equal(defaultStateDir({ NOMEAT_STATE_DIR: 'X:/state', APPDATA: 'C:/roaming' }, 'win32'), 'X:/state');
});

// Windows gives each Store app its own copy of AppData, so two desktop apps would not share it.
test('the Windows default sits in the home folder, not under AppData', () => {
  assert.equal(defaultStateDir({ APPDATA: 'C:/roaming' }, 'win32', 'C:/home'), path.join('C:/home', '.nomoremeatproxy'));
});

test('other platforms use XDG_STATE_HOME when it is set, and the home folder otherwise', () => {
  assert.equal(defaultStateDir({ XDG_STATE_HOME: '/state' }, 'linux', '/home/me'), path.join('/state', 'nomoremeatproxy'));
  assert.equal(defaultStateDir({}, 'linux', '/home/me'), path.join('/home/me', '.local', 'state', 'nomoremeatproxy'));
});

// --- which thread to continue ---

const ROUTE = Object.freeze({ project: '/work/app', from: 'astra', peer: 'fable' });

test('the thread to continue is the last answered one for the same project, caller and peer', () => {
  const ledger = openLedger(tempDir());
  ledger.append({ requestId: 'req-1', ...ROUTE, state: 'answered', threadId: 'thread-1' });
  ledger.append({ requestId: 'req-2', ...ROUTE, state: 'answered', threadId: 'thread-2' });
  ledger.append({ requestId: 'req-3', ...ROUTE, from: 'sol', state: 'answered', threadId: 'thread-3' });
  assert.equal(ledger.lastThread(ROUTE), 'thread-2');
});

test('a chat that answered while attended in its app is not the thread to continue', () => {
  const ledger = openLedger(tempDir());
  ledger.append({ requestId: 'req-1', ...ROUTE, state: 'answered', threadId: 'thread-1' });
  ledger.append({ requestId: 'req-2', ...ROUTE, state: 'answered', threadId: 'live-chat', delivery: 'attended' });
  ledger.append({ requestId: 'req-3', ...ROUTE, state: 'answered', threadId: null });
  assert.equal(ledger.lastThread(ROUTE), 'thread-1');
});

test('the answer to a call steered into a new or an exact thread is not the thread to continue, recovered or not', () => {
  const ledger = openLedger(tempDir());
  ledger.append({ requestId: 'req-1', ...ROUTE, state: 'answered', threadId: 'thread-1' });
  ledger.append({ requestId: 'req-2', ...ROUTE, state: 'submitting', steered: 'new', threadId: null });
  ledger.append({ requestId: 'req-2', ...ROUTE, state: 'answered', threadId: 'side-thread' });
  ledger.append({ requestId: 'req-3', ...ROUTE, state: 'submitting', steered: 'thread', threadId: 'thread-manual' });
  ledger.append({ requestId: 'req-3', ...ROUTE, state: 'answered', threadId: 'thread-manual', recovered: true });
  assert.equal(ledger.lastThread(ROUTE), 'thread-1');
});

test('the standing thread is the last one named for the route, and other routes do not see it', () => {
  const ledger = openLedger(tempDir());
  assert.equal(ledger.standingThread(ROUTE), null);
  ledger.append({ ...ROUTE, state: 'standing', threadId: 'thread-1' });
  ledger.append({ ...ROUTE, state: 'standing', threadId: 'thread-2' });
  ledger.append({ ...ROUTE, from: 'sol', state: 'standing', threadId: 'thread-3' });
  assert.equal(ledger.standingThread(ROUTE), 'thread-2');
  assert.equal(ledger.standingThread({ ...ROUTE, project: '/work/other' }), null);
});

test('an answered call does not move the standing thread by being more recent', () => {
  const ledger = openLedger(tempDir());
  ledger.append({ ...ROUTE, state: 'standing', threadId: 'thread-1' });
  ledger.append({ requestId: 'req-9', ...ROUTE, state: 'answered', threadId: 'side-thread' });
  assert.equal(ledger.standingThread(ROUTE), 'thread-1');
});

// --- what a thread was created with ---

test('a thread keeps the access of its earliest record, and an unknown thread has none', () => {
  const ledger = openLedger(tempDir());
  ledger.append({ requestId: 'req-1', ...ROUTE, state: 'submitting', threadId: null });
  ledger.append({ requestId: 'req-1', ...ROUTE, state: 'answered', threadId: 'thread-1', access: 'read-only' });
  ledger.append({ requestId: 'req-2', ...ROUTE, state: 'answered', threadId: 'thread-1', access: 'write' });
  assert.equal(ledger.threadAccess('thread-1'), 'read-only');
  assert.equal(ledger.threadAccess('thread-2'), null);
  assert.equal(ledger.threadAccess(null), null);
});

// --- calls still in flight ---

test('a sent call with no outcome yet is open; an answered or failed one is not', () => {
  const ledger = openLedger(tempDir());
  const query = { ...ROUTE, maxAgeMs: 60_000 };
  assert.equal(ledger.openCall(query), null);
  ledger.append({ requestId: 'req-1', ...ROUTE, state: 'submitting' });
  assert.equal(ledger.openCall(query).requestId, 'req-1');
  assert.equal(ledger.openCall({ ...query, from: 'fable', peer: 'astra' }), null);
  ledger.append({ requestId: 'req-1', state: 'answered' });
  assert.equal(ledger.openCall(query), null);
  ledger.append({ requestId: 'req-2', ...ROUTE, state: 'submitting' });
  ledger.append({ requestId: 'req-2', state: 'failed' });
  assert.equal(ledger.openCall(query), null);
});

test('a call sent longer ago than the limit no longer counts as open', () => {
  let time = Date.parse('2026-11-10T12:00:00Z');
  const ledger = openLedger(tempDir(), { now: () => new Date(time) });
  ledger.append({ requestId: 'req-1', ...ROUTE, state: 'submitting' });
  time += 59_000;
  assert.equal(ledger.openCall({ ...ROUTE, maxAgeMs: 60_000 }).requestId, 'req-1');
  time += 2_000;
  assert.equal(ledger.openCall({ ...ROUTE, maxAgeMs: 60_000 }), null);
});
