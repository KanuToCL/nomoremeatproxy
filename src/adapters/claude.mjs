// Claude adapter. Uses `claude -p` for the turn and the official `--desktop` opener to list
// the session in the Claude desktop app.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { claudeProjectsDir } from '../history/claude.mjs';
import { claudeUsage } from '../usage.mjs';
import { canWrite } from '../writable.mjs';
import { runOpener } from './opener.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9._:-]+$/;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
// A call without write access gets the reading tools only. That makes "read-only" hold
// whatever the owner's own permission settings are, and it cuts the fixed load of a call:
// measured here, a one-word answer took 58,193 input tokens with every tool defined and
// 23,218 with these three.
const READ_ONLY_TOOLS = 'Read,Grep,Glob';

function requireMatch(value, pattern, name) {
  if (!pattern.test(String(value))) throw new Error(`invalid ${name}: ${JSON.stringify(value)}`);
  return String(value);
}

// Without a model (null or undefined) the vendor's own default applies.
export function buildClaudeArgs({ sessionId, resume, title, model, effort, write = false }) {
  const id = requireMatch(sessionId, UUID, 'Claude session id');
  return [
    '-p',
    '--output-format',
    'json',
    ...(model == null ? [] : ['--model', requireMatch(model, TOKEN, 'model')]),
    ...(effort ? ['--effort', requireMatch(effort, TOKEN, 'effort')] : []),
    ...(write ? [] : ['--tools', READ_ONLY_TOOLS]),
    ...(resume ? ['--resume', id] : ['--session-id', id]),
    ...(!resume && title ? ['--name', title] : []),
    ...(write ? ['--permission-mode', 'acceptEdits'] : []),
  ];
}

export function parseClaudeResult(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`Claude returned output that is not JSON: ${stdout.slice(0, 200)}`);
  }
  const result = Array.isArray(parsed) ? parsed.findLast((entry) => entry?.type === 'result') : parsed;
  if (result?.type !== 'result') throw new Error('Claude output had no result entry');
  if (result.is_error) {
    throw new Error(`Claude turn failed: ${result.result ?? result.subtype ?? 'no detail'} (session ${result.session_id})`);
  }
  const usage = claudeUsage(result);
  return { threadId: result.session_id, reply: result.result ?? '', ...(usage ? { usage } : {}) };
}

const notSent = (message) => Object.assign(new Error(message), { notSent: true });
const WAY_OUT = 'nothing was sent. Run the call outside the sandbox, or have a Claude chat in this project listen as this peer (`nomeat listen`) so that the call is delivered to it';
const NO_FOLDER = `Claude cannot run here: the folder it keeps its sessions in (under CLAUDE_CONFIG_DIR, or .claude in the home folder) is not writable; ${WAY_OUT}`;
const NO_NETWORK = `Claude cannot run here: the host it talks to could not be looked up, so there is no network; ${WAY_OUT}`;
// Includes starting the child below. Limit: a resolver slower than this fails the call.
const LOOKUP_TIMEOUT_MS = 3000;
const PROXY_VARIABLES = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];
const LOOKUP_SCRIPT = "require('node:dns').lookup(process.argv[1], (error) => process.exit(error ? 1 : 0))";

// The system's own lookup, so every name the system knows counts. dns.lookup cannot be
// cancelled, so it runs in a child process that is ended at the limit and leaves nothing in
// this one. Costs one short child process per headless Claude call. True only on exit code 0;
// a child that does not start, fails or runs out of time means not looked up.
export function lookupInChild(host, timeoutMs, start = spawn) {
  return new Promise((resolve) => {
    let child;
    try {
      child = start(process.execPath, ['-e', LOOKUP_SCRIPT, '--', host], { stdio: 'ignore', timeout: timeoutMs, windowsHide: true });
    } catch {
      resolve(false);
      return;
    }
    child.once('error', () => resolve(false));
    child.once('exit', (code) => resolve(code === 0));
  });
}

// Run before `claude` starts, so that a call that cannot work fails at once, as not sent.
// Inside Codex's sandbox on Linux and macOS there is no network and Claude's folder is
// read-only; there the command line hung instead of failing.
export async function checkClaudeCanRun({ env = process.env, resolve = lookupInChild, writable = canWrite, timeoutMs = LOOKUP_TIMEOUT_MS } = {}) {
  if (!writable(claudeProjectsDir(env))) throw notSent(NO_FOLDER);
  // Limit: behind a proxy a name lookup can fail while the command line still works, so the
  // lookup is skipped there and a missing network is then not caught.
  if (PROXY_VARIABLES.some((name) => env[name])) return;
  // Limit: with Bedrock or Vertex the command line talks to other hosts; this one is still looked up.
  const host = URL.parse(env.ANTHROPIC_BASE_URL ?? '')?.hostname || 'api.anthropic.com';
  // An address or localhost needs no lookup.
  if (isIP(host.replace(/[[\]]/g, '')) || host === 'localhost') return;
  if (!(await resolve(host, timeoutMs))) throw notSent(NO_NETWORK);
}

// No shell: the arguments are passed as an array and the message goes in on stdin.
function runClaude(args, { input, cwd, timeoutMs, start }) {
  return new Promise((resolve, reject) => {
    const child = start('claude', args, { cwd, stdio: 'pipe', windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

export async function callClaude({ threadId, message, title, model, effort, write = false, cwd = process.cwd(), onThread = () => {}, timeoutMs = DEFAULT_TIMEOUT_MS, canRun = checkClaudeCanRun, start = spawn }) {
  const sessionId = threadId ?? randomUUID();
  const args = buildClaudeArgs({ sessionId, resume: Boolean(threadId), title, model, effort, write });
  await canRun();
  // The id is chosen here, so it is known before anything is sent.
  onThread(sessionId);
  const { code, stdout, stderr } = await runClaude(args, { input: message, cwd, timeoutMs, start });
  if (!stdout.trim()) {
    throw new Error(`Claude exited with code ${code} and no output: ${stderr.trim().slice(0, 300)} (session ${sessionId})`);
  }
  return { ...parseClaudeResult(stdout), delivery: 'headless', access: write ? 'write' : 'read-only', ...(effort ? { effort } : {}) };
}

// On Linux the vendor's opener says that `--desktop` works on macOS and Windows only.
const NO_OPENER = 'the vendor offers no opener for the Claude app on this platform, so nothing was attempted';
// A Mac run listed the chat within 3 seconds; this leaves room for a slow start.
const OPENER_TIMEOUT_MS = 20 * 1000;

// The command that runs the official opener, or the reason it is not run. The opener refuses
// to run without a terminal, so it is given one.
function openerCommand(platform, id) {
  const opener = ['claude', '--desktop', '--resume', id];
  // On Windows it gets a console window of its own. Exit code 0 here only shows that this
  // window was launched, not that the chat was listed: `start` does not wait for the opener.
  if (platform === 'win32') return { command: ['cmd.exe', ['/c', 'start', '/min', ...opener]] };
  // On macOS it runs under a pseudo-terminal with no window, and its own exit code comes back.
  if (platform === 'darwin') return { command: ['script', ['-q', '/dev/null', ...opener]] };
  return { reason: NO_OPENER };
}

// Runs the opener and waits for it to exit (see runOpener). A failure to start, another exit
// code or running out of time is reported, never thrown.
// `supported: false` only where no opener exists, so that callers can tell it from a failure.
export function openInClaudeApp(sessionId, { cwd = process.cwd(), platform = process.platform, start = spawn, timeoutMs = OPENER_TIMEOUT_MS } = {}) {
  const id = requireMatch(sessionId, UUID, 'Claude session id');
  const { command, reason } = openerCommand(platform, id);
  if (!command) return Promise.resolve({ opened: false, supported: false, reason });
  return runOpener(command, { cwd, start, timeoutMs }).catch((error) => ({ opened: false, reason: `the opener did not start: ${error.message}` }));
}
