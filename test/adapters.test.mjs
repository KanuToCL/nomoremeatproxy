import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { buildClaudeArgs, openInClaudeApp, parseClaudeResult } from '../src/adapters/claude.mjs';
import { resolveCodexCommand } from '../src/adapters/codex-cli.mjs';
import { appliedSettings, callCodex, findRequestTurn, foldTurnEvent, modelParam, newTurnState, turnAnswer } from '../src/adapters/codex.mjs';
import { resolvePeer } from '../src/peers.mjs';

const SESSION = '00000000-0000-4000-8000-000000000001';

// --- Claude arguments ---

test('a new Claude session is given its id up front', () => {
  const args = buildClaudeArgs({ sessionId: SESSION, resume: false, model: 'claude-opus-5-5' });
  assert.deepEqual(args, ['-p', '--output-format', 'json', '--model', 'claude-opus-5-5', '--tools', 'Read,Grep,Glob', '--session-id', SESSION]);
});

test('a call without write access gets only the reading tools; with write access the full set', () => {
  const readOnly = buildClaudeArgs({ sessionId: SESSION, resume: true, model: 'm' });
  assert.deepEqual(readOnly.slice(readOnly.indexOf('--tools'), readOnly.indexOf('--tools') + 2), ['--tools', 'Read,Grep,Glob']);
  // The tool list must be followed by another flag, never by the end of the arguments.
  assert.equal(readOnly[readOnly.indexOf('--tools') + 2], '--resume');
  assert.ok(!buildClaudeArgs({ sessionId: SESSION, resume: true, model: 'm', write: true }).includes('--tools'));
});

test('continuing a Claude session resumes it by id', () => {
  const args = buildClaudeArgs({ sessionId: SESSION, resume: true, model: 'claude-opus-5-5' });
  assert.deepEqual(args.slice(-2), ['--resume', SESSION]);
  assert.ok(!args.includes('--session-id'));
});

test('effort and write access map to their flags', () => {
  const args = buildClaudeArgs({ sessionId: SESSION, resume: false, model: 'm', effort: 'max', write: true });
  assert.deepEqual(args.slice(args.indexOf('--effort'), args.indexOf('--effort') + 2), ['--effort', 'max']);
  assert.deepEqual(args.slice(-2), ['--permission-mode', 'acceptEdits']);
});

test('a new Claude session is named; a continued one keeps its name', () => {
  const fresh = buildClaudeArgs({ sessionId: SESSION, resume: false, model: 'm', title: 'astra to fable: Review' });
  assert.deepEqual(fresh.slice(fresh.indexOf('--name'), fresh.indexOf('--name') + 2), ['--name', 'astra to fable: Review']);
  assert.ok(!buildClaudeArgs({ sessionId: SESSION, resume: true, model: 'm', title: 'ignored' }).includes('--name'));
});

test('a Claude call without a model passes no --model, so the vendor default applies', () => {
  for (const model of [undefined, null]) {
    const args = buildClaudeArgs({ sessionId: SESSION, resume: false, model });
    assert.ok(!args.includes('--model'));
    assert.ok(!args.some((arg) => /undefined|null/.test(arg)));
  }
  assert.throws(() => buildClaudeArgs({ sessionId: SESSION, resume: false, model: '' }), /invalid model/);
});

test('a session id that is not a UUID is rejected', () => {
  assert.throws(() => buildClaudeArgs({ sessionId: 'latest', resume: true, model: 'm' }), /invalid Claude session id/);
});

test('a model containing shell metacharacters is rejected', () => {
  assert.throws(() => buildClaudeArgs({ sessionId: SESSION, resume: false, model: 'm; rm -rf .' }), /invalid model/);
});

// A stand-in for spawn: records what would be started, then fails to start, exits with `code`
// (0 by default), or, with `code: 'never'`, keeps running. A kill then reports `killWorks` and,
// when it works and `exitOnKill` holds, the child exits.
function fakeStart({ error, code = 0, killWorks = true, exitOnKill = true } = {}) {
  const starts = [];
  const start = (file, args, options) => {
    const child = Object.assign(new EventEmitter(), { killTried: false, unrefed: false, unref: () => (child.unrefed = true) });
    child.kill = () => {
      child.killTried = true;
      if (killWorks && exitOnKill) process.nextTick(() => child.emit('exit', null, 'SIGTERM'));
      return killWorks;
    };
    starts.push({ file, args, options, child });
    process.nextTick(() => {
      if (error) return child.emit('error', error);
      child.emit('spawn');
      if (code !== 'never') child.emit('exit', code, null);
    });
    return child;
  };
  return { starts, start };
}

test('opening in the app refuses an id that is not a UUID', () => {
  assert.throws(() => openInClaudeApp('x & calc', { platform: 'win32' }), /invalid Claude session id/);
});

test('on a platform the vendor offers no opener for, nothing is attempted and the result says it is not supported', async () => {
  const fake = fakeStart();
  const result = await openInClaudeApp(SESSION, { platform: 'linux', start: fake.start });
  assert.deepEqual(result, { opened: false, supported: false, reason: 'the vendor offers no opener for the Claude app on this platform, so nothing was attempted' });
  assert.deepEqual(fake.starts, []);
});

test('on Windows the opener still runs in a minimised console of its own and counts on exit 0', async () => {
  const fake = fakeStart();
  assert.deepEqual(await openInClaudeApp(SESSION, { platform: 'win32', cwd: 'C:\\work', start: fake.start }), { opened: true });
  const [{ file, args, options }] = fake.starts;
  assert.equal(file, 'cmd.exe');
  assert.deepEqual(args, ['/c', 'start', '/min', 'claude', '--desktop', '--resume', SESSION]);
  assert.deepEqual(options, { cwd: 'C:\\work', detached: true, stdio: 'ignore' });
});

test('on macOS the opener runs under a pseudo-terminal with no window, in the call folder, and counts on exit 0', async () => {
  const fake = fakeStart();
  assert.deepEqual(await openInClaudeApp(SESSION, { platform: 'darwin', cwd: '/work', start: fake.start }), { opened: true });
  const [{ file, args, options }] = fake.starts;
  assert.deepEqual([file, ...args], ['script', '-q', '/dev/null', 'claude', '--desktop', '--resume', SESSION]);
  assert.deepEqual(options, { cwd: '/work', detached: true, stdio: 'ignore' });
});

test('on macOS the old NOMEAT_CLAUDE_OPENER switch is no longer read', async (t) => {
  const saved = process.env.NOMEAT_CLAUDE_OPENER;
  t.after(() => (saved === undefined ? delete process.env.NOMEAT_CLAUDE_OPENER : (process.env.NOMEAT_CLAUDE_OPENER = saved)));
  process.env.NOMEAT_CLAUDE_OPENER = 'direct';
  const fake = fakeStart();
  await openInClaudeApp(SESSION, { platform: 'darwin', start: fake.start });
  assert.equal(fake.starts[0].file, 'script');
});

test('an opener that exits with another code is not opened, and the reason names the code', async () => {
  const result = await openInClaudeApp(SESSION, { platform: 'darwin', start: fakeStart({ code: 1 }).start });
  assert.deepEqual(result, { opened: false, reason: 'the opener exited with code 1' });
});

const ENDED = 'the opener did not exit within 0.02 seconds; a stop signal was sent';
const NOT_ENDED = 'the opener did not exit within 0.02 seconds and could not be stopped';

test('at the time limit an opener whose kill works is reported signalled, not opened, and released', async () => {
  const fake = fakeStart({ code: 'never' });
  const result = await openInClaudeApp(SESSION, { platform: 'darwin', start: fake.start, timeoutMs: 20 });
  assert.deepEqual(result, { opened: false, reason: ENDED });
  assert.equal(fake.starts[0].child.killTried, true);
  assert.equal(fake.starts[0].child.unrefed, true);
});

test('at the time limit an opener whose kill fails is reported as not stopped, and still released', async () => {
  const fake = fakeStart({ code: 'never', killWorks: false });
  const result = await openInClaudeApp(SESSION, { platform: 'darwin', start: fake.start, timeoutMs: 20 });
  assert.deepEqual(result, { opened: false, reason: NOT_ENDED });
  assert.equal(fake.starts[0].child.killTried, true);
  assert.equal(fake.starts[0].child.unrefed, true);
});

test('at the time limit the answer does not wait for an exit that never comes', async () => {
  const fake = fakeStart({ code: 'never', exitOnKill: false });
  const result = await openInClaudeApp(SESSION, { platform: 'darwin', start: fake.start, timeoutMs: 20 });
  assert.deepEqual(result, { opened: false, reason: ENDED });
  assert.equal(fake.starts[0].child.unrefed, true);
});

test('an opener that cannot start is reported with a reason, not thrown', async () => {
  const missing = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
  const result = await openInClaudeApp(SESSION, { platform: 'darwin', start: fakeStart({ error: missing }).start });
  assert.deepEqual(result, { opened: false, reason: 'the opener did not start: spawn claude ENOENT' });
  const thrown = await openInClaudeApp(SESSION, { platform: 'darwin', start: () => { throw new Error('bad'); } });
  assert.equal(thrown.opened, false);
});

// --- Claude results ---

test('a result object yields the session id and reply', () => {
  const stdout = JSON.stringify({ type: 'result', is_error: false, session_id: SESSION, result: 'ACK' });
  assert.deepEqual(parseClaudeResult(stdout), { threadId: SESSION, reply: 'ACK' });
});

test('an event array yields its last result entry', () => {
  const stdout = JSON.stringify([{ type: 'system' }, { type: 'result', session_id: SESSION, result: 'first' }, { type: 'result', session_id: SESSION, result: 'last' }]);
  assert.equal(parseClaudeResult(stdout).reply, 'last');
});

test('an error result throws and names the session', () => {
  const stdout = JSON.stringify({ type: 'result', is_error: true, session_id: SESSION, result: 'limit reached' });
  assert.throws(() => parseClaudeResult(stdout), new RegExp(`limit reached.*${SESSION}`));
});

test('output that is not JSON throws', () => {
  assert.throws(() => parseClaudeResult('Not logged in'), /not JSON/);
});

// --- Codex turn events ---

test('agent messages accumulate in order', () => {
  let state = newTurnState();
  state = foldTurnEvent(state, 'item/completed', { item: { type: 'agentMessage', text: 'one' } });
  state = foldTurnEvent(state, 'item/completed', { item: { type: 'reasoning', text: 'hidden' } });
  state = foldTurnEvent(state, 'item/completed', { item: { type: 'agentMessage', text: 'two' } });
  assert.deepEqual(state.replies.map((message) => message.text), ['one', 'two']);
  assert.equal(state.done, false);
});

// --- the answer of a turn ---

const said = (text, phase) => ({ type: 'agentMessage', text, ...(phase ? { phase } : {}) });

test("a turn's answer leaves out the interim status lines Codex marks as commentary", () => {
  const messages = [said('looking at the files', 'commentary'), said('running the tests', 'commentary'), said('all pass', 'final_answer')];
  assert.equal(turnAnswer(messages), 'all pass');
});

test("a turn's answer joins every message marked final, in order", () => {
  // Seen in Codex's own records: a few turns hold two final answers, with commentary between.
  assert.equal(turnAnswer([said('first', 'final_answer'), said('more', 'commentary'), said('second', 'final_answer')]), 'first\n\nsecond');
  // Codex's schema calls `partial_answer` answer text that more output may follow.
  assert.equal(turnAnswer([said('part', 'partial_answer'), said('checking', 'commentary'), said('rest', 'final_answer')]), 'part\n\nrest');
});

test("without a message marked final, a turn's answer is its last message, or empty", () => {
  assert.equal(turnAnswer([said('one'), said('two')]), 'two');
  assert.equal(turnAnswer([said('still looking', 'commentary')]), 'still looking');
  assert.equal(turnAnswer([]), '');
});

test('turn/completed ends the turn with its status', () => {
  const state = foldTurnEvent(newTurnState(), 'turn/completed', { turn: { status: 'completed' } });
  assert.deepEqual({ done: state.done, status: state.status, error: state.error }, { done: true, status: 'completed', error: null });
});

test('a failed turn carries the error message', () => {
  const state = foldTurnEvent(newTurnState(), 'turn/completed', { turn: { status: 'failed', error: { message: 'usage limit' } } });
  assert.equal(state.status, 'failed');
  assert.equal(state.error, 'usage limit');
});

test('unrelated notifications leave the state unchanged', () => {
  const state = newTurnState();
  assert.equal(foldTurnEvent(state, 'thread/started', {}), state);
});

// Seen live: a peer that started a helper agent had its call end on the helper's turn.
const MINE = Object.freeze({ ...newTurnState(), threadId: 't-main', turnId: 'turn-1' });
const usageReport = (total) => ({ total: { totalTokens: total }, last: { totalTokens: 10 } });

test("a helper thread's message, usage and turn end leave the call's turn unchanged", () => {
  const helper = { threadId: 't-helper', turnId: 'turn-h' };
  let state = foldTurnEvent(MINE, 'item/completed', { ...helper, item: { type: 'agentMessage', text: 'helper report' } });
  state = foldTurnEvent(state, 'thread/tokenUsage/updated', { ...helper, tokenUsage: usageReport(500) });
  state = foldTurnEvent(state, 'turn/completed', { threadId: 't-helper', turn: { id: 'turn-h', status: 'completed' } });
  assert.equal(state, MINE);
});

test("another turn of the call's own thread is ignored once the call's turn is known", () => {
  const state = foldTurnEvent(MINE, 'turn/completed', { threadId: 't-main', turn: { id: 'turn-0', status: 'completed' } });
  assert.equal(state, MINE);
});

test("the call's own events still add the reply and the usage and end the turn", () => {
  const own = { threadId: 't-main', turnId: 'turn-1' };
  let state = foldTurnEvent(MINE, 'item/completed', { ...own, item: { type: 'agentMessage', text: 'mine' } });
  state = foldTurnEvent(state, 'thread/tokenUsage/updated', { ...own, tokenUsage: usageReport(100) });
  state = foldTurnEvent(state, 'turn/completed', { threadId: 't-main', turn: { id: 'turn-1', status: 'completed' } });
  assert.deepEqual(state.replies.map((message) => message.text), ['mine']);
  assert.equal(state.usageNow.totalTokens, 100);
  assert.equal(state.done, true);
});

test("before turn/start answers, an event of the call's thread is taken and one of another thread is not", () => {
  const waiting = { ...newTurnState(), threadId: 't-main' };
  const message = (threadId) => ({ threadId, turnId: 'turn-1', item: { type: 'agentMessage', text: threadId } });
  assert.equal(foldTurnEvent(waiting, 'item/completed', message('t-helper')), waiting);
  assert.equal(foldTurnEvent(waiting, 'item/completed', message('t-main')).replies.length, 1);
});

test('a waiting call returns its own answer when a helper thread finishes first', async () => {
  const requests = [];
  const withServer = async (work, { onNotification }) => {
    const replies = { 'thread/start': { thread: { id: 't-main' } }, 'turn/start': { turn: { id: 'turn-1' } } };
    const client = {
      request: async (method, params) => {
        requests.push(method);
        if (method === 'turn/start') {
          setImmediate(() => {
            onNotification('item/completed', { threadId: 't-helper', turnId: 'turn-h', item: { type: 'agentMessage', text: 'helper report' } });
            onNotification('turn/completed', { threadId: 't-helper', turn: { id: 'turn-h', status: 'completed' } });
            onNotification('item/completed', { threadId: 't-main', turnId: 'turn-1', item: said('reading the plan', 'commentary') });
            onNotification('item/completed', { threadId: 't-main', turnId: 'turn-1', item: said('the answer', 'final_answer') });
            onNotification('turn/completed', { threadId: 't-main', turn: { id: 'turn-1', status: 'completed' } });
          });
        }
        return replies[method] ?? {};
      },
    };
    return work(client);
  };
  const result = await callCodex({ message: 'hi', title: 'x', cwd: '/work', withServer, timeoutMs: 5000 });
  assert.equal(result.reply, 'the answer');
  assert.deepEqual(requests, ['thread/start', 'thread/name/set', 'turn/start']);
});

// --- Codex queued turns ---

const turnWith = (text, status, replies = []) => ({
  status,
  items: [{ type: 'userMessage', content: [{ type: 'text', text }] }, ...replies.map((reply) => ({ type: 'agentMessage', text: reply }))],
});

test('the turn carrying the request marker yields its status and its last message as the reply', () => {
  const turns = [turnWith('[request other;] hi', 'completed', ['no']), turnWith('[request r-1;] hi', 'completed', ['status line', 'answer'])];
  assert.deepEqual(findRequestTurn(turns, 'request r-1;'), { status: 'completed', reply: 'answer', error: null });
});

test('a queued or checked turn gives only the message Codex marked final', () => {
  const turn = turnWith('[request r-1;] hi', 'completed');
  turn.items.push(said('working', 'commentary'), said('done at 4848f92', 'final_answer'));
  assert.equal(findRequestTurn([turn], 'request r-1;').reply, 'done at 4848f92');
});

test('a thread without the marker has no request turn', () => {
  assert.equal(findRequestTurn([turnWith('[request other;] hi', 'completed', ['x'])], 'request r-1;'), null);
});

test('a turn the app is still running is reported with its non-final status', () => {
  // Seen live: read from outside, a running turn says `interrupted` until it completes.
  assert.equal(findRequestTurn([turnWith('[request r-1;] hi', 'interrupted', ['partial'])], 'request r-1;').status, 'interrupted');
});

test('a failed turn carrying the marker reports its error', () => {
  const failed = { ...turnWith('[request r-1;] hi', 'failed'), error: { message: 'usage limit' } };
  assert.deepEqual(findRequestTurn([failed], 'request r-1;'), { status: 'failed', reply: '', error: 'usage limit' });
});

test('a Codex thread or turn without a model sends no model field', () => {
  assert.deepEqual(modelParam(undefined), {});
  assert.deepEqual(modelParam(null), {});
  assert.deepEqual(modelParam('gpt-6-astra'), { model: 'gpt-6-astra' });
});

// --- what a Codex call could do ---

test('a new Codex thread reports the access it was created with', () => {
  assert.deepEqual(appliedSettings({ write: false }), { access: 'read-only' });
  assert.deepEqual(appliedSettings({ write: true }), { access: 'write' });
});

test('a resumed Codex thread reports write only when the call raised it, else nothing', () => {
  assert.deepEqual(appliedSettings({ threadId: 't-1', write: true }), { access: 'write' });
  assert.deepEqual(appliedSettings({ threadId: 't-1', write: false }), {});
});

test('a direct Codex turn reports the thinking level only when one was applied', () => {
  assert.equal(appliedSettings({ write: false, effort: 'ultra' }).effort, 'ultra');
  assert.equal(Object.hasOwn(appliedSettings({ write: false }), 'effort'), false);
});

// Every test here sends without waiting and fakes the CLI: nothing reaches a real Codex.
// `help` is what `codex queue --help` prints; `stderr` what queueing prints there. Codex's
// daemon is offered and running; test/codex-daemon.test.mjs covers the other cases.
const DAEMON_HELP = 'Commands:\n  start    Start the daemon\n  version  Print versions as JSON\n';
function fakeCli({ help = '--thread <THREAD> --message <TEXT>', stderr = '' } = {}) {
  const runs = [];
  const runCli = async (args) => {
    runs.push(args);
    if (args[0] === 'app-server') return { stdout: args[2] === '--help' ? DAEMON_HELP : '{"status":"running"}', stderr: '' };
    return args[1] === '--help' ? { stdout: help, stderr: '' } : { stdout: '', stderr };
  };
  return { runs, runCli, queued: () => runs.filter((args) => args[0] === 'queue' && args[1] !== '--help') };
}
const queuedWrite = (threadAccess, cli) => callCodex({ threadId: 't-1', message: 'edit it', write: true, threadAccess, noWait: true, runCli: cli.runCli });
const queueInto = (cli) => callCodex({ threadId: 't-1', message: 'hi', noWait: true, runCli: cli.runCli });

test('a write queued into a read-only or unknown thread is refused before anything is queued', async () => {
  for (const threadAccess of ['read-only', null]) {
    const cli = fakeCli();
    await assert.rejects(queuedWrite(threadAccess, cli), (error) => error.notSent === true && /--new --write/.test(error.message));
    assert.deepEqual(cli.runs, []);
  }
});

test('a write queued into a thread created with write is queued, and reports no access or level', async () => {
  const cli = fakeCli();
  const result = await queuedWrite('write', cli);
  assert.deepEqual(result, { threadId: 't-1', delivery: 'queued' });
  assert.deepEqual(cli.queued(), [['queue', '--thread', 't-1', '--message', 'edit it']]);
});

test('a command line that offers --resume is asked to load the chat, and asked whether it can only once', async () => {
  const cli = fakeCli({ help: '--thread <THREAD> --message <TEXT> --resume' });
  assert.deepEqual(await queueInto(cli), { threadId: 't-1', delivery: 'queued' });
  await queueInto(cli);
  assert.deepEqual(cli.runs.filter((args) => args[0] === 'queue'), [
    ['queue', '--help'],
    ['queue', '--thread', 't-1', '--message', 'hi', '--resume'],
    ['queue', '--thread', 't-1', '--message', 'hi', '--resume'],
  ]);
});

test('a command line without --resume queues exactly as before', async () => {
  const cli = fakeCli();
  await queueInto(cli);
  assert.deepEqual(cli.queued(), [['queue', '--thread', 't-1', '--message', 'hi']]);
});

test('a failed resume keeps the delivery, returns its warning and queues nothing twice', async () => {
  const cli = fakeCli({ help: '--resume', stderr: 'warning: could not resume the thread on the local daemon\n' });
  const result = await queueInto(cli);
  assert.deepEqual(result, { threadId: 't-1', delivery: 'queued', warning: 'warning: could not resume the thread on the local daemon' });
  assert.equal(cli.queued().length, 1);
});

test('a routine Codex warning on stderr is not reported; only lines about the resume are', async () => {
  const routine = 'WARNING: proceeding, even though we could not create PATH aliases';
  assert.deepEqual(await queueInto(fakeCli({ help: '--resume', stderr: `${routine}\n` })), { threadId: 't-1', delivery: 'queued' });
  const mixed = await queueInto(fakeCli({ help: '--resume', stderr: `${routine}\nwarning: failed to resume thread t-1\n` }));
  assert.equal(mixed.warning, 'warning: failed to resume thread t-1');
  // Without --resume nothing on stderr can be about a resume.
  assert.equal(Object.hasOwn(await queueInto(fakeCli({ stderr: 'warning: failed to resume' })), 'warning'), false);
});

test('a help command that fails means no --resume, not a failed send', async () => {
  const runs = [];
  const runCli = async (args) => {
    runs.push(args);
    if (args[1] === '--help') throw new Error('codex queue failed');
    return { stdout: '', stderr: '' };
  };
  await callCodex({ threadId: 't-1', message: 'hi', noWait: true, runCli });
  assert.deepEqual(runs.at(-1), ['queue', '--thread', 't-1', '--message', 'hi']);
});

// --- running Codex without a shell ---

test('outside Windows the codex command is used as is', () => {
  assert.deepEqual(resolveCodexCommand({ platform: 'linux' }), { file: 'codex', prefix: [] });
});

test('on Windows a real executable is preferred', () => {
  const resolved = resolveCodexCommand({ platform: 'win32', where: () => ['C:\\npm\\codex.cmd', 'C:\\bin\\codex.exe'], exists: () => true });
  assert.deepEqual(resolved, { file: 'C:\\bin\\codex.exe', prefix: [] });
});

test('on Windows an npm shim resolves to its Node entry point, with Windows paths on any host', () => {
  // A literal, not a join: a resolver using the host's path rules gives './node_modules/...' on macOS.
  const entry = 'C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js';
  const resolved = resolveCodexCommand({ platform: 'win32', where: () => ['C:\\npm\\codex.cmd'], exists: (candidate) => candidate === entry, node: 'node.exe' });
  assert.deepEqual(resolved, { file: 'node.exe', prefix: [entry] });
});

test('on Windows a shim with no entry point is an error, not a shell fallback', () => {
  assert.throws(() => resolveCodexCommand({ platform: 'win32', where: () => ['C:\\npm\\codex.cmd'], exists: () => false }), /runs without a shell/);
});

// --- Peers ---

test('a peer name resolves to its vendor, default model and default thinking level, ignoring case', () => {
  assert.deepEqual(resolvePeer('Astra'), { name: 'astra', vendor: 'codex', model: 'gpt-6-astra', effort: 'ultra' });
  assert.equal(resolvePeer('opus').effort, 'high');
});

test('a thinking level given for the call replaces the default; a peer without one gets none', () => {
  assert.equal(resolvePeer('sol', { effort: 'low' }).effort, 'low');
  assert.equal(Object.hasOwn(resolvePeer('fable'), 'effort'), false);
  assert.equal(resolvePeer('fable', { effort: 'max' }).effort, 'max');
});

test('a model override replaces the default but keeps the vendor', () => {
  assert.deepEqual(resolvePeer('fable', { model: 'claude-haiku-5-5' }), { name: 'fable', vendor: 'claude', model: 'claude-haiku-5-5' });
});

test('an unknown peer lists the known ones', () => {
  assert.throws(() => resolvePeer('gemini'), /unknown peer "gemini"; known peers: astra, sol, fable, opus/);
});

test('inherited object properties are not peers', () => {
  assert.throws(() => resolvePeer('constructor'), /unknown peer/);
});
