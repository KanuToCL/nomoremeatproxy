// Find and read threads on either side by one interface.
import { findClaudeSessions, readClaudeConversation, readClaudeSession, searchClaudeSessions } from './claude.mjs';
import { findCodexThreads, readCodexConversation, readCodexThread, searchCodexThreads } from './codex.mjs';
import { renderConversation, validateCompactOptions } from './compact.mjs';

const SIDES = Object.freeze({
  codex: Object.freeze({ find: findCodexThreads, searchText: searchCodexThreads, read: readCodexThread, conversation: readCodexConversation }),
  claude: Object.freeze({ find: findClaudeSessions, searchText: searchClaudeSessions, read: readClaudeSession, conversation: readClaudeConversation }),
});

function sideNamed(name) {
  const key = String(name ?? '').toLowerCase();
  if (!Object.hasOwn(SIDES, key)) throw new Error(`--side must be one of: ${Object.keys(SIDES).join(', ')}`);
  return SIDES[key];
}

// `project`, when given, keeps only threads whose folder is that project folder. `text`, when
// given, searches inside messages as well.
export async function findThreads({ side, search = '', text, limit = 10, project }) {
  const chosen = sideNamed(side);
  if (text === undefined) return chosen.find({ search, limit, project });
  if (!String(text).trim()) throw new Error('--text is empty');
  return chosen.searchText({ search, text, limit, project });
}

export async function readThread({ side, threadId, turns = 2, maxChars = 4000 }) {
  if (!threadId) throw new Error('--thread is required');
  return sideNamed(side).read({ threadId, turns, maxChars });
}

export async function readConversation({ side, threadId, ...options }) {
  if (!threadId) throw new Error('--thread is required');
  validateCompactOptions(options);
  return renderConversation(await sideNamed(side).conversation({ threadId }), options);
}
