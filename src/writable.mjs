// Whether a folder can be written, tested by writing, and the fixed wording for a state folder
// that refuses a write. A permission check such as access(W_OK) can say yes inside a sandbox
// that still refuses the write.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';

export const STATE_NOT_WRITABLE =
  'the state folder cannot be written: permission was refused. Set NOMEAT_STATE_DIR to a folder this process can write; both sides must use the same one';
const DENIED = new Set(['EACCES', 'EPERM', 'EROFS']);
// SQLite's own codes for a file it cannot open (14) or write (8).
const SQLITE_DENIED = new Set([8, 14]);

// Runs a write to the state folder. A refusal for lack of permission becomes an error with
// STATE_NOT_WRITABLE as its message and the system error as its cause; others pass unchanged.
// A recursive mkdir reports ENOENT, not EROFS, for a missing folder on a read-only file
// system, so ENOENT counts as a refusal when the path it names could not be created.
export function writeState(write) {
  try {
    return write();
  } catch (error) {
    const sqlite = error.code === 'ERR_SQLITE_ERROR' && SQLITE_DENIED.has(error.errcode & 0xff);
    const missing = error.code === 'ENOENT' && error.path && !canWrite(error.path);
    if (DENIED.has(error.code) || sqlite || missing) throw new Error(STATE_NOT_WRITABLE, { cause: error });
    throw error;
  }
}

// For a read that finds no state file: a state folder that does not exist and cannot be
// created gives STATE_NOT_WRITABLE instead of an empty state. Creates nothing.
export function checkStateDir(dir) {
  if (!existsSync(dir) && !canWrite(dir)) throw new Error(STATE_NOT_WRITABLE);
}

// True when `dir` exists and is writable, or does not exist and its nearest existing parent
// is. Creates an empty folder there and removes it at once; leaves nothing behind.
export function canWrite(dir) {
  let existing = path.resolve(dir);
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return false;
    existing = parent;
  }
  try {
    rmSync(mkdtempSync(path.join(existing, '.nomeat-write-check-')), { recursive: true });
    return true;
  } catch {
    return false;
  }
}
