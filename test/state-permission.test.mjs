import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { callPeer } from '../src/call.mjs';
import { openLedger } from '../src/ledger.mjs';
import { openMailbox } from '../src/mailbox.mjs';
import { remoteStore } from '../src/remote-control-store.mjs';
import { STATE_NOT_WRITABLE, writeState } from '../src/writable.mjs';

// A read-only file refuses writes on Windows (EPERM) and elsewhere (EACCES), except for root.
const ASROOT = { skip: process.getuid?.() === 0 };
const SESSION = '00000000-0000-4000-8000-000000000003';

function readOnlyFile(t, dir, name, content = '') {
  const file = path.join(dir, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  chmodSync(file, 0o444);
  t.after(() => chmodSync(file, 0o666));
  return file;
}

// The fixed wording, which names the variable and never the folder.
const refused = (dir) => (error) => error.message === STATE_NOT_WRITABLE && /NOMEAT_STATE_DIR/.test(error.message) && !error.message.includes(dir) && Boolean(error.cause?.code);
// A call that fails before anything is sent says so after the fixed wording.
const NOT_SENT = `${STATE_NOT_WRITABLE}; nothing was sent`;

test('a ledger write refused for lack of permission gives the fixed wording, with the system error as its cause', ASROOT, (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nomeat-state-'));
  readOnlyFile(t, dir, 'ledger.jsonl');
  assert.throws(() => openLedger(dir).append({ state: 'submitting' }), refused(dir));
});

test('a call whose ledger cannot be written is not sent, and the peer is never contacted', ASROOT, async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nomeat-state-'));
  readOnlyFile(t, dir, 'ledger.jsonl');
  const contacted = [];
  const request = { peer: { name: 'fable', vendor: 'claude' }, message: 'ping', from: 'astra', project: '/work/app', requestId: 'req-1' };
  await assert.rejects(callPeer(request, { ledger: openLedger(dir), adapters: { claude: async (args) => contacted.push(args) } }), (error) => error.message === NOT_SENT && !error.message.includes(dir) && Boolean(error.cause?.code) && error.notSent === true);
  assert.deepEqual(contacted, []);
});

test('a mailbox write refused for lack of permission gives the fixed wording', ASROOT, (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nomeat-state-'));
  // The mailbox writes each file under a temporary name first; that name is made read-only.
  readOnlyFile(t, dir, path.join('inbox', 'requests', `req-1.json.${process.pid}.tmp`));
  const post = () => openMailbox(dir).post({ project: '/work/app', peer: 'fable', requestId: 'req-1', from: 'astra', hop: 1, maxHops: 4, message: 'ping' });
  assert.throws(post, refused(dir));
});

test('a Remote Control store that cannot be written gives the fixed wording', ASROOT, (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nomeat-state-'));
  remoteStore(dir).bind('box', SESSION);
  chmodSync(path.join(dir, 'remote-control.sqlite'), 0o444);
  t.after(() => chmodSync(path.join(dir, 'remote-control.sqlite'), 0o666));
  assert.throws(() => remoteStore(dir).enqueue(SESSION), (error) => error.message === STATE_NOT_WRITABLE && error.cause?.code === 'ERR_SQLITE_ERROR');
});

// A path under a file: it does not exist and cannot be created, on any system and as root.
function uncreatable() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nomeat-state-'));
  writeFileSync(path.join(dir, 'a-file'), '');
  return path.join(dir, 'a-file', 'state');
}

test('an ENOENT for a folder that cannot be created gives the fixed wording', () => {
  const dir = uncreatable();
  // What a recursive mkdir reports for a missing folder on a read-only file system.
  const enoent = Object.assign(new Error(`ENOENT: no such file or directory, mkdir '${dir}'`), { code: 'ENOENT', path: dir });
  assert.throws(() => writeState(() => { throw enoent; }), (error) => refused(dir)(error) && error.cause === enoent);
});

test('an ENOENT that is not a refusal passes unchanged', () => {
  const missing = path.join(mkdtempSync(path.join(os.tmpdir(), 'nomeat-state-')), 'missing.json');
  assert.throws(() => writeState(() => readFileSync(missing)), (error) => error.code === 'ENOENT' && error.path === missing);
});

test('a ledger write under a read-only folder that has no state folder yet gives the fixed wording', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, (t) => {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'nomeat-state-'));
  chmodSync(parent, 0o555);
  t.after(() => chmodSync(parent, 0o755));
  const dir = path.join(parent, 'missing', 'state');
  assert.throws(() => openLedger(dir).append({ state: 'submitting' }), refused(dir));
});

test('a call whose ledger cannot be read is not sent, and the peer is never contacted', async () => {
  const contacted = [];
  const request = { peer: { name: 'fable', vendor: 'claude' }, message: 'ping', from: 'astra', project: '/work/app', requestId: 'req-1' };
  const call = callPeer(request, { ledger: openLedger(uncreatable()), adapters: { claude: async (args) => contacted.push(args) } });
  await assert.rejects(call, (error) => error.message === NOT_SENT && error.notSent === true);
  assert.deepEqual(contacted, []);
});

test('a refusal while recording the answer comes after the peer was contacted and is not marked not sent', async () => {
  const ledger = openLedger(mkdtempSync(path.join(os.tmpdir(), 'nomeat-state-')));
  const append = ledger.append;
  ledger.append = (event) => {
    if (event.state === 'answered') throw new Error(STATE_NOT_WRITABLE);
    return append(event);
  };
  const request = { peer: { name: 'fable', vendor: 'claude' }, message: 'ping', from: 'astra', project: '/work/app', requestId: 'req-1' };
  const call = callPeer(request, { ledger, adapters: { claude: async () => ({ threadId: 'thread-1', reply: 'pong' }) } });
  await assert.rejects(call, (error) => error.message === STATE_NOT_WRITABLE && error.notSent !== true);
});

test('a ledger read that fails before sending writes no submitting entry, so a retry reaches the peer', async () => {
  const ledger = openLedger(mkdtempSync(path.join(os.tmpdir(), 'nomeat-state-')));
  const threadAccess = ledger.threadAccess;
  let failures = 1;
  ledger.threadAccess = (id) => {
    if (failures-- > 0) throw new Error(STATE_NOT_WRITABLE);
    return threadAccess(id);
  };
  const contacted = [];
  const request = { peer: { name: 'fable', vendor: 'claude' }, message: 'ping', from: 'astra', project: '/work/app', requestId: 'req-1', threadId: 'thread-1' };
  const adapters = { claude: async (args) => (contacted.push(args), { threadId: 'thread-1', reply: 'pong' }) };
  await assert.rejects(callPeer(request, { ledger, adapters }), (error) => error.message === NOT_SENT && error.notSent === true);
  assert.deepEqual(ledger.history('req-1'), []);
  assert.equal((await callPeer(request, { ledger, adapters })).state, 'answered');
  assert.equal(contacted.length, 1);
});

test('a refusal while recovering an earlier attempt, which may have been delivered, is not marked not sent', async () => {
  const ledger = openLedger(mkdtempSync(path.join(os.tmpdir(), 'nomeat-state-')));
  ledger.append({ requestId: 'req-1', state: 'submitting' });
  ledger.append({ requestId: 'req-1', state: 'thread', threadId: 'thread-7' });
  ledger.append = () => {
    throw new Error(STATE_NOT_WRITABLE);
  };
  const request = { peer: { name: 'fable', vendor: 'claude' }, message: 'ping', from: 'astra', project: '/work/app', requestId: 'req-1' };
  const recoverers = { claude: async () => ({ reply: 'pong' }) };
  const call = callPeer(request, { ledger, recoverers, adapters: { claude: async () => assert.fail('the peer is not called again') } });
  await assert.rejects(call, (error) => error.message === STATE_NOT_WRITABLE && error.notSent !== true);
});

test('reading a state folder that does not exist and cannot be created gives the fixed wording', () => {
  const dir = uncreatable();
  const fixed = (error) => error.message === STATE_NOT_WRITABLE;
  assert.throws(() => openLedger(dir).entries(), fixed);
  assert.throws(() => remoteStore(dir).status(), fixed);
});

test('reading on a first run gives an empty state and creates nothing', () => {
  const dir = path.join(mkdtempSync(path.join(os.tmpdir(), 'nomeat-state-')), 'state');
  const route = { project: '/work/app', from: 'astra', peer: 'fable' };
  assert.equal(openLedger(dir).standingThread(route), null);
  assert.deepEqual(remoteStore(dir).status(), { enabled: false, counts: {} });
  assert.equal(existsSync(dir), false);
});

test('an error that is not about permission passes unchanged', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nomeat-state-'));
  remoteStore(dir).bind('box', SESSION);
  assert.throws(() => remoteStore(dir).bind('other-box', SESSION), /A different coordinator is bound/);
});
