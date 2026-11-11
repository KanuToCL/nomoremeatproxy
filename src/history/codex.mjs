// Codex history: list and read the threads the Codex desktop app shows, through app-server.
// Sections: descriptions / legacy list/read / compact conversation / message search.
import { withCodexServer } from '../adapters/codex-transport.mjs';
import { sameFolder } from './folder.mjs';
import { matchedOn, matchItem, textWords } from './match.mjs';
import { clipItems, firstLine, lastTurns } from './render.mjs';

const toIso = (seconds) => (typeof seconds === 'number' ? new Date(seconds * 1000).toISOString() : null);

// Returns null for items that are not surfaced, such as the model's private reasoning.
export function describeCodexItem(item) {
  switch (item.type) {
    case 'userMessage':
      return { kind: 'user', text: (item.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n') };
    case 'agentMessage':
      return { kind: 'assistant', text: item.text ?? '' };
    case 'plan':
      return { kind: 'plan', text: item.text ?? '' };
    case 'commandExecution':
      return { kind: 'command', text: typeof item.exitCode === 'number' ? `${item.command} (exit ${item.exitCode})` : String(item.command) };
    case 'fileChange':
      return { kind: 'file-change', text: (item.changes ?? []).map((change) => change.path).join('\n') };
    case 'mcpToolCall':
      return { kind: 'tool', text: [item.server, item.tool].filter(Boolean).join('.') };
    case 'dynamicToolCall':
      return { kind: 'tool', text: [item.namespace, item.tool].filter(Boolean).join('.') };
    case 'webSearch':
      return { kind: 'web-search', text: item.query ?? '' };
    case 'reasoning':
      return null;
    default:
      return { kind: item.type, text: '' };
  }
}

export function summarizeCodexThread(thread) {
  return {
    threadId: thread.id,
    title: thread.name || firstLine(thread.preview),
    updatedAt: toIso(thread.updatedAt),
    cwd: thread.cwd ?? null,
  };
}

// Read from outside, a turn another process is still running reports `interrupted` (see
// findRequestTurn). A newer turn means an older one ended, so only the newest is in doubt.
export const shownStatus = (status, newest) => (newest && status === 'interrupted' ? 'interrupted, or still running' : status ?? null);

export function renderCodexThread(thread, { turns, maxChars }) {
  const all = thread.turns ?? [];
  return {
    side: 'codex',
    ...summarizeCodexThread(thread),
    turnsTotal: all.length,
    turns: lastTurns(all, turns).map((turn) => ({
      startedAt: toIso(turn.startedAt),
      status: shownStatus(turn.status, turn === all.at(-1)),
      items: clipItems((turn.items ?? []).map(describeCodexItem).filter(Boolean), maxChars),
    })),
  };
}

// Codex compares a thread's folder in its own way, so the folder is matched here instead, over
// the newest threads only. The result says how far back that reached. thread/list returns at
// most 100 threads in one request, whatever larger limit is asked for.
const LIST_MAX = 100;

export function threadsInFolder(threads, project) {
  return project ? threads.filter((thread) => sameFolder(thread.cwd, project)) : threads;
}

export async function findCodexThreads({ search, limit, project }) {
  const result = await withCodexServer((client) =>
    client.request('thread/list', { searchTerm: search || null, limit: project ? LIST_MAX : limit, sortKey: 'updated_at' }),
  );
  const listed = 'threads the Codex app lists (interactive sources, not archived)';
  const matches = threadsInFolder(result.data.map(summarizeCodexThread), project);
  return {
    side: 'codex',
    matchedOn: project ? 'title, within the project folder' : 'title',
    scope: project ? `the newest ${result.data.length} ${listed}` : listed,
    more: matches.length > limit || Boolean(result.nextCursor),
    threads: matches.slice(0, limit),
  };
}

export async function readCodexThread({ threadId, turns, maxChars }) {
  const result = await withCodexServer((client) => client.request('thread/read', { threadId, includeTurns: true }));
  return renderCodexThread(result.thread, { turns, maxChars });
}

// Separate CLI view: do not change the legacy renderer or the recovery/check consumers.
export function codexConversation(thread) {
  return {
    side: 'codex', threadId: thread.id,
    turns: (thread.turns ?? []).map(turn => ({ startedAt: toIso(turn.startedAt), status: turn.status ?? null, items: (turn.items ?? []).map(item => {
      const described = describeCodexItem(item);
      if (!described) return { kind: 'private', text: '', omission: 'privateOrUnsupported' };
      return { ...described, ...(item.type === 'contextCompaction' ? { omission: 'context' } : {}) };
    }) })),
  };
}

export async function readCodexConversation({ threadId }) {
  const result = await withCodexServer(client => client.request('thread/read', { threadId, includeTurns: true }));
  return codexConversation(result.thread);
}

// --- search inside messages ---

// How many threads a search inside messages reads, one after another on one server. Without a
// project it lists only that many; with one it lists up to LIST_MAX and reads the project's.
// Listing is most of the cost: on the development machine listing 20 threads took about 4
// seconds and 100 about 7, while each read took under 0.1 seconds.
export const TEXT_SCAN = 20;

export function firstCodexMatch(thread, words) {
  for (const turn of thread.turns ?? []) {
    for (const item of turn.items ?? []) {
      const described = describeCodexItem(item);
      const match = described && matchItem(described, words);
      if (match) return { ...match, at: toIso(turn.startedAt) };
    }
  }
  return null;
}

export async function searchCodexThreads({ search, text, limit, project, bound = TEXT_SCAN, server = withCodexServer }) {
  const words = textWords(text);
  return server(async (client) => {
    const listed = await client.request('thread/list', { searchTerm: search || null, limit: project ? LIST_MAX : bound, sortKey: 'updated_at' });
    const inFolder = threadsInFolder(listed.data, project);
    const threads = [];
    let looked = 0;
    let unreadable = 0;
    for (const thread of inFolder.slice(0, bound)) {
      if (threads.length > limit) break;
      looked += 1;
      let full;
      try {
        ({ thread: full } = await client.request('thread/read', { threadId: thread.id, includeTurns: true }));
      } catch {
        unreadable += 1;
        continue;
      }
      const match = firstCodexMatch(full, words);
      if (match) threads.push({ ...summarizeCodexThread(full), match });
    }
    const lists = 'the Codex app lists (interactive sources, not archived)';
    const searched = project
      ? `the ${looked} threads in the project folder among the ${listed.data.length} most recent threads ${lists}`
      : `the ${looked} most recent threads ${lists}`;
    let cut = '';
    if (threads.length <= limit && inFolder.length > bound) cut = `; the search reads at most ${bound} threads, so older ones in the project folder were not searched`;
    else if (threads.length <= limit && listed.nextCursor) cut = `; threads older than the ${listed.data.length} listed were not searched`;
    return {
      side: 'codex',
      matchedOn: matchedOn({ search, text, project }),
      scope: `${searched}${unreadable ? `; ${unreadable} of them could not be read` : ''}${cut}`,
      more: threads.length > limit,
      threads: threads.slice(0, limit),
    };
  });
}
