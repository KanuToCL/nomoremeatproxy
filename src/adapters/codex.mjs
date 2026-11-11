// Codex adapter for calls. Threads are created through `codex app-server`, so they are listed
// in the Codex desktop app; threads from `codex exec` are not. A thread the app holds open
// accepts only one writer, so messages for it go through Codex's queue and the app runs them.
// Sections: turn state (pure) / direct turn / queued turn / callCodex.
import { setTimeout as sleep } from 'node:timers/promises';
import { codexBaseline, codexUsage } from '../usage.mjs';
import { runCodexCli } from './codex-cli.mjs';
import { DAEMON_NOT_STARTED, ensureDaemon } from './codex-daemon.mjs';
import { SERVER_STILL_RUNNING, withCodexServer } from './codex-transport.mjs';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_MS = 3000;
const ACTIVE_WRITER = /already has an active writer/;

const notSent = (message) => Object.assign(new Error(message), { notSent: true });

// --- turn state (pure) ---

export const newTurnState = () => ({ threadId: null, turnId: null, replies: [], done: false, status: null, error: null, usageBefore: null, usageNow: null });

// One server reports every thread it runs, a helper agent's threads included. An event names its
// thread (`threadId`) and turn (`turnId`, or `turn.id` on turn/completed); it counts only when
// those match this call's. The turn id is known once turn/start answers, so an event of this
// thread that comes before that is still taken. An event that names neither counts, as before.
function ownEvent(state, params) {
  const turnId = params.turnId ?? params.turn?.id;
  if (params.threadId == null && turnId == null) return true;
  if (params.threadId != null && params.threadId !== state.threadId) return false;
  return turnId == null || state.turnId == null || turnId === state.turnId;
}

export function foldTurnEvent(state, method, params) {
  if (!ownEvent(state, params)) return state;
  if (method === 'item/completed' && params.item?.type === 'agentMessage') {
    return { ...state, replies: [...state.replies, params.item] };
  }
  if (method === 'thread/tokenUsage/updated' && params.tokenUsage?.total) {
    return { ...state, usageBefore: state.usageBefore ?? codexBaseline(params.tokenUsage), usageNow: params.tokenUsage.total };
  }
  if (method === 'turn/completed') {
    const turn = params.turn ?? {};
    return { ...state, done: true, status: turn.status ?? 'completed', error: turn.error?.message ?? null };
  }
  return state;
}

const endTurn = (state, status, error) => (state.done ? state : { ...state, done: true, status, error });

// A turn's answer, from its agent messages in order. Codex marks interim status lines with the
// phase `commentary`, and answer text with `final_answer` or, by its schema, `partial_answer`
// (not seen so far). Where no message is marked as answer, as in a turn that did not finish or
// from a model that sets no phase, the last message stands.
const ANSWER = new Set(['final_answer', 'partial_answer']);

export function turnAnswer(messages) {
  const answer = messages.filter((message) => ANSWER.has(message.phase));
  return (answer.length ? answer : messages.slice(-1)).map((message) => message.text).join('\n\n');
}

const carries = (item, marker) =>
  item.type === 'userMessage' && (item.content ?? []).some((part) => part.type === 'text' && part.text.includes(marker));

// The turn that carries this request's marker, or null when the thread does not have it yet.
// Read from outside, a turn the app is still running reports `interrupted`, so only
// `completed` and `failed` are final.
export function findRequestTurn(turns, marker) {
  const turn = turns.findLast((candidate) => (candidate.items ?? []).some((item) => carries(item, marker)));
  if (!turn) return null;
  const reply = turnAnswer(turn.items.filter((item) => item.type === 'agentMessage'));
  return { status: turn.status, reply, error: turn.error?.message ?? null };
}

async function readTurns(client, threadId) {
  const { thread } = await client.request('thread/read', { threadId, includeTurns: true });
  return thread.turns ?? [];
}

async function readRequestTurn(client, { threadId, marker }) {
  return findRequestTurn(await readTurns(client, threadId), marker);
}

// For a retry after an uncertain delivery: the reply, if the thread already holds a finished one.
export async function recoverCodexReply({ threadId, marker }) {
  if (!threadId) return null;
  const turn = await withCodexServer((client) => readRequestTurn(client, { threadId, marker }));
  return turn?.status === 'completed' ? { reply: turn.reply } : null;
}

// Where a request stands in its thread, for following up on a message sent without waiting.
// A request not in the thread yet is `waiting`. `idle` is true only when the thread's newest
// turn is seen finished, so nothing is running there; without turns nothing is seen.
export function describeRequestTurn(turns, marker) {
  const turn = findRequestTurn(turns, marker);
  if (!turn) return { state: 'waiting', idle: ['completed', 'failed'].includes(turns.at(-1)?.status) };
  if (turn.status === 'completed') return { state: 'answered', reply: turn.reply };
  if (turn.status === 'failed') return { state: 'failed', error: turn.error };
  return { state: 'running' };
}

export async function checkCodexRequest({ threadId, marker }) {
  return describeRequestTurn(await withCodexServer((client) => readTurns(client, threadId)), marker);
}

// --- direct turn ---

// Without a model (null or undefined) none is sent, so Codex applies its own default.
export const modelParam = (model) => (model == null ? {} : { model });

// A new thread gets the bridge's policy and a title. An existing thread keeps its own
// settings, which may belong to a thread the owner uses in the app; only `write` changes them.
async function openThread(client, { threadId, title, model, write, cwd }) {
  if (threadId) {
    const resumed = await client.request('thread/resume', { threadId, ...(write ? { sandbox: 'workspace-write' } : {}) });
    return resumed.thread.id;
  }
  const policy = { cwd, ...modelParam(model), sandbox: write ? 'workspace-write' : 'read-only', approvalPolicy: 'never' };
  const started = await client.request('thread/start', policy);
  // The title is cosmetic; a refusal must not fail the call.
  if (title) await client.request('thread/name/set', { threadId: started.thread.id, name: title }).catch(() => {});
  return started.thread.id;
}

// What a direct turn applied. A resumed thread keeps the access it had unless `write` raised it.
export const appliedSettings = ({ threadId, write, effort }) => ({
  ...(write ? { access: 'write' } : threadId ? {} : { access: 'read-only' }),
  ...(effort ? { effort } : {}),
});

async function runTurn({ threadId, message, title, model, effort, write, cwd, onThread, timeoutMs, withServer }) {
  let turn = newTurnState();
  let settle;
  const finished = new Promise((resolve) => {
    settle = resolve;
  });
  const finish = (next) => {
    turn = next;
    if (turn.done) settle();
  };
  const timer = setTimeout(() => finish(endTurn(turn, 'timed-out', `no completed turn within ${timeoutMs} ms`)), timeoutMs);
  let stillRunning = false;
  try {
    const result = await withServer(
      async (client) => {
        const id = await openThread(client, { threadId, title, model, write, cwd }).catch((error) => {
          // Nothing has been sent yet, so a retry cannot duplicate anything.
          error.notSent = true;
          throw error;
        });
        turn = { ...turn, threadId: id };
        onThread(id);
        const started = await client.request('turn/start', {
          threadId: id,
          input: [{ type: 'text', text: message }],
          ...modelParam(model),
          ...(effort ? { effort } : {}),
        });
        turn = { ...turn, turnId: started?.turn?.id ?? null };
        await finished;
        if (turn.status !== 'completed') {
          throw new Error(`Codex turn ${turn.status}: ${turn.error ?? 'no detail'} (thread ${id})`);
        }
        const usage = codexUsage(turn.usageBefore, turn.usageNow);
        return { threadId: id, reply: turnAnswer(turn.replies), delivery: 'direct', ...appliedSettings({ threadId, write, effort }), ...(usage ? { usage } : {}) };
      },
      {
        onNotification: (method, params) => finish(foldTurnEvent(turn, method, params)),
        onClosed: (error) => finish(endTurn(turn, 'failed', error.message)),
        onStillRunning: () => (stillRunning = true),
      },
    );
    // The answer stands; the server may still hold the thread.
    return stillRunning ? { ...result, warning: SERVER_STILL_RUNNING } : result;
  } finally {
    clearTimeout(timer);
  }
}

// --- queued turn ---

// Whether `codex queue` offers `--resume`, asked once per runner: once per process for the real one.
const resumeOffered = new WeakMap();
function offersResume(runCli) {
  if (!resumeOffered.has(runCli)) {
    resumeOffered.set(runCli, runCli(['queue', '--help']).then(({ stdout = '' } = {}) => /--resume\b/.test(stdout), () => false));
  }
  return resumeOffered.get(runCli);
}

// Hands the message to Codex's queue, exactly once. A queued message is only stored; `--resume`
// asks the local daemon to load the chat and run its queue. A failed resume warns on stderr
// but succeeds, so the delivery stands and the warning goes back to the caller. Codex also
// prints routine warnings on stderr (seen: one about PATH aliases), so only lines that mention
// resuming count. Limit: the wording of a failed resume was not seen; one that does not
// mention resuming is missed.
const resumeWarning = (stderr) => stderr.split(/\r?\n/).filter((line) => /resum/i.test(line)).join('\n').trim();

// A failure of the queue command counts as not sent only when it never ran (`notStarted`).
// Otherwise the message may already be queued, for example when a resume hangs past the time
// limit, so the error is left as possibly delivered and a retry of the request does not queue again.
async function queueMessage({ threadId, message, runCli }) {
  const resume = (await offersResume(runCli)) ? ['--resume'] : [];
  const ran = await runCli(['queue', '--thread', threadId, '--message', message, ...resume]).catch((error) => {
    error.notSent = error.notStarted === true;
    throw error;
  });
  const { stderr = '' } = ran ?? {};
  const warning = resume.length ? resumeWarning(stderr) : '';
  return warning ? { warning } : {};
}

// The app that holds the thread runs the turn with the thread's own model and settings, so the
// daemon is not started here. Seen live: Codex warns that it could not resume such a thread
// although the app runs it, so the warning is left out of an answer and kept when none arrives.
async function runQueuedTurn({ threadId, message, marker, onThread, timeoutMs, runCli, withServer }) {
  const warned = await queueMessage({ threadId, message, runCli });
  onThread(threadId);
  const deadline = Date.now() + timeoutMs;
  return withServer(async (client) => {
    while (Date.now() < deadline) {
      const turn = await readRequestTurn(client, { threadId, marker });
      if (turn?.status === 'completed') return { threadId, reply: turn.reply, delivery: 'queued' };
      if (turn?.status === 'failed') throw new Error(`Codex turn failed: ${turn.error ?? 'no detail'} (thread ${threadId})`);
      await sleep(POLL_MS);
    }
    const warning = warned.warning ? `; codex warned: ${warned.warning}` : '';
    throw new Error(`the message is queued for thread ${threadId} but no finished reply appeared within ${timeoutMs} ms; it has not finished, cause unknown${warning}`);
  });
}

// --- callCodex ---

// The app runs a queued message with the thread's own access, which `write` cannot raise.
function refuseQueuedWrite({ write, threadAccess }) {
  if (write && threadAccess !== 'write') {
    throw notSent(
      "the Codex app holds this thread and runs queued messages with the thread's own access, which the bridge did not set to write; send without --write if that chat already has write access in the app, or start a thread with --new --write",
    );
  }
}

// Hands the message to Codex's queue and returns, without knowing when it will run. Nothing may
// have the chat loaded, so Codex's daemon is started first. Without `--resume` nothing asks the
// daemon to run the message, so it is left alone and the message is queued as before.
async function queueOnly({ threadId, message, onThread, write, threadAccess, runCli }) {
  if (!threadId) throw notSent('sending without waiting needs an existing Codex thread; name it with --thread or call once with waiting first');
  refuseQueuedWrite({ write, threadAccess });
  const daemonUp = (await offersResume(runCli)) ? await ensureDaemon(runCli) : true;
  const { warning = '' } = await queueMessage({ threadId, message, runCli });
  onThread(threadId);
  // Seen live: for a chat the app holds, Codex warns that the thread already has an active
  // writer, and the app runs the message. That line is left out; any other is passed back.
  const codexWarning = warning.split('\n').filter((line) => !ACTIVE_WRITER.test(line)).join('\n');
  if (daemonUp) return { threadId, delivery: 'queued', ...(codexWarning ? { warning: codexWarning } : {}) };
  const codexLine = codexWarning ? `; codex warned: ${codexWarning}` : '';
  return { threadId, delivery: 'queued', warning: `${DAEMON_NOT_STARTED}${codexLine}` };
}

// `threadAccess` is what the ledger recorded for the thread, or null when unknown.
export async function callCodex({ threadId, message, marker, title, model, effort, write = false, threadAccess = null, cwd = process.cwd(), onThread = () => {}, timeoutMs = DEFAULT_TIMEOUT_MS, noWait = false, runCli = runCodexCli, withServer = withCodexServer }) {
  if (noWait) return queueOnly({ threadId, message, onThread, write, threadAccess, runCli });
  try {
    return await runTurn({ threadId, message, title, model, effort, write, cwd, onThread, timeoutMs, withServer });
  } catch (error) {
    if (!threadId || !ACTIVE_WRITER.test(error.message)) throw error;
    refuseQueuedWrite({ write, threadAccess });
    return runQueuedTurn({ threadId, message, marker, onThread, timeoutMs, runCli, withServer });
  }
}
