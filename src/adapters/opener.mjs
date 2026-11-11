// Runs a program that opens a chat in a desktop app, for the Claude and the Codex opener alike.
import { spawn } from 'node:child_process';

// Waits for the opener to exit. `opened: true` only when it exited with code 0; another exit
// code or running out of time is reported, never thrown. A failure to start rejects, so that
// each opener words it. The opener's own output is never read. At the time limit the opener is
// sent a plain kill signal: on macOS that should end `script`, whose closing terminal hangs up
// the Claude opener under it.
export function runOpener([file, args], { cwd, start = spawn, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = start(file, args, { cwd, detached: true, stdio: 'ignore' });
    // At the limit the answer is given at once, without waiting for an exit, and the child is
    // released so that one that survives the kill cannot keep the bridge running.
    const timer = setTimeout(() => {
      const signalled = child.kill();
      child.unref();
      const limit = `the opener did not exit within ${timeoutMs / 1000} seconds`;
      resolve({ opened: false, reason: signalled ? `${limit}; a stop signal was sent` : `${limit} and could not be stopped` });
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve(code === 0 ? { opened: true } : { opened: false, reason: `the opener exited with ${code === null ? `signal ${signal}` : `code ${code}`}` });
    });
  });
}
