// `doctor --live`: one real, read-only, one-word call per side through the bridge's own call
// path, each in a new thread, from a caller name that marks it as a check. Shows that the
// command line is found, that sign-in and the model work, and what opening in the app said.
// Tests inject `run`; only the command line makes real calls.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/nomeat.mjs', import.meta.url));
export const LIVE_CHECK_CALLER = 'doctor-check';
const MESSAGE = 'This is a check of the bridge, not a task. Reply with the single word: ok';
// One peer per side, with its default model and thinking level, since those are what calls use.
// fable is the peer whose model needs a recent Claude CLI.
export const LIVE_PEERS = Object.freeze([
  { side: 'codex', peer: 'astra', cli: 'codex-cli', auth: 'codex-auth' },
  { side: 'claude', peer: 'fable', cli: 'claude-cli', auth: 'claude-auth' },
]);
// One deadline per side, longer than the adapters' own ten-minute limit so they report first.
const DEADLINE_MS = 11 * 60 * 1000;

// Fixed wording only: vendor output and notes can carry an account identity.
const DETAIL = Object.freeze({
  notRun: 'not run: the command line or the subscription sign-in was not found',
  notOpened: 'answered, but the chat opener did not start',
  deadline: 'no answer before the deadline; the process tree was ended; delivery uncertain, not retried',
  cleanupFailed: 'no answer before the deadline; ending its processes did not succeed, some may still run; delivery uncertain, not retried',
  uncertain: 'uncertain: the request may have been delivered; not retried',
});

// Ends a process and every process it started, except those that left its tree or group on
// purpose, such as the detached chat opener. Windows: taskkill walks the tree by parent id, so
// it runs while the wrapper is still alive. Elsewhere: the wrapper leads its own process group.
// Bounded, and returns whether it succeeded; a group already gone counts as ended.
const CLEANUP_TIMEOUT_MS = 10000;
function endTree(pid) {
  if (process.platform === 'win32') {
    return spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: CLEANUP_TIMEOUT_MS }).status === 0;
  }
  try {
    process.kill(-pid, 'SIGKILL');
    return true;
  } catch (error) {
    return error.code === 'ESRCH';
  }
}

// Runs Node with `args` and resolves with its exit status and stdout. At the deadline the whole
// tree is ended and the promise settles at once, whether or not the process ever closes, with
// `timedOut` and `treeEnded`. Stderr is drained and dropped.
export function runWithDeadline(args, { deadlineMs = DEADLINE_MS, endTree: end = endTree } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
    let stdout = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.resume();
    const timer = setTimeout(() => {
      const treeEnded = end(child.pid);
      // A process that outlived its cleanup must not keep this one alive.
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      resolve({ status: null, stdout, timedOut: true, treeEnded });
    }, deadlineMs);
    const done = (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, timedOut: false });
    };
    child.once('error', () => done(null));
    child.once('close', done);
  });
}

// `--new` keeps the check away from standing threads and listening chats; no Remote Control
// work is queued for a check chat. The request id is given, so the ledger never sends it twice.
export function callThroughBridge(peer, requestId) {
  return runWithDeadline([BIN, 'call', '--to', peer, '--from', LIVE_CHECK_CALLER, '--new', '--no-remote-control', '--request-id', requestId, '--message', MESSAGE]);
}

function parseOutcome(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

function describe(r, outcome, answered, ok) {
  if (r.timedOut) return r.treeEnded ? DETAIL.deadline : DETAIL.cleanupFailed;
  if (outcome?.state === 'uncertain') return DETAIL.uncertain;
  if (answered) return ok ? '' : DETAIL.notOpened;
  // Only a known state name is repeated, never free text from the result.
  const state = ['sent', 'duplicate', 'refused'].includes(outcome?.state) ? `state ${outcome.state}, ` : '';
  return `not answered: ${state}exit code ${r.status}`;
}

// Called once, never retried. The reply itself is not reported: the check says whether there was one.
async function checkSide({ side, peer }, { cliFound, ready }, run) {
  if (!ready) return { side, peer, cliFound, answered: false, appOpened: null, ok: false, detail: DETAIL.notRun };
  const r = await run(peer, randomUUID());
  const outcome = r.timedOut ? null : parseOutcome(r.stdout);
  const answered = outcome?.state === 'answered' && Boolean(outcome.reply?.trim());
  // Only the Claude opener counts. A new Codex chat is opened by its link too, but that result is
  // not checked here: its `opened` shows only that the system took the link.
  // null where the result had nothing to say: a Codex side, or a call that did not answer.
  const appOpened = side === 'claude' && typeof outcome?.app?.opened === 'boolean' ? outcome.app.opened : null;
  const ok = answered && (side !== 'claude' || appOpened === true);
  return { side, peer, cliFound, answered, appOpened, ok, detail: describe(r, outcome, answered, ok) };
}

// `checks` are those of inspectPrerequisites. A side is called only when its command line and
// its sign-in are both 'found': a warning, such as paid API credentials, is not enough.
export async function runLiveChecks({ checks, run = callThroughBridge }) {
  const status = (id) => checks.find((c) => c.id === id)?.status;
  const sides = [];
  for (const target of LIVE_PEERS) {
    const cliFound = ['found', 'warning'].includes(status(target.cli));
    const ready = status(target.cli) === 'found' && status(target.auth) === 'found';
    sides.push(await checkSide(target, { cliFound, ready }, run));
  }
  return { ok: sides.every((s) => s.ok), sides };
}

export const liveExitCode = (live) => (live.ok ? 0 : 1);
