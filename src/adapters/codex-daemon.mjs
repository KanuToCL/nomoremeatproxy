// Makes sure Codex's local daemon runs before a message is queued that nothing else may run.
// A queued message is only stored; the daemon loads the chat and runs it. Only `--help`,
// `version` and `start` are ever issued: nothing here stops, restarts, updates or configures it.
const VERSION_TIMEOUT_MS = 10_000;
const START_TIMEOUT_MS = 30_000;

export const DAEMON_NOT_STARTED =
  'queued, but the daemon could not be started, so the message may not run until the chat is opened in the Codex app';

const daemon = (command) => ['app-server', 'daemon', command];

// Whether `codex app-server daemon` offers `start` and `version`, asked once per runner.
const offered = new WeakMap();
function offersDaemon(runCli) {
  if (!offered.has(runCli)) {
    const listed = ({ stdout = '' } = {}) => /^\s+start\s/m.test(stdout) && /^\s+version\s/m.test(stdout);
    offered.set(runCli, runCli(daemon('--help')).then(listed, () => false));
  }
  return offered.get(runCli);
}

// Seen live: a running daemon answers one JSON object with `"status":"running"`; a stopped one
// makes the command fail with a connection error. Anything else counts as not running, which
// only costs a `start`, and that leaves a running daemon alone.
async function isRunning(runCli) {
  try {
    const { stdout = '' } = (await runCli(daemon('version'), { timeoutMs: VERSION_TIMEOUT_MS })) ?? {};
    return JSON.parse(stdout)?.status === 'running';
  } catch {
    return false;
  }
}

// True when the daemon runs, or was started, or a concurrent sender started it first.
// Never throws: nothing is queued yet, so a failure here must not count as a delivery.
// A failed start is checked again with `version`: the wording of a lost race was not seen,
// and a start that hands its output pipes to the daemon may only end at its time limit.
export async function ensureDaemon(runCli) {
  if (!(await offersDaemon(runCli))) return false;
  if (await isRunning(runCli)) return true;
  try {
    await runCli(daemon('start'), { timeoutMs: START_TIMEOUT_MS });
    return true;
  } catch (error) {
    return /already.?running/i.test(error?.message ?? '') || isRunning(runCli);
  }
}
