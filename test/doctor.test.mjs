import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { inspectPrerequisites, nodeVersionCheck } from '../src/doctor.mjs';

// The minimum this package declares, read the same way the check reads it.
const NODE_MINIMUM = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).engines.node.replace('>=', '').trim();

// Session stores and the state folder are looked for in an empty folder, never the real ones.
const empty = mkdtempSync(path.join(os.tmpdir(), 'nomeat-doctor-'));
process.env.CODEX_HOME = empty;
process.env.CLAUDE_CONFIG_DIR = empty;
process.env.NOMEAT_STATE_DIR = empty;

const IDENTITY = 'someone@example.com';
// A healthy machine. Each test overrides the commands it is about.
const HEALTHY = Object.freeze({
  'codex --version': { ok: true, out: 'codex-cli 0.167.1' },
  'codex login status': { ok: true, out: `Logged in using ChatGPT (${IDENTITY})` },
  'codex queue --help': { ok: true, out: '--thread <THREAD> --message <TEXT> --resume' },
  'codex exec resume --help': { ok: true, out: 'Usage: codex exec resume [SESSION_ID]' },
  'claude --version': { ok: true, out: '2.1.322 (Claude Code)' },
  'claude auth status --json': { ok: true, out: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: IDENTITY, orgName: 'Org' }) },
  'claude --help': { ok: true, out: '-r, --resume [value]' },
});

const inspect = (overrides = {}) => {
  const outputs = { ...HEALTHY, ...overrides };
  return inspectPrerequisites({ capture: (file) => outputs[file] ?? { ok: false, out: '' } });
};
const byId = (result, id) => result.checks.find((c) => c.id === id);

test('every check has the agreed shape and a stable id', () => {
  const result = inspect();
  assert.deepEqual(result.checks.map((c) => c.id), [
    'codex-cli', 'codex-auth', 'codex-queue-thread', 'codex-exec-resume', 'codex-sessions',
    'claude-cli', 'claude-auth', 'claude-resume', 'claude-sessions',
    'codex-app', 'claude-app', 'chatgpt-app', 'chrome', 'edge', 'node', 'state-folder', 'git', 'github-cli', 'tailscale', 'wsl',
  ]);
  for (const c of result.checks) {
    assert.deepEqual(Object.keys(c).sort(), ['id', 'note', 'required', 'status', 'version']);
    assert.ok(['found', 'missing', 'unknown', 'warning'].includes(c.status));
    assert.equal(typeof c.note, 'string');
  }
  assert.deepEqual(result.checks.filter((c) => c.required).map((c) => c.id), ['codex-cli', 'codex-auth', 'claude-cli', 'claude-auth', 'node', 'state-folder']);
});

test('a machine with both command lines installed and signed in is ok', () => {
  const result = inspect();
  assert.equal(result.ok, true);
  assert.deepEqual(byId(result, 'codex-cli'), { id: 'codex-cli', required: true, status: 'found', version: '0.167.1', note: '' });
});

test('a missing required command line makes the result not ok', () => {
  const result = inspect({ 'codex --version': { ok: false, out: '' } });
  assert.equal(byId(result, 'codex-cli').status, 'missing');
  assert.equal(result.ok, false);
});

test('sign-in is reduced to signed in or not, and no identity or raw output is returned', () => {
  const signedIn = inspect();
  assert.deepEqual([byId(signedIn, 'codex-auth').status, byId(signedIn, 'claude-auth').status], ['found', 'found']);
  assert.deepEqual([byId(signedIn, 'codex-auth').note, byId(signedIn, 'claude-auth').note], ['signed in with the subscription', 'signed in with the subscription']);
  assert.ok(!JSON.stringify(signedIn).includes(IDENTITY));
  const signedOut = inspect({
    'codex login status': { ok: false, out: 'Not logged in' },
    'claude auth status --json': { ok: false, out: JSON.stringify({ loggedIn: false }) },
  });
  assert.deepEqual([byId(signedOut, 'codex-auth').status, byId(signedOut, 'claude-auth').status], ['missing', 'missing']);
  assert.equal(signedOut.ok, false);
});

test('a Claude CLI older than the minimum for claude-fable-5-2 is a warning naming that model, not a failure', () => {
  const old = inspect({ 'claude --version': { ok: true, out: '2.1.283 (Claude Code)' } });
  const cli = byId(old, 'claude-cli');
  assert.equal(cli.status, 'warning');
  assert.equal(cli.version, '2.1.283');
  assert.match(cli.note, /2\.1\.290.*claude-fable-5-2/);
  assert.equal(old.ok, true);
  // The minimum itself, and newer, are fine: comparison is numeric, so 2.1.1000 is newer.
  for (const out of ['2.1.290 (Claude Code)', '2.1.1000 (Claude Code)']) {
    assert.equal(byId(inspect({ 'claude --version': { ok: true, out } }), 'claude-cli').status, 'found');
  }
});

test('a sign-in through an API key or a third party is a warning about paid credentials, with no key or account shown', () => {
  const key = 'sk-proj-abc123';
  const cases = [
    ['codex-auth', { 'codex login status': { ok: true, out: `Logged in using an API key - ${key}` } }],
    ['claude-auth', { 'claude auth status --json': { ok: true, out: JSON.stringify({ loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty', email: IDENTITY }) } }],
    ['claude-auth', { 'claude auth status --json': { ok: true, out: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'bedrock', orgName: IDENTITY }) } }],
  ];
  for (const [id, overrides] of cases) {
    const result = inspect(overrides);
    assert.equal(byId(result, id).status, 'warning');
    assert.match(byId(result, id).note, /paid API credentials/);
    assert.ok(!JSON.stringify(result).includes(key) && !JSON.stringify(result).includes(IDENTITY));
  }
});

test('a sign-in status that cannot be read is unknown, not missing', () => {
  const unreadable = [
    { 'codex login status': { ok: false, out: '' }, 'claude auth status --json': { ok: true, out: 'Usage: claude [options]' } },
    // Signed in by a method not recognised: neither subscription nor paid API can be told.
    { 'codex login status': { ok: true, out: 'Logged in using something new' }, 'claude auth status --json': { ok: true, out: JSON.stringify({ loggedIn: true, authMethod: 'other', apiProvider: 'firstParty' }) } },
  ];
  for (const overrides of unreadable) {
    const result = inspect(overrides);
    assert.deepEqual([byId(result, 'codex-auth').status, byId(result, 'claude-auth').status], ['unknown', 'unknown']);
    assert.equal(result.ok, true);
  }
});

test('Node below the minimum in package.json is missing, with the version found and the minimum named', () => {
  const below = nodeVersionCheck('0.1.0');
  assert.deepEqual(below, { status: 'missing', version: '0.1.0', note: `older than ${NODE_MINIMUM}, the minimum this package declares` });
});

test('Node at or above the minimum in package.json is found', () => {
  const above = `${Number(NODE_MINIMUM.split('.')[0]) + 1}.0.0`;
  for (const version of [NODE_MINIMUM, above]) assert.deepEqual(nodeVersionCheck(version), { status: 'found', version, note: '' });
});

test('the node row uses the running Node against that minimum', () => {
  assert.deepEqual(byId(inspect(), 'node'), { id: 'node', required: true, ...nodeVersionCheck(process.versions.node) });
});

// --- state folder ---

const withStateDir = (t, dir) => {
  t.after(() => (process.env.NOMEAT_STATE_DIR = empty));
  process.env.NOMEAT_STATE_DIR = dir;
  return byId(inspect(), 'state-folder');
};

test('a writable state folder is found', (t) => {
  assert.deepEqual(withStateDir(t, mkdtempSync(path.join(os.tmpdir(), 'nomeat-state-'))), { id: 'state-folder', required: true, status: 'found', version: null, note: '' });
});

test('a state folder that does not exist but can be created is found, and is not created by the check', (t) => {
  const dir = path.join(mkdtempSync(path.join(os.tmpdir(), 'nomeat-state-')), 'not', 'yet');
  assert.equal(withStateDir(t, dir).status, 'found');
  assert.equal(existsSync(dir), false);
});

test('a state folder that cannot be created is missing, names NOMEAT_STATE_DIR and not the path, and makes the result not ok', (t) => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'nomeat-state-')), 'a-file');
  writeFileSync(file, '');
  const dir = path.join(file, 'state');
  const row = withStateDir(t, dir);
  assert.equal(row.status, 'missing');
  assert.match(row.note, /NOMEAT_STATE_DIR/);
  assert.ok(!row.note.includes(path.dirname(file)));
  assert.equal(inspect().ok, false);
});

// Windows ignores a folder's read-only mode, and root ignores modes everywhere.
test('an existing state folder that is not writable is missing', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nomeat-state-'));
  mkdirSync(path.join(dir, 'locked'));
  chmodSync(path.join(dir, 'locked'), 0o555);
  t.after(() => chmodSync(path.join(dir, 'locked'), 0o755));
  assert.equal(withStateDir(t, path.join(dir, 'locked')).status, 'missing');
});
