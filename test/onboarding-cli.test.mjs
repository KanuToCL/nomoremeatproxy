import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { openLedger } from '../src/ledger.mjs';

const CLI = fileURLToPath(new URL('../bin/nomeat.mjs', import.meta.url));
const ID = '11111111-1111-4111-8111-111111111111';
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nomeat-onboarding-'));
  const config = path.join(root, 'claude');
  const sessions = path.join(config, 'projects', 'fixture');
  mkdirSync(sessions, { recursive: true });
  writeFileSync(path.join(sessions, `${ID}.jsonl`), [
    { type: 'user', message: { content: 'question' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'answer'.repeat(1500) }, { type: 'tool_use', name: 'Read', input: {} }] } },
    { type: 'user', origin: { kind: 'task-notification' }, message: { content: 'background event' } },
  ].map(record => JSON.stringify(record)).join('\n'));
  const state = path.join(root, 'missing-state');
  const env = { ...process.env, NOMEAT_STATE_DIR: state, CLAUDE_CONFIG_DIR: config };
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', windowsHide: true, timeout: 10000 });
  return { root, state, env, run };
}

test('CLI help documents orientation, compact migration, budgets and restoration', () => {
  const { run } = fixture();
  const result = run('--help');
  assert.equal(result.status, 0);
  for (const word of ['orient', '--budget', '--cursor', '--tools', '--raw', '--clear', 'UTF-8']) assert.ok(result.stdout.includes(word));
});

test('CLI compact pages honor total bytes and --raw retains the old view with no state writes', () => {
  const { run, root } = fixture();
  const first = run('read', '--side', 'CLAUDE', '--thread', `local_${ID}`, '--turns', '1', '--budget', '2048');
  assert.equal(first.status, 0, first.stderr);
  assert.ok(Buffer.byteLength(first.stdout) <= 2048);
  const page = JSON.parse(first.stdout);
  assert.deepEqual(page.messages.map(item => item.kind), ['user', 'assistant']);
  assert.equal(page.omitted.filtered.synthetic.items, 1);
  const next = run('read', '--side', 'claude', '--thread', ID, '--budget', '2048', '--cursor', page.nextCursor);
  assert.equal(next.status, 0, next.stderr);
  assert.ok(Buffer.byteLength(next.stdout) <= 2048);
  assert.equal(JSON.parse(next.stdout).messages[0].offset, page.messages[1].text.length);
  const raw = JSON.parse(run('read', '--side', 'claude', '--thread', ID, '--turns', '2', '--raw').stdout);
  assert.equal(raw.turnsTotal, 2);
  assert.equal(raw.turns[0].items.at(-1).kind, 'tool');
  assert.equal(raw.turns[1].items[0].text, 'background event');
  assert.deepEqual(readdirSync(root), ['claude']);
});

test('CLI invalid compact and standing inputs fail as usage before any state is created', () => {
  const { run, root } = fixture();
  for (const args of [
    ['read', '--side', 'other', '--thread', ID],
    ['read', '--side', 'claude'],
    ['read', '--side', 'claude', '--thread', ID, '--budget', '2047'],
    ['read', '--side', 'claude', '--thread', ID, '--budget', 'Infinity'],
    ['read', '--side', 'claude', '--thread', ID, '--turns', '1.2'],
    ['read', '--side', 'claude', '--thread', ID, '--max-chars', '9007199254740992'],
    ['read', '--side', 'claude', '--thread', ID, '--cursor', 'e30'],
    ['read', '--side', 'claude', '--thread', ID, '--raw', '--budget', '2048'],
    ['read', '--side', 'claude', '--thread', ID, '--raw', '--tools'],
    ['standing', '--to', 'fable', '--from', 'astra', '--clear', '--thread', ID],
  ]) {
    const result = run(...args);
    assert.equal(result.status, 2, `${args.join(' ')}: ${result.stderr}`);
    assert.equal(result.stdout, '');
  }
  assert.deepEqual(readdirSync(root), ['claude']);
});

test('clearing an empty route retains state-folder context and delivery-not-tested feedback', () => {
  const { run, state } = fixture();
  const result = run('standing', '--to', 'fable', '--from', 'astra', '--clear');
  assert.equal(result.status, 0, result.stderr);
  const shown = JSON.parse(result.stdout);
  assert.equal(shown.threadId, null);
  assert.equal(shown.untilNamed, null);
  assert.equal(shown.stateDir, state);
  assert.match(shown.stateNote, /no standing or answered thread.*both sides must use the same one/);
  assert.equal(shown.note, 'routing configured; delivery not tested');
  assert.equal(shown.restore.environment.NOMEAT_STATE_DIR, state);
});

test('CLI orientation is non-mutating and standing feedback restoration works only in the fixture route', () => {
  const { run, state, env } = fixture();
  const project = path.resolve('fixture-project');
  const oriented = run('orient', '--from', 'astra', '--cwd', project);
  assert.equal(oriented.status, 0, oriented.stderr);
  assert.equal(JSON.parse(oriented.stdout).project, project);
  const ledger = openLedger(state);
  ledger.append({ project, from: 'astra', peer: 'fable', state: 'answered', threadId: 'fallback' });
  ledger.append({ project, from: 'fable', peer: 'astra', state: 'standing', threadId: 'incoming' });
  const beforeBytes = readFileSync(ledger.file);
  const before = ledger.entries();
  const changed = run('standing', '--to', 'fable', '--from', 'astra', '--cwd', project, '--thread', 'next');
  assert.equal(changed.status, 0, changed.stderr);
  const result = JSON.parse(changed.stdout);
  assert.equal(result.change, 'fallback -> next');
  assert.equal(result.note, 'routing configured; delivery not tested');
  assert.deepEqual(ledger.entries().slice(0, before.length), before);
  assert.equal(ledger.standingThread({ project, from: 'fable', peer: 'astra' }), 'incoming');
  assert.equal(result.restore.environment.NOMEAT_STATE_DIR, state);
  const otherState = path.join(state, 'wrong-ambient-state');
  const restored = spawnSync(result.restore.executable, result.restore.args, {
    env: { ...env, NOMEAT_STATE_DIR: otherState, ...result.restore.environment }, encoding: 'utf8', windowsHide: true, timeout: 10000,
  });
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(JSON.parse(restored.stdout).after.destination, 'fallback');
  assert.equal(ledger.standingThread({ project, from: 'astra', peer: 'fable' }), null);
  assert.deepEqual(readdirSync(state), ['ledger.jsonl']);
  const nativeShell = process.platform === 'win32'
    ? ['powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `$originalState = $env:NOMEAT_STATE_DIR; ${result.restore.command}; if ($env:NOMEAT_STATE_DIR -ne $originalState) { exit 91 }`]]
    : ['sh', ['-c', `originalState=$NOMEAT_STATE_DIR; ${result.restore.command}; test "$NOMEAT_STATE_DIR" = "$originalState"`]];
  const displayed = spawnSync(nativeShell[0], nativeShell[1], {
    env: { ...env, NOMEAT_STATE_DIR: otherState }, encoding: 'utf8', windowsHide: true, timeout: 10000,
  });
  assert.equal(displayed.status, 0, displayed.stderr);
  assert.equal(JSON.parse(displayed.stdout).after.destination, 'fallback');
  assert.deepEqual(readdirSync(state), ['ledger.jsonl']);
  assert.ok(readFileSync(ledger.file).subarray(0, beforeBytes.length).equals(beforeBytes));
  const afterBytes = readFileSync(ledger.file);
  assert.equal(run('orient', '--from', 'astra', '--cwd', project).status, 0);
  assert.ok(readFileSync(ledger.file).equals(afterBytes));
});
