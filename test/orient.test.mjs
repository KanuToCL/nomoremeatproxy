import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import { openLedger } from '../src/ledger.mjs';
import { mailboxKey } from '../src/mailbox.mjs';
import { orient, stateAccess } from '../src/orient.mjs';

const temp = () => mkdtempSync(path.join(os.tmpdir(), 'nomeat-orient-'));

test('orientation resolves the target project and creates no missing state or probe files', () => {
  const root = temp();
  const stateDir = path.join(root, 'missing', 'state');
  const result = orient({ cwd: './target-project', stateDir, from: 'astra' });
  assert.equal(result.project, path.resolve('./target-project'));
  assert.equal(result.state.location, stateDir);
  assert.equal(result.state.access.exists, false);
  assert.match(result.state.note, /Advisory.*no write attempted/);
  assert.deepEqual(readdirSync(root), []);
  assert.equal(result.routes.length, 6);
  assert.equal(result.routes.filter(route => route.role === 'incoming').length, 3);
  assert.match(result.nextSteps.caller, /target-project/);
  assert.match(result.nextSteps.caller, /find --side claude/);
  assert.match(result.nextSteps.listener, /Codex callers do not run listen/);
  assert.match(result.listenerNote, /not tested/);
});

test('custom callers remain visible on incoming routes and get honest unknown-side guidance', () => {
  const stateDir = temp();
  const project = path.resolve('target-project');
  const ledger = openLedger(stateDir);
  ledger.append({ project, from: 'custom-caller', peer: 'astra', state: 'standing', threadId: 'custom-return' });
  const incoming = orient({ cwd: project, stateDir, from: 'astra' }).routes.find(route => route.from === 'custom-caller');
  assert.equal(incoming.standing, 'custom-return');
  assert.equal(incoming.role, 'incoming');
  const custom = orient({ cwd: project, stateDir, from: 'custom-caller' });
  assert.equal(custom.routes.find(route => route.peer === 'astra').standing, 'custom-return');
  assert.match(custom.nextSteps.listener, /Caller side unknown/);
  assert.match(orient({ cwd: project, stateDir, from: 'fable' }).nextSteps.listener, /As a Claude peer/);
});

test('orientation shows exact incoming/outgoing routes and excludes unrelated project/caller routes', () => {
  const stateDir = temp();
  const project = path.resolve('target-project');
  const ledger = openLedger(stateDir);
  ledger.append({ project, from: 'astra', peer: 'fable', state: 'standing', threadId: 'outbound' });
  ledger.append({ project, from: 'fable', peer: 'astra', state: 'standing', threadId: 'return-workbench' });
  ledger.append({ project: path.resolve('elsewhere'), from: 'fable', peer: 'astra', state: 'standing', threadId: 'other-project' });
  ledger.append({ project, from: 'irrelevant-caller', peer: 'opus', state: 'standing', threadId: 'unrelated' });
  const result = orient({ cwd: project, stateDir, from: 'astra' });
  assert.equal(result.routes.find(route => route.peer === 'fable' && route.role === 'outgoing').standing, 'outbound');
  assert.equal(result.routes.find(route => route.from === 'fable' && route.role === 'incoming').standing, 'return-workbench');
  assert.equal(JSON.stringify(result).includes('unrelated'), false);
  assert.equal(JSON.stringify(result).includes('other-project'), false);
});

test('orientation reports heartbeat registration only, without starting or refreshing a listener', () => {
  const stateDir = temp();
  const project = path.resolve('project');
  const dir = path.join(stateDir, 'inbox', 'listeners');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${mailboxKey({ project, peer: 'fable' })}.json`), JSON.stringify({ session: 'chat', at: Date.now() }));
  writeFileSync(path.join(dir, `${mailboxKey({ project, peer: 'opus' })}.json`), JSON.stringify({ session: 'old', at: 0 }));
  const before = readdirSync(dir);
  const result = orient({ cwd: project, stateDir });
  assert.deepEqual(result.listeners, [{ peer: 'fable', registration: { session: 'chat' } }, { peer: 'opus', registration: null }]);
  assert.deepEqual(readdirSync(dir), before);
});

test('advisory state access distinguishes a file from a directory; read-only ledger refuses mutation', () => {
  const dir = temp();
  const file = path.join(dir, 'file');
  writeFileSync(file, 'untouched');
  assert.equal(stateAccess(file).writable, false);
  const ledger = openLedger(path.join(dir, 'missing'), { readOnly: true });
  assert.deepEqual(ledger.entries(), []);
  assert.throws(() => ledger.append({ state: 'standing' }), /read-only/);
  assert.deepEqual(readdirSync(dir), ['file']);
});

test('a denied read-only ledger is an error, not an empty route table or a write probe', (t) => {
  const dir = temp();
  t.mock.method(fs, 'existsSync', () => false);
  t.mock.method(fs, 'readFileSync', () => { throw Object.assign(new Error('fixture denied'), { code: 'EACCES' }); });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.throws(() => orient({ stateDir: dir }), { code: 'EACCES' });
  assert.deepEqual(readdirSync(dir), []);
});
