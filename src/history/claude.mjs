// Claude history: list and read Claude Code sessions from their local session files. The
// file format is not a documented interface, so every field is read defensively.
// Sections: records (pure) / files / find and read / compact conversation / message search.
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { sameFolder } from './folder.mjs';
import { matchedOn, matchItem, textWords } from './match.mjs';
import { clipItems, firstLine, lastTurns } from './render.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A search inside messages reads at most this many of the most recent session files. On the
// development machine, reading all 46 files there (420 MB) took about 2 seconds.
export const TEXT_SCAN = 200;

// --- records ---

// The text the user typed, or null for tool results, injected records and side conversations.
function promptText(record) {
  if (record.type !== 'user' || record.isMeta || record.isSidechain) return null;
  const content = record.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content) || content.some((block) => block.type === 'tool_result')) return null;
  return content.filter((block) => block.type === 'text').map((block) => block.text).join('\n') || null;
}

// Returns null for blocks that are not surfaced, such as the model's private reasoning.
export function describeClaudeBlock(block) {
  if (block.type === 'text') return { kind: 'assistant', text: block.text ?? '' };
  if (block.type !== 'tool_use') return null;
  const detail = block.input?.command ?? block.input?.file_path ?? block.input?.description ?? '';
  return { kind: 'tool', text: detail ? `${block.name}: ${detail}` : String(block.name) };
}

// Adds one record to the session and returns the items it added.
function foldClaudeRecord(session, record) {
  if (record.timestamp && record.timestamp > (session.updatedAt ?? '')) session.updatedAt = record.timestamp;
  if (record.cwd) session.cwd = record.cwd;
  if (record.type === 'custom-title' && record.customTitle) session.title = record.customTitle;
  const prompt = promptText(record);
  if (prompt !== null) {
    const item = { kind: 'user', text: prompt };
    session.turns.push({ startedAt: record.timestamp ?? null, items: [item] });
    return [item];
  }
  if (record.type !== 'assistant' || record.isSidechain || session.turns.length === 0) return [];
  const blocks = Array.isArray(record.message?.content) ? record.message.content : [];
  const items = blocks.map(describeClaudeBlock).filter(Boolean);
  session.turns.at(-1).items.push(...items);
  return items;
}

const newSession = () => ({ title: '', cwd: null, updatedAt: null, turns: [] });

function finishSession(session) {
  if (!session.title) session.title = firstLine(session.turns[0]?.items[0]?.text);
  return session;
}

export function foldClaudeRecords(records) {
  const session = newSession();
  for (const record of records) foldClaudeRecord(session, record);
  return finishSession(session);
}

// A record, or null for a line that is torn, damaged or not a record at all.
function parseRecord(line) {
  try {
    const record = JSON.parse(line);
    return record && typeof record === 'object' && !Array.isArray(record) ? record : null;
  } catch {
    return null;
  }
}

// --- files ---

export function claudeProjectsDir(env = process.env) {
  return path.join(env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'projects');
}

function sessionFiles(projectsDir) {
  if (!existsSync(projectsDir)) return [];
  return readdirSync(projectsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((project) =>
      readdirSync(path.join(projectsDir, project.name))
        .filter((name) => UUID.test(name.replace(/\.jsonl$/, '')) && name.endsWith('.jsonl'))
        .map((name) => ({ threadId: name.replace(/\.jsonl$/, ''), file: path.join(projectsDir, project.name, name) })),
    );
}

function loadSession(file) {
  // A session being written can end in a torn line.
  return foldClaudeRecords(sessionRecords(file));
}

const sessionRecords = (file) => readFileSync(file, 'utf8').split('\n').map(parseRecord).filter(Boolean);

// --- find and read ---

export function findClaudeSessions({ search, limit, project, projectsDir = claudeProjectsDir() }) {
  const files = sessionFiles(projectsDir);
  const needle = String(search ?? '').toLowerCase();
  const matches = files
    .map(({ threadId, file }) => ({ threadId, ...loadSession(file) }))
    .filter((session) => session.title.toLowerCase().includes(needle) && (!project || sameFolder(session.cwd, project)))
    .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
  return {
    side: 'claude',
    matchedOn: project ? 'title, within the project folder' : 'title',
    scope: `${files.length} Claude Code session files on this machine`,
    more: matches.length > limit,
    threads: matches.slice(0, limit).map(({ threadId, title, updatedAt, cwd }) => ({ threadId, title, updatedAt, cwd })),
  };
}

function sessionEntry(threadId, projectsDir) {
  // The Claude desktop app shows the same id with a `local_` prefix.
  const id = String(threadId ?? '').replace(/^local_/, '');
  if (!UUID.test(id)) throw new Error(`invalid Claude session id: ${JSON.stringify(threadId)}`);
  const entry = sessionFiles(projectsDir).find((candidate) => candidate.threadId === id);
  if (!entry) throw new Error(`no Claude session ${id} on this machine`);
  return { id, file: entry.file };
}

export function readClaudeSession({ threadId, turns, maxChars, projectsDir = claudeProjectsDir() }) {
  const { id, file } = sessionEntry(threadId, projectsDir);
  const session = loadSession(file);
  return {
    side: 'claude',
    threadId: id,
    title: session.title,
    updatedAt: session.updatedAt,
    cwd: session.cwd,
    turnsTotal: session.turns.length,
    turns: lastTurns(session.turns, turns).map((turn) => ({ startedAt: turn.startedAt, items: clipItems(turn.items, maxChars) })),
  };
}

// --- compact conversation ---

export function claudeConversation(records) {
  const turns = [];
  for (const record of records) {
    if (record.type !== 'user' && record.type !== 'assistant') continue;
    const content = record.message?.content;
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
    const text = blocks.filter(block => block?.type === 'text').map(block => block.text ?? '').join('\n');
    // Structured provenance wins. Old local command records lack it: recognize only complete
    // machine envelopes, not mentions of /compact or task notifications in ordinary prose.
    const context = record.isCompactSummary === true;
    const synthetic = record.isMeta || record.isSidechain || ['task-notification', 'peer'].includes(record.origin?.kind) ||
      record.turnOrigin === 'task_notification' ||
      /^<command-name>\/compact<\/command-name>(?:\s*<command-message>[\s\S]*<\/command-message>)?(?:\s*<command-args>[\s\S]*<\/command-args>)?\s*$/.test(text) ||
      /^<local-command-stdout>Compacted [\s\S]*<\/local-command-stdout>\s*$/.test(text);
    const omission = context ? 'context' : synthetic ? 'synthetic' : null;
    const items = blocks.flatMap(block => {
      if (!block || typeof block !== 'object') return [{ kind: 'unsupported', text: '', omission: 'privateOrUnsupported' }];
      if (block.type === 'text') return [{ kind: record.type === 'user' ? 'user' : 'assistant', text: String(block.text ?? ''), ...(omission ? { omission } : {}) }];
      const described = describeClaudeBlock(block);
      if (described) return [{ ...described, ...(omission ? { omission } : {}) }];
      if (block.type === 'tool_result') return [{ kind: 'tool-result', text: typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? ''), ...(omission ? { omission } : {}) }];
      // Never surface private reasoning, even with --tools; count its exclusion without text.
      return [{ kind: 'private', text: '', omission: 'privateOrUnsupported' }];
    });
    const startsTurn = record.type === 'user' && !blocks.some(block => block?.type === 'tool_result');
    if (startsTurn || turns.length === 0) turns.push({ startedAt: record.timestamp ?? null, items: [] });
    turns.at(-1).items.push(...items);
  }
  return turns;
}

export function readClaudeConversation({ threadId, projectsDir = claudeProjectsDir() }) {
  const { id, file } = sessionEntry(threadId, projectsDir);
  return { side: 'claude', threadId: id, turns: claudeConversation(sessionRecords(file)) };
}

// --- search inside messages ---

// Reads a session file line by line up to its first matching message, or to the end when the
// final title is needed. Limit: a title set after the match is not seen when reading stops.
// One assistant message is written as several records that share its message id, so their
// text is gathered before matching; tool calls and tool output are left out.
async function firstMatch(file, words, readToEnd) {
  const session = newSession();
  let match = null;
  let open = null; // the message being gathered: { key, kind, text, at }
  const close = () => {
    const found = !match && open && matchItem(open, words);
    if (found) match = { ...found, at: open.at };
    open = null;
  };
  const input = createReadStream(file, 'utf8');
  try {
    for await (const line of readline.createInterface({ input, crlfDelay: Infinity })) {
      const record = parseRecord(line);
      if (!record) continue;
      let said;
      try {
        said = foldClaudeRecord(session, record).filter((item) => item.kind === 'user' || item.kind === 'assistant');
      } catch {
        continue; // A record with damaged contents is skipped like a damaged line.
      }
      if (said.length === 0) continue;
      const key = record.message?.id ?? Symbol('one record');
      if (open?.key !== key) close();
      if (match && !readToEnd) break;
      const text = said.map((item) => item.text).join('\n');
      if (open) open.text += `\n${text}`;
      else open = { key, kind: said[0].kind, text, at: record.timestamp ?? null };
    }
    close();
  } finally {
    input.destroy();
  }
  return { session: finishSession(session), match };
}

export async function searchClaudeSessions({ search, text, limit, project, projectsDir = claudeProjectsDir(), bound = TEXT_SCAN }) {
  // A file that cannot be read, or is gone since the listing, is skipped and counted.
  let unreadable = 0;
  const files = sessionFiles(projectsDir)
    .flatMap((entry) => {
      try {
        return [{ ...entry, modified: statSync(entry.file).mtime }];
      } catch {
        unreadable += 1;
        return [];
      }
    })
    .sort((a, b) => b.modified - a.modified);
  const words = textWords(text);
  const needle = String(search ?? '').toLowerCase();
  const threads = [];
  let looked = 0;
  for (const { threadId, file, modified } of files.slice(0, bound)) {
    if (threads.length > limit) break;
    looked += 1;
    let session;
    let match;
    try {
      ({ session, match } = await firstMatch(file, words, Boolean(needle)));
    } catch {
      unreadable += 1;
      continue;
    }
    if (!match || !session.title.toLowerCase().includes(needle) || (project && !sameFolder(session.cwd, project))) continue;
    // The file's last change stands for when the chat was updated, since reading may stop early.
    threads.push({ threadId, title: session.title, updatedAt: modified.toISOString(), cwd: session.cwd, match });
  }
  const cut = looked === bound && files.length > bound ? `; the search stops at ${bound}, so ${files.length - bound} older ones were not searched` : '';
  return {
    side: 'claude',
    matchedOn: matchedOn({ search, text, project }),
    scope:
      `the ${looked} most recent of ${files.length} Claude Code session files on this machine` +
      `${unreadable ? `; ${unreadable} could not be read` : ''}${cut}`,
    more: threads.length > limit,
    threads: threads.slice(0, limit),
  };
}
