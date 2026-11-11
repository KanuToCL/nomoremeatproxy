import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { callClaude, checkClaudeCanRun, lookupInChild } from '../src/adapters/claude.mjs';
import { callPeer } from '../src/call.mjs';
import { openLedger } from '../src/ledger.mjs';
import { canWrite } from '../src/writable.mjs';

const tempDir = () => mkdtempSync(path.join(os.tmpdir(), 'nomeat-precheck-'));
// Claude's folder in a throwaway directory, never the real one.
const ENV = Object.freeze({ CLAUDE_CONFIG_DIR: tempDir() });
const resolves = async () => true;
const noNetwork = async () => false;

// --- the checks ---

test('both checks pass when the folder is writable and the host resolves, and the host is the API by default', async () => {
  const looked = [];
  await checkClaudeCanRun({ env: ENV, resolve: async (host) => looked.push(host) });
  assert.deepEqual(looked, ['api.anthropic.com']);
});

test('the host of ANTHROPIC_BASE_URL is looked up when it is set, unless it is an address or localhost', async () => {
  const looked = [];
  const resolve = async (host) => looked.push(host);
  await checkClaudeCanRun({ env: { ...ENV, ANTHROPIC_BASE_URL: 'https://gateway.example:8443/v1' }, resolve });
  for (const url of ['http://localhost:8080', 'http://127.0.0.1:8080', 'http://[::1]:8080']) {
    await checkClaudeCanRun({ env: { ...ENV, ANTHROPIC_BASE_URL: url }, resolve });
  }
  assert.deepEqual(looked, ['gateway.example']);
});

test('a folder that cannot be written fails as not sent, before any lookup, naming CLAUDE_CONFIG_DIR and the two ways out', async () => {
  const looked = [];
  await assert.rejects(checkClaudeCanRun({ env: ENV, resolve: async (host) => looked.push(host), writable: () => false }), (error) => {
    assert.equal(error.notSent, true);
    assert.match(error.message, /not writable.*CLAUDE_CONFIG_DIR|CLAUDE_CONFIG_DIR.*not writable/);
    assert.match(error.message, /outside the sandbox/);
    assert.match(error.message, /listen/);
    return true;
  });
  assert.deepEqual(looked, []);
});

test('Claude\'s folder under a regular file is not writable', async () => {
  const file = path.join(tempDir(), 'a-file');
  writeFileSync(file, '');
  await assert.rejects(checkClaudeCanRun({ env: { CLAUDE_CONFIG_DIR: file }, resolve: resolves }), (error) => error.notSent === true);
});

test('a failed name lookup fails as not sent, saying there is no network', async () => {
  await assert.rejects(checkClaudeCanRun({ env: ENV, resolve: noNetwork }), (error) => error.notSent === true && /no network/.test(error.message) && /outside the sandbox/.test(error.message));
});

// --- the lookup in a child process ---

// Starts the real lookup child with another script, keeping its options and time limit.
const startScript = (script) => (file, args, options) => spawn(file, ['-e', script], options);

test('the system\'s own lookup in a child resolves a name the system knows', async () => {
  assert.equal(await lookupInChild('localhost', 10000), true);
});

test('a lookup child that exits non-zero or does not start means not looked up', async () => {
  assert.equal(await lookupInChild('localhost', 10000, startScript('process.exit(1)')), false);
  assert.equal(await lookupInChild('localhost', 10000, () => { throw new Error('spawn EPERM'); }), false);
  assert.equal(await lookupInChild('localhost', 10000, () => spawn(path.join(tempDir(), 'missing'))), false);
});

// The bridge side runs in a child of its own, whose lookup child never answers. It must not
// only fail at the limit but also exit at once: a lookup still running would keep it alive.
const NEVER_ANSWERS = `
import { spawn } from 'node:child_process';
import { checkClaudeCanRun, lookupInChild } from ${JSON.stringify(new URL('../src/adapters/claude.mjs', import.meta.url).href)};
const started = performance.now();
const slow = (file, args, options) => spawn(file, ['-e', 'setTimeout(() => {}, 60000)'], options);
process.on('exit', () => console.log('exited ' + Math.round(performance.now() - started)));
await checkClaudeCanRun({ env: { CLAUDE_CONFIG_DIR: process.argv[1] }, timeoutMs: 300, resolve: (host, ms) => lookupInChild(host, ms, slow) }).catch((error) => {
  console.log((error.notSent ? 'not sent ' : 'other ') + Math.round(performance.now() - started));
});
`;

test('a lookup that does not finish fails as not sent at the limit, and leaves nothing that keeps the process alive', () => {
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', NEVER_ANSWERS, tempDir()], { encoding: 'utf8', timeout: 20000 });
  const [failed, exited] = run.stdout.trim().split(/\r?\n/);
  assert.match(failed, /^not sent \d+$/);
  assert.match(exited, /^exited \d+$/);
  const [failedAt, exitedAt] = [failed, exited].map((line) => Number(line.split(' ').at(-1)));
  // Limit 300 ms; the margins allow for a slow test machine, far below the 60 s the child would run.
  assert.ok(failedAt >= 300 && failedAt < 3000, `failed at ${failedAt} ms`);
  assert.ok(exitedAt - failedAt < 200, `exited ${exitedAt - failedAt} ms after failing`);
});

test('with a proxy configured the lookup is skipped, but the folder is still checked', async () => {
  for (const name of ['HTTPS_PROXY', 'http_proxy', 'ALL_PROXY']) {
    await checkClaudeCanRun({ env: { ...ENV, [name]: 'http://proxy.example:3128' }, resolve: noNetwork });
    await assert.rejects(checkClaudeCanRun({ env: { ...ENV, [name]: 'http://proxy.example:3128' }, resolve: noNetwork, writable: () => false }), /not writable/);
  }
});

test('a folder that does not exist yet counts as writable when its parent is, and is not created', () => {
  const missing = path.join(tempDir(), 'not', 'yet');
  assert.equal(canWrite(missing), true);
  assert.equal(canWrite(path.dirname(missing)), true);
  assert.throws(() => writeFileSync(path.join(missing, 'x'), ''), { code: 'ENOENT' });
});

// --- callClaude ---

// A spawner that records each start and answers like `claude -p --output-format json`.
function fakeClaude() {
  const starts = [];
  const start = (file, args) => {
    starts.push({ file, args });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: () => {} };
    setImmediate(() => {
      child.stdout.emit('data', JSON.stringify({ type: 'result', result: 'pong', session_id: args.at(args.indexOf('--session-id') + 1) }));
      child.emit('close', 0);
    });
    return child;
  };
  return { starts, start };
}

const failing = () => checkClaudeCanRun({ env: ENV, resolve: noNetwork });
const passing = () => checkClaudeCanRun({ env: ENV, resolve: resolves });

test('when a check fails, nothing is started and no thread is announced', async () => {
  const fake = fakeClaude();
  const threads = [];
  await assert.rejects(callClaude({ message: 'ping', canRun: failing, start: fake.start, onThread: (id) => threads.push(id) }), (error) => error.notSent === true);
  assert.deepEqual(fake.starts, []);
  assert.deepEqual(threads, []);
});

test('when both checks pass, the command line is started and its answer returned', async () => {
  const fake = fakeClaude();
  const result = await callClaude({ message: 'ping', canRun: passing, start: fake.start });
  assert.equal(fake.starts.length, 1);
  assert.equal(fake.starts[0].file, 'claude');
  assert.equal(result.reply, 'pong');
});

test('a call that failed a check is recorded as not sent, so a retry with the same id is sent, not uncertain', async () => {
  const ledger = openLedger(tempDir());
  const fake = fakeClaude();
  const peer = { name: 'fable', vendor: 'claude' };
  const send = (canRun) =>
    callPeer({ peer, message: 'ping', from: 'astra', project: '/work/app', requestId: 'req-1' }, { ledger, adapters: { claude: (args) => callClaude({ ...args, canRun, start: fake.start }) } });
  await assert.rejects(send(failing), (error) => error.notSent === true);
  assert.equal(ledger.history('req-1').at(-1).sent, false);
  const retry = await send(passing);
  assert.equal(retry.state, 'answered');
  assert.equal(fake.starts.length, 1);
});
