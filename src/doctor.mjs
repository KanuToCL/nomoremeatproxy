// Read-only check of what the bridge depends on. Runs nothing on import. Reports versions,
// counts and signed in or not only: no paths, user names, account details, message content or
// raw command output, so the result is safe to commit.
// Sections: command runner / probes / inspectPrerequisites / host.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultStateDir } from './ledger.mjs';
import { canWrite } from './writable.mjs';

const isWin = process.platform === 'win32';

// A limit of one model, not of the bridge. On the first macOS run, Claude CLI 2.1.283 had calls
// to this model refused with "API Error 400"; the vendor's message named 2.1.290 as the minimum,
// and 2.1.322 was seen working (docs/evidence/2026-11-11-macos-baseline.md).
export const CLAUDE_CLI_MINIMUM_FOR_MODEL = Object.freeze({ model: 'claude-fable-5-2', version: '2.1.290' });

// --- command runner ---

// The default `capture`: runs a command and returns whether it succeeded and its output.
export function runCommand(file, args = [], { shell = false, encoding = 'utf8' } = {}) {
  const options = { encoding, timeout: 20000, windowsHide: true };
  const r = shell ? spawnSync(file, { ...options, shell: true }) : spawnSync(file, args, options);
  if (r.error || r.status === null) return { ok: false, out: '' };
  return { ok: r.status === 0, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim() };
}

const firstVersion = (text) => text.match(/\d+\.\d+(?:\.\d+)*/)?.[0] ?? null;
const found = (version = null, note = '') => ({ status: 'found', version, note });
const missing = (note = '') => ({ status: 'missing', version: null, note });
const unknown = (note) => ({ status: 'unknown', version: null, note });
const NOT_CHECKED_HERE = unknown('not checked on this platform');

export function compareVersions(a, b) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// --- probes ---
// `shell` runs a constant command string: npm-installed CLIs are .cmd shims on Windows and need one.

function cliVersion(shell, command) {
  const r = shell(command);
  const version = r.ok ? firstVersion(r.out) : null;
  return version ? found(version) : missing();
}

function cliSupports(shell, command, pattern, capability) {
  const r = shell(command);
  if (!r.ok) return missing(`${capability}: command failed`);
  return pattern.test(r.out) ? found(null, capability) : missing(`${capability}: not offered by this version`);
}

// The Node version against `engines.node` in package.json. Limit: only a lower bound written as
// ">=x.y[.z]" is understood; any other range reads as no minimum known.
const NODE_RANGE = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).engines?.node ?? '';
export function nodeVersionCheck(version = process.versions.node) {
  const minimum = NODE_RANGE.match(/^\s*>=\s*(\d+(?:\.\d+)*)\s*$/)?.[1];
  if (!minimum) return unknown(`found ${version}; the minimum in package.json could not be read`);
  if (compareVersions(version, minimum) >= 0) return found(version);
  return { status: 'missing', version, note: `older than ${minimum}, the minimum this package declares` };
}

function claudeCliVersion(shell) {
  const result = cliVersion(shell, 'claude --version');
  const { model, version } = CLAUDE_CLI_MINIMUM_FOR_MODEL;
  if (result.status !== 'found' || compareVersions(result.version, version) >= 0) return result;
  return { ...result, status: 'warning', note: `older than ${version}, the minimum the vendor named for the model ${model}; calls to that model fail until the CLI is updated` };
}

// The vendors' own sign-in status commands, reduced to a fixed note. Nothing of their output
// leaves these functions. 'found' means signed in with the subscription; an API key or a third
// party is a warning, since calls would then use paid API credentials.
const SUBSCRIPTION = found(null, 'signed in with the subscription');
const PAID_API = { status: 'warning', version: null, note: 'signed in with an API key or a third party: paid API credentials would be used' };
const SIGNED_OUT = missing('not signed in');
const UNREAD = unknown('sign-in status could not be read');

// Seen: "Logged in using ChatGPT", "Logged in using an API key - <masked key>", "Not logged in".
function codexSignIn(shell) {
  const r = shell('codex login status');
  if (/not logged in/i.test(r.out)) return SIGNED_OUT;
  if (!r.ok) return UNREAD;
  if (/logged in using chatgpt/i.test(r.out)) return SUBSCRIPTION;
  return /logged in using an api key/i.test(r.out) ? PAID_API : UNREAD;
}

// Seen in `--json`: authMethod 'claude.ai' with apiProvider 'firstParty' for a subscription,
// authMethod 'api_key' for an API key; another apiProvider is a third party.
function claudeSignIn(shell) {
  let status;
  try {
    status = JSON.parse(shell('claude auth status --json').out.match(/\{[\s\S]*\}/)?.[0] ?? '');
  } catch {
    return UNREAD;
  }
  if (status?.loggedIn === false) return SIGNED_OUT;
  if (status?.loggedIn !== true) return UNREAD;
  if (status.authMethod === 'claude.ai' && status.apiProvider === 'firstParty') return SUBSCRIPTION;
  return status.authMethod === 'api_key' || (status.apiProvider && status.apiProvider !== 'firstParty') ? PAID_API : UNREAD;
}

// Chromium browsers keep one folder per installed version next to the executable.
function installedVersion(...relative) {
  if (!isWin) return NOT_CHECKED_HERE;
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean);
  for (const root of roots) {
    const dir = path.join(root, ...relative);
    if (!existsSync(dir)) continue;
    const versions = readdirSync(dir).filter((name) => /^\d+(\.\d+){2,3}$/.test(name)).sort(compareVersions);
    if (versions.length > 0) return found(versions.at(-1));
  }
  return missing();
}

function queryStoreApps(capture) {
  const script = "Get-AppxPackage | Where-Object { $_.Name -match 'Claude|OpenAI|ChatGPT' } | ForEach-Object { $_.Name + ' ' + $_.Version }";
  const r = capture('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
  if (!r.ok) return null;
  return r.out.split(/\r?\n/).map((line) => line.trim().split(' ')).filter((parts) => parts.length === 2);
}

function storeApp(apps, pattern) {
  if (!isWin) return NOT_CHECKED_HERE;
  if (!apps) return unknown('could not query installed Store packages');
  const hit = apps.find(([name]) => pattern.test(name));
  return hit ? found(hit[1], `Store package ${hit[0]}`) : missing('no Store package; other install types are not detected');
}

function wslDistros(capture) {
  if (!isWin) return NOT_CHECKED_HERE;
  const r = capture('wsl.exe', ['-l', '-q'], { encoding: 'utf16le' });
  const names = r.out.split(/\r?\n/).map((line) => line.replace(/\0/g, '').trim()).filter(Boolean);
  return r.ok && names.length > 0 ? found(null, `${names.length} distro(s)`) : missing();
}

function sessionStore(dir, isSessionFile) {
  if (!existsSync(dir)) return missing();
  const entries = readdirSync(dir, { withFileTypes: true, recursive: true });
  const count = entries.filter((entry) => entry.isFile() && isSessionFile(entry.name)).length;
  return found(null, `${count} session files`);
}

// The folder is named by its variable, never by its path, which can hold a user name.
function stateFolder() {
  if (canWrite(defaultStateDir())) return found();
  return missing('cannot be created or written; set NOMEAT_STATE_DIR to a folder this process can write');
}

function githubCli(shell) {
  const version = cliVersion(shell, 'gh --version');
  if (version.status !== 'found') return version;
  return { ...version, note: shell('gh auth status').ok ? 'signed in' : 'not signed in' };
}

// --- inspectPrerequisites ---

// Synchronous. `ok` is false when a required check is missing. `capture(file, args, options)`
// returns `{ ok, out }`; tests inject one.
export function inspectPrerequisites({ capture = runCommand } = {}) {
  const shell = (command) => capture(command, [], { shell: true });
  const apps = isWin ? queryStoreApps(capture) : null;
  const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const claudeHome = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
  const check = (id, required, result) => ({ id, required, ...result });
  const checks = [
    check('codex-cli', true, cliVersion(shell, 'codex --version')),
    check('codex-auth', true, codexSignIn(shell)),
    check('codex-queue-thread', false, cliSupports(shell, 'codex queue --help', /--thread/, '`codex queue --thread`')),
    check('codex-exec-resume', false, cliSupports(shell, 'codex exec resume --help', /SESSION_ID/, '`codex exec resume`')),
    check('codex-sessions', false, sessionStore(path.join(codexHome, 'sessions'), (name) => /\.jsonl(\.zst)?$/.test(name))),
    check('claude-cli', true, claudeCliVersion(shell)),
    check('claude-auth', true, claudeSignIn(shell)),
    check('claude-resume', false, cliSupports(shell, 'claude --help', /--resume/, '`claude -p --resume`')),
    check('claude-sessions', false, sessionStore(path.join(claudeHome, 'projects'), (name) => name.endsWith('.jsonl'))),
    check('codex-app', false, storeApp(apps, /codex/i)),
    check('claude-app', false, storeApp(apps, /^claude$/i)),
    check('chatgpt-app', false, storeApp(apps, /chatgpt/i)),
    check('chrome', false, installedVersion('Google', 'Chrome', 'Application')),
    check('edge', false, installedVersion('Microsoft', 'Edge', 'Application')),
    check('node', true, nodeVersionCheck()),
    check('state-folder', true, stateFolder()),
    check('git', false, cliVersion(shell, 'git --version')),
    check('github-cli', false, githubCli(shell)),
    check('tailscale', false, cliVersion(shell, 'tailscale version')),
    check('wsl', false, wslDistros(capture)),
  ];
  return { ok: !checks.some((c) => c.required && c.status === 'missing'), checks };
}

// --- host ---

function readOsRelease() {
  try {
    return readFileSync('/etc/os-release', 'utf8');
  } catch {
    return null;
  }
}

// The host line of the report. Where /etc/os-release exists, as on Linux, the distribution and
// its version; elsewhere the system's own description, which on Linux is only the kernel build.
export function describeHost(osRelease = readOsRelease()) {
  const field = (key) => osRelease?.match(new RegExp(`^${key}=["']?(.*?)["']?\s*$`, 'm'))?.[1];
  const distribution = field('PRETTY_NAME') || [field('NAME'), field('VERSION_ID')].filter(Boolean).join(' ');
  return `${distribution || os.version()} (${os.release()}), ${os.arch()}`;
}
