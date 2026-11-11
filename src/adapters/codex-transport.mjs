// Client for `codex app-server` over stdio: one JSON object per line. Requests carry an id;
// notifications do not. This is the entry point the Codex desktop app itself uses.
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const CLIENT_INFO = Object.freeze({ name: 'nomoremeatproxy', title: 'NOMOREMEATPROXY', version: '0.1.0' });
// Seen on Windows: the server was gone 15 to 25 ms after it was told to stop.
const EXIT_TIMEOUT_MS = 5000;

export const SERVER_STILL_RUNNING = `the bridge's own Codex server had not exited ${EXIT_TIMEOUT_MS / 1000} seconds after it was told to stop`;

function connect({ onNotification, onClosed, start }) {
  // Constant command line: payloads travel as JSON on stdin, never through the shell.
  const server = start('codex app-server', { shell: true, stdio: ['pipe', 'pipe', 'ignore'] });
  // 'close', not 'exit': the server runs under a shell, which exits at the stop signal while the
  // server itself is still running. Its output closes only when every process holding it has
  // ended. Seen on Windows: shell, then Codex's Node launcher, then the server.
  const ended = new Promise((resolve) => server.once('close', resolve));
  const pending = new Map();
  let nextId = 1;
  const write = (message) => server.stdin.write(`${JSON.stringify(message)}\n`);
  const closed = (error) => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
    onClosed(error);
  };
  server.on('error', closed);
  server.on('exit', () => closed(new Error('codex app-server exited before the work completed')));

  readline.createInterface({ input: server.stdout }).on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.method === undefined) {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(`Codex rejected the request: ${JSON.stringify(message.error)}`));
      else waiter.resolve(message.result);
    } else if (message.id === undefined) {
      onNotification(message.method, message.params ?? {});
    } else {
      // An approval or question for a human. Nobody is there, so decline instead of hanging.
      write({ id: message.id, error: { code: -32601, message: 'nomeat cannot answer interactive requests' } });
    }
  });

  return {
    request: (method, params) =>
      new Promise((resolve, reject) => {
        const id = nextId;
        nextId += 1;
        pending.set(id, { resolve, reject });
        write({ id, method, params });
      }),
    notify: (method) => write({ method }),
    // Stops the server and waits for it to end, up to the limit. True when it ended in time.
    // Never throws, so that it cannot replace the result of the work.
    close: async (timeoutMs) => {
      try {
        server.stdin.end();
        server.kill();
      } catch {
        // Waited for below like any other stop.
      }
      let timer;
      const limit = new Promise((resolve) => (timer = setTimeout(resolve, timeoutMs, false)));
      const exited = await Promise.race([ended.then(() => true), limit]);
      clearTimeout(timer);
      return exited;
    },
  };
}

// Starts a server, completes the handshake, runs `work(client)` and always shuts the server down.
// It returns once the server has ended, so that nothing holds a thread the work used; a server
// that has not ended at the limit is left and reported to `onStillRunning`.
export async function withCodexServer(work, { onNotification = () => {}, onClosed = () => {}, onStillRunning = () => {}, start = spawn, exitTimeoutMs = EXIT_TIMEOUT_MS } = {}) {
  const client = connect({ onNotification, onClosed, start });
  try {
    await client.request('initialize', { clientInfo: CLIENT_INFO });
    client.notify('initialized');
    return await work(client);
  } finally {
    if (!(await client.close(exitTimeoutMs))) onStillRunning();
  }
}
