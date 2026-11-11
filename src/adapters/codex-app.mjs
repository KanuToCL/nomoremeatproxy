// Opens a Codex thread in the Codex desktop app by its link, `codex://threads/<id>`, which the
// vendor documents as the link that opens an existing local chat. The running app does not list
// a thread the bridge created until it re-reads its list (hiccup 40). Seen twice on Windows:
// after the link was opened, the app showed and listed the chat without a relaunch, once after
// a delay that was not timed and once within seconds. On macOS and Linux the same commands, run
// by hand once each, made the app list the chat within seconds; see the usage notes.
import { spawn } from 'node:child_process';
import { SERVER_STILL_RUNNING } from './codex-transport.mjs';
import { runOpener } from './opener.mjs';

// Codex thread ids seen so far are UUIDs. Checked before anything starts, since cmd.exe reads
// its own command line: an id of another shape is never put into a link.
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// These openers hand the link to the system and return; the limit is for one that does not.
// Not measured.
const OPENER_TIMEOUT_MS = 10 * 1000;
const NO_OPENER = 'no opener for links is known on this platform, so nothing was attempted';

function openerCommand(platform, link) {
  // The empty argument reaches cmd.exe as "", which `start` takes as the window title, so the
  // link is what it opens. `start` exits once the system has taken the link.
  if (platform === 'win32') return ['cmd.exe', ['/c', 'start', '', link]];
  if (platform === 'darwin') return ['open', [link]];
  if (platform === 'linux') return ['xdg-open', [link]];
  return null;
}

// `opened: true` means only that the opener exited with code 0, so the system took the link; it
// does not show that the app listed the chat. Never throws: a failure to open must not fail a
// call that was answered. `supported: false` where there is no opener: an unknown platform, or
// an opener program that is not installed.
export function openInCodexApp(threadId, { platform = process.platform, start = spawn, timeoutMs = OPENER_TIMEOUT_MS } = {}) {
  if (!THREAD_ID.test(String(threadId))) {
    return Promise.resolve({ opened: false, reason: 'the thread id is not a UUID, so nothing was opened' });
  }
  const command = openerCommand(platform, `codex://threads/${threadId}`);
  if (!command) return Promise.resolve({ opened: false, supported: false, reason: NO_OPENER });
  return runOpener(command, { start, timeoutMs }).catch((error) =>
    error.code === 'ENOENT'
      ? { opened: false, supported: false, reason: `${command[0]} was not found, so nothing was opened` }
      : { opened: false, reason: `the opener did not start: ${error.message}` });
}

// After a call: opens only a thread the call created, never one it continued. While the bridge's
// own server runs it holds the thread, and a call returns only once that server has ended
// (withCodexServer), up to a limit. Past the limit the call carries SERVER_STILL_RUNNING as its
// warning, and the link is opened anyway. A call sent without waiting, or through the app's
// queue, never creates a thread. `optOut` is `--no-open`.
export async function openNewCodexThread({ outcome, optOut, ...options }) {
  if (optOut || outcome.state !== 'answered' || outcome.continued !== false) return;
  const app = await openInCodexApp(outcome.threadId, options);
  if (outcome.warning !== SERVER_STILL_RUNNING) {
    outcome.app = app;
    return;
  }
  const early = `${SERVER_STILL_RUNNING}, so the chat may not come up in the app until its link is opened again`;
  outcome.app = { ...app, reason: app.reason ? `${early}; ${app.reason}` : early };
}
