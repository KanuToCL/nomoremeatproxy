// Starting Codex's daemon before a message is queued. Every test fakes the command line and,
// where a waiting call is needed, the app server: nothing reaches a real Codex.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { callCodex } from '../src/adapters/codex.mjs';
import { DAEMON_NOT_STARTED } from '../src/adapters/codex-daemon.mjs';
import { callPeer } from '../src/call.mjs';
import { openLedger } from '../src/ledger.mjs';

// The command list as Codex CLI 0.166.0 prints it, shortened.
const DAEMON_HELP = `Commands:
  bootstrap               Install durable local app-server management for SSH-driven use
  start                   Start the local app server daemon if it is not already running
  restart                 Restart the local app server daemon
  stop                    Stop the local app server daemon
  version                 Print local CLI and running app-server versions as JSON
`;
// Seen live when no daemon runs (the socket path is shortened).
const NOT_RUNNING = () => Promise.reject(new Error('codex app-server failed: failed to connect to app-server-control.sock'));
// Seen live from a running daemon (shortened).
const RUNNING = async () => ({ stdout: '{"status":"running","backend":"pid"}', stderr: '' });
const STARTED = async () => ({ stdout: '{"status":"started"}', stderr: '' });
const RESUME_FAILED = 'message was queued, but could not resume thread t-1: start a local daemon or specify a server with --remote';
const ALLOWED = new Set(['--help', 'version', 'start']);

function fakeCodex({ daemonHelp = async () => ({ stdout: DAEMON_HELP, stderr: '' }), version = RUNNING, start = STARTED, queue = async () => ({ stdout: '', stderr: '' }) } = {}) {
  const runs = [];
  const runCli = async (args, { timeoutMs } = {}) => {
    const name = args[0] === 'queue' ? (args[1] === '--help' ? 'queue --help' : 'queue') : `daemon ${args[2]}`;
    runs.push({ name, timeoutMs });
    if (name === 'queue --help') return { stdout: '--thread <THREAD> --message <TEXT> --resume', stderr: '' };
    if (name === 'queue') return queue();
    if (name === 'daemon --help') return daemonHelp();
    if (name === 'daemon version') return version();
    if (name === 'daemon start') return start();
    return { stdout: '', stderr: '' };
  };
  return { runCli, names: () => runs.map((run) => run.name), timeout: (name) => runs.find((run) => run.name === name)?.timeoutMs };
}
const send = (cli) => callCodex({ threadId: 't-1', message: 'hi', noWait: true, runCli: cli.runCli });

test('a running daemon is not started again, and the message is queued once', async () => {
  const cli = fakeCodex();
  assert.deepEqual(await send(cli), { threadId: 't-1', delivery: 'queued' });
  assert.deepEqual(cli.names(), ['queue --help', 'daemon --help', 'daemon version', 'queue']);
});

test('a daemon that is not running is started within a time limit before the message is queued', async () => {
  const cli = fakeCodex({ version: NOT_RUNNING });
  assert.deepEqual(await send(cli), { threadId: 't-1', delivery: 'queued' });
  assert.deepEqual(cli.names(), ['queue --help', 'daemon --help', 'daemon version', 'daemon start', 'queue']);
  assert.ok(cli.timeout('daemon version') > 0);
  assert.ok(cli.timeout('daemon start') > 0);
});

test('a version answer that is not JSON, or not status running, counts as not running', async () => {
  for (const stdout of ['no daemon', '{"status":"stopped"}', '{}']) {
    const cli = fakeCodex({ version: async () => ({ stdout, stderr: '' }) });
    await send(cli);
    assert.ok(cli.names().includes('daemon start'));
  }
});

test('a resume warning about an active writer is left out, since the app runs that chat; another is kept', async () => {
  const appHeld = 'Warning: message was queued, but could not resume thread t-1: thread/resume failed: thread t-1 already has an active writer (code -32600)';
  const held = fakeCodex({ queue: async () => ({ stdout: '', stderr: `${appHeld}\n` }) });
  assert.deepEqual(await send(held), { threadId: 't-1', delivery: 'queued' });
  const other = fakeCodex({ queue: async () => ({ stdout: '', stderr: `${RESUME_FAILED}\n` }) });
  assert.deepEqual(await send(other), { threadId: 't-1', delivery: 'queued', warning: RESUME_FAILED });
});

test('a failed daemon start still queues the message once and says it may not run', async () => {
  const cli = fakeCodex({ version: NOT_RUNNING, start: () => Promise.reject(new Error('codex app-server failed: could not launch')) });
  assert.deepEqual(await send(cli), { threadId: 't-1', delivery: 'queued', warning: DAEMON_NOT_STARTED });
  assert.equal(cli.names().filter((name) => name === 'queue').length, 1);
});

test('a daemon start past its time limit is reported like a failed one, followed by Codex line', async () => {
  // runCodexCli kills a command past its limit and rejects with an error that is not `notStarted`.
  const timedOut = () => Promise.reject(Object.assign(new Error('codex app-server failed: Command failed'), { notStarted: false }));
  const cli = fakeCodex({ version: NOT_RUNNING, start: timedOut, queue: async () => ({ stdout: '', stderr: `${RESUME_FAILED}\n` }) });
  const result = await send(cli);
  assert.equal(result.warning, `${DAEMON_NOT_STARTED}; codex warned: ${RESUME_FAILED}`);
  assert.equal(cli.names().filter((name) => name === 'queue').length, 1);
});

test('without daemon start and version commands the message is queued as before, with the warning, and asked once', async () => {
  const cli = fakeCodex({ daemonHelp: async () => ({ stdout: 'Commands:\n  restart  Restart\n  stop  Stop\n', stderr: '' }) });
  assert.deepEqual(await send(cli), { threadId: 't-1', delivery: 'queued', warning: DAEMON_NOT_STARTED });
  await send(cli);
  assert.deepEqual(cli.names(), ['queue --help', 'daemon --help', 'queue', 'queue']);
  const failingHelp = fakeCodex({ daemonHelp: () => Promise.reject(new Error('codex app-server failed: unrecognized subcommand')) });
  assert.equal((await send(failingHelp)).warning, DAEMON_NOT_STARTED);
});

test('a daemon another sender started first counts as started', async () => {
  const cli = fakeCodex({ version: NOT_RUNNING, start: () => Promise.reject(new Error('codex app-server failed: daemon is already running')) });
  assert.deepEqual(await send(cli), { threadId: 't-1', delivery: 'queued' });
});

test('a failed start after which the daemon answers counts as started', async () => {
  let asked = 0;
  const upOnSecondAsk = () => (++asked === 1 ? NOT_RUNNING() : RUNNING());
  const cli = fakeCodex({ version: upOnSecondAsk, start: () => Promise.reject(new Error('codex app-server failed: lock is held')) });
  assert.deepEqual(await send(cli), { threadId: 't-1', delivery: 'queued' });
  assert.deepEqual(cli.names(), ['queue --help', 'daemon --help', 'daemon version', 'daemon start', 'daemon version', 'queue']);
});

// A waiting call into a thread the app holds: the direct turn is refused, so it is queued.
const turn = { status: 'completed', items: [{ type: 'userMessage', content: [{ type: 'text', text: '[request r-1;] hi' }] }, { type: 'agentMessage', text: 'done' }] };
const appHolds = (turns) => async (work) =>
  work({
    request: async (method) => {
      if (method === 'thread/resume') throw new Error('Codex rejected the request: thread t-1 already has an active writer');
      if (method === 'thread/read') return { thread: { turns } };
      throw new Error(`unexpected ${method}`);
    },
  });
const waitFor = (cli, turns, timeoutMs) => callCodex({ threadId: 't-1', message: '[request r-1;] hi', marker: 'request r-1;', runCli: cli.runCli, withServer: appHolds(turns), timeoutMs });

test('a waiting call queued into a chat the app holds never starts the daemon, and its answer carries no resume warning', async () => {
  const cli = fakeCodex({ version: NOT_RUNNING, queue: async () => ({ stdout: '', stderr: `${RESUME_FAILED}\n` }) });
  assert.deepEqual(await waitFor(cli, [turn], 60_000), { threadId: 't-1', reply: 'done', delivery: 'queued' });
  assert.deepEqual(cli.names(), ['queue --help', 'queue']);
});

test('a waiting call with no reply in time keeps the resume warning in its error', async () => {
  const cli = fakeCodex({ queue: async () => ({ stdout: '', stderr: `${RESUME_FAILED}\n` }) });
  await assert.rejects(waitFor(cli, [], 0), (error) => error.message.includes(`codex warned: ${RESUME_FAILED}`));
  assert.ok(!cli.names().some((name) => name.startsWith('daemon')));
});

test('only daemon help, version and start are ever issued', async () => {
  const fail = () => Promise.reject(new Error('codex app-server failed'));
  const scenarios = [{}, { version: NOT_RUNNING }, { version: NOT_RUNNING, start: fail }, { daemonHelp: fail }];
  for (const scenario of scenarios) {
    const cli = fakeCodex(scenario);
    await send(cli);
    await waitFor(cli, [turn], 60_000);
    const daemonCommands = cli.names().filter((name) => name.startsWith('daemon ')).map((name) => name.slice('daemon '.length));
    assert.deepEqual(daemonCommands.filter((command) => !ALLOWED.has(command)), []);
  }
});

// --- through the bridge's ledger ---

const PEER = Object.freeze({ name: 'sol', vendor: 'codex', model: 'gpt-6-sol' });
const viaBridge = (ledger, cli) =>
  callPeer(
    { peer: PEER, message: 'ping', from: 'fable', project: '/work/app', requestId: 'req-1', threadId: 'thread-open', noWait: true },
    { ledger, adapters: { codex: (args) => callCodex({ ...args, runCli: cli.runCli }) } },
  );
const queues = (cli) => cli.names().filter((name) => name === 'queue').length;
const startFails = () => Promise.reject(new Error('codex app-server failed: could not launch'));

test('a failed daemon start is not a delivery: the message is queued once and a retry does not queue it again', async () => {
  const ledger = openLedger(mkdtempSync(path.join(os.tmpdir(), 'nomeat-daemon-')));
  const cli = fakeCodex({ version: NOT_RUNNING, start: startFails });
  const first = await viaBridge(ledger, cli);
  assert.equal(first.state, 'sent');
  assert.equal(first.warning, DAEMON_NOT_STARTED);
  assert.equal((await viaBridge(ledger, cli)).state, 'duplicate');
  assert.equal(queues(cli), 1);
});

test('a failed daemon start before a queue command that never started leaves it not sent, and a retry queues once', async () => {
  const ledger = openLedger(mkdtempSync(path.join(os.tmpdir(), 'nomeat-daemon-')));
  const neverStarted = () => Promise.reject(Object.assign(new Error('spawn codex ENOENT'), { notStarted: true }));
  const cli = fakeCodex({ version: NOT_RUNNING, start: startFails, queue: neverStarted });
  await assert.rejects(viaBridge(ledger, cli), (error) => error.notSent === true);
  assert.equal(queues(cli), 1);
  await assert.rejects(viaBridge(ledger, cli), (error) => error.notSent === true);
  assert.equal(queues(cli), 2);
});
