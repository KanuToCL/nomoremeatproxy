// Runs the Codex CLI without a shell, so free text can be passed as an argument safely.
import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const whereCodex = () => execFileSync('where.exe', ['codex'], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);

// npm installs Codex on Windows as a .cmd shim, which only a shell can start. The shim's
// Node entry point is run directly instead. Windows path rules apply whatever the host is.
export function resolveCodexCommand({ platform = process.platform, where = whereCodex, exists = existsSync, node = process.execPath } = {}) {
  if (platform !== 'win32') return { file: 'codex', prefix: [] };
  const found = where();
  const executable = found.find((candidate) => candidate.toLowerCase().endsWith('.exe'));
  if (executable) return { file: executable, prefix: [] };
  for (const shim of found) {
    const entry = path.win32.join(path.win32.dirname(shim), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (exists(entry)) return { file: node, prefix: [entry] };
  }
  throw new Error('could not find a Codex executable that runs without a shell');
}

// A failure carries `notStarted: true` only when the command never ran: no executable was
// found, or it could not be spawned. After that, a failure or time-out may have done its work.
export async function runCodexCli(args, { timeoutMs = 60000 } = {}) {
  let command;
  try {
    command = resolveCodexCommand();
  } catch (error) {
    throw Object.assign(error, { notStarted: true });
  }
  return new Promise((resolve, reject) => {
    execFile(command.file, [...command.prefix, ...args], { timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
      if (!error) return resolve({ stdout, stderr });
      const notStarted = typeof error.syscall === 'string' && error.syscall.startsWith('spawn');
      reject(Object.assign(new Error(`codex ${args[0]} failed: ${stderr.trim().split('\n').at(-1) || error.message}`), { notStarted }));
    });
  });
}
