import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { searchClaudeSessions } from '../src/history/claude.mjs';
import { firstCodexMatch, searchCodexThreads } from '../src/history/codex.mjs';
import { findThreads } from '../src/history/index.mjs';
import { matchItem, textWords } from '../src/history/match.mjs';
import { excerpt } from '../src/history/render.mjs';

// --- matching one message ---

test('a message matches when it holds all the words, in any order and any case', () => {
  const said = { kind: 'assistant', text: 'The Deploy failed because the TOKEN expired.' };
  assert.equal(matchItem(said, textWords('token DEPLOY'))?.by, 'assistant');
  assert.equal(matchItem(said, textWords('token rollback')), null);
});

test('tool output and commands do not match, only what the person and the assistant wrote', () => {
  const words = textWords('secret banana');
  assert.equal(matchItem({ kind: 'tool', text: 'Bash: echo secret banana' }, words), null);
  assert.equal(matchItem({ kind: 'command', text: 'grep secret banana' }, words), null);
  assert.equal(matchItem({ kind: 'user', text: 'is the secret banana ripe?' }, words)?.by, 'user');
});

test('the excerpt is one line of about 160 characters around the first word found', () => {
  const text = `${'a'.repeat(300)}\n\nthe purple  heron\n${'b'.repeat(300)}`;
  const found = matchItem({ kind: 'user', text }, textWords('heron purple'));
  assert.doesNotMatch(found.excerpt, /\n/);
  assert.match(found.excerpt, /^\.\.\.a+ the purple heron b+\.\.\.$/);
  // 160 characters of text plus an ellipsis at each end.
  assert.equal(found.excerpt.length, 166);
  assert.equal(excerpt('short text', 0), 'short text');
});

// --- Claude ---

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const ID_C = '33333333-3333-4333-8333-333333333333';
const user = (content, extra = {}) => ({ type: 'user', timestamp: '2026-11-10T10:00:00Z', cwd: '/work/app', message: { content }, ...extra });
const assistant = (text, extra = {}) => ({ type: 'assistant', timestamp: '2026-11-10T10:00:05Z', message: { content: [{ type: 'text', text }] }, ...extra });

// Sessions are written oldest first, each a minute newer than the one before.
function projectsDirWith(sessions) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nomeat-claude-text-'));
  mkdirSync(path.join(dir, 'project-x'));
  Object.entries(sessions).forEach(([id, lines], index) => {
    const file = path.join(dir, 'project-x', `${id}.jsonl`);
    writeFileSync(file, `${lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n')}\n`);
    const when = new Date(Date.UTC(2026, 10, 10, 12, index));
    utimesSync(file, when, when);
  });
  return dir;
}

test('a Claude search says who said the match, when, and that it matched on text', async () => {
  const projectsDir = projectsDirWith({ [ID_A]: [user('How do I rotate the keys?'), assistant('Rotate the signing keys with the admin tool.')] });
  const found = await searchClaudeSessions({ text: 'signing ROTATE', limit: 5, projectsDir });
  assert.equal(found.matchedOn, 'text');
  assert.deepEqual(found.threads, [
    {
      threadId: ID_A,
      title: 'How do I rotate the keys?',
      updatedAt: '2026-11-10T12:00:00.000Z',
      cwd: '/work/app',
      match: { by: 'assistant', excerpt: 'Rotate the signing keys with the admin tool.', at: '2026-11-10T10:00:05Z' },
    },
  ]);
});

test('a Claude search ignores tool results and finds nothing when a word is missing', async () => {
  const projectsDir = projectsDirWith({
    [ID_A]: [user('list the files'), user([{ type: 'tool_result', content: 'zebra notes.txt' }]), assistant('Done.')],
  });
  assert.deepEqual((await searchClaudeSessions({ text: 'zebra', limit: 5, projectsDir })).threads, []);
  assert.deepEqual((await searchClaudeSessions({ text: 'list files missing', limit: 5, projectsDir })).threads, []);
});

test('damaged lines in a Claude file do not stop the search', async () => {
  const projectsDir = projectsDirWith({ [ID_A]: [user('first question'), '{"torn', 'null', '42', '[1,2]', '{"type":"user","message":{"content":[null]}}', '{"type":"assistant","message":{"content":[null]}}', assistant('the walrus answer')] });
  const found = await searchClaudeSessions({ text: 'walrus', limit: 5, projectsDir });
  assert.deepEqual(found.threads.map((thread) => thread.threadId), [ID_A]);
});

test('words over two text records of one Claude message match, over two messages they do not', async () => {
  const part = (id, text) => assistant(text, { message: { id, content: [{ type: 'text', text }] } });
  const projectsDir = projectsDirWith({
    [ID_A]: [user('describe the bird'), part('msg-1', 'It is purple.'), part('msg-1', 'It is a heron.')],
    [ID_B]: [user('describe the bird'), part('msg-2', 'It is purple.'), part('msg-3', 'It is a heron.')],
  });
  const found = await searchClaudeSessions({ text: 'purple heron', limit: 5, projectsDir });
  assert.deepEqual(found.threads.map((thread) => thread.threadId), [ID_A]);
  assert.equal(found.threads[0].match.excerpt, 'It is purple. It is a heron.');
});

test('a Claude file that cannot be read is skipped and counted, and the others are still searched', async () => {
  const projectsDir = projectsDirWith({ [ID_A]: [user('the quince list')], [ID_C]: [user('another quince')] });
  // A folder with a session file's name lists like a session but cannot be read as one.
  mkdirSync(path.join(projectsDir, 'project-x', `${ID_B}.jsonl`));
  const found = await searchClaudeSessions({ text: 'quince', limit: 5, projectsDir });
  assert.deepEqual(found.threads.map((thread) => thread.threadId).sort(), [ID_A, ID_C]);
  assert.match(found.scope, /^the 3 most recent of 3 Claude Code session files on this machine; 1 could not be read$/);
});

test('a Claude search keeps to the project folder, the limit and the title words', async () => {
  const projectsDir = projectsDirWith({
    [ID_A]: [user('Notes on lemon cake')],
    [ID_B]: [user('lemon tart', { cwd: '/work/other' })],
    [ID_C]: [user('Plan the lemon order')],
  });
  const inProject = await searchClaudeSessions({ text: 'lemon', limit: 5, project: '/work/app', projectsDir });
  assert.deepEqual(inProject.threads.map((thread) => thread.threadId), [ID_C, ID_A]);
  assert.equal(inProject.matchedOn, 'text, within the project folder');
  const limited = await searchClaudeSessions({ text: 'lemon', limit: 1, projectsDir });
  assert.deepEqual(limited.threads.map((thread) => thread.threadId), [ID_C]);
  assert.equal(limited.more, true);
  const titled = await searchClaudeSessions({ search: 'cake', text: 'lemon', limit: 5, projectsDir });
  assert.deepEqual(titled.threads.map((thread) => thread.threadId), [ID_A]);
  assert.equal(titled.matchedOn, 'title and text');
});

test('a Claude search looks through the most recent files only, and its scope says so', async () => {
  const projectsDir = projectsDirWith({ [ID_A]: [user('old kiwi')], [ID_B]: [user('plain')], [ID_C]: [user('new kiwi')] });
  const found = await searchClaudeSessions({ text: 'kiwi', limit: 5, projectsDir, bound: 2 });
  assert.deepEqual(found.threads.map((thread) => thread.threadId), [ID_C]);
  assert.equal(found.scope, 'the 2 most recent of 3 Claude Code session files on this machine; the search stops at 2, so 1 older ones were not searched');
  const whole = await searchClaudeSessions({ text: 'kiwi', limit: 5, projectsDir });
  assert.equal(whole.scope, 'the 3 most recent of 3 Claude Code session files on this machine');
});

// --- Codex ---

const codexThread = (id, cwd, ...items) => ({ id, name: `thread ${id}`, cwd, updatedAt: 1794321336, turns: [{ startedAt: 1794321336, items }] });

// A stand-in for the Codex server that serves the given threads, newest first.
function fakeServer(threads, { nextCursor = null, listed = threads } = {}) {
  const client = {
    request: async (method, params) => {
      if (method === 'thread/list') return { data: listed.slice(0, params.limit), nextCursor };
      const thread = threads.find((candidate) => candidate.id === params.threadId);
      if (!thread) throw new Error('no such thread');
      return { thread };
    },
  };
  return { server: (work) => work(client) };
}

test('a Codex match skips commands and gives who said it and when', () => {
  const thread = codexThread('t1', '/work', { type: 'commandExecution', command: 'grep otter' }, { type: 'userMessage', content: [{ type: 'text', text: 'where is the otter?' }] });
  // 1794321336 s after the Unix epoch is 2026-11-10T14:35:36Z.
  assert.deepEqual(firstCodexMatch(thread, textWords('OTTER')), { by: 'user', excerpt: 'where is the otter?', at: '2026-11-10T14:35:36.000Z' });
  assert.equal(firstCodexMatch(thread, textWords('grep')), null);
});

test('a Codex search keeps to the folder and limit, and states its scope', async () => {
  const said = (text) => ({ type: 'agentMessage', text });
  const fake = fakeServer(
    [codexThread('a', '/work/app', said('mango one')), codexThread('b', '/work/other', said('mango two')), codexThread('c', '/work/app', said('mango three'))],
    { nextCursor: 'more' },
  );
  const found = await searchCodexThreads({ text: 'mango', limit: 5, project: '/work/app', bound: 3, server: fake.server });
  assert.deepEqual(found.threads.map((thread) => thread.threadId), ['a', 'c']);
  assert.equal(found.matchedOn, 'text, within the project folder');
  assert.equal(
    found.scope,
    'the 2 threads in the project folder among the 3 most recent threads the Codex app lists (interactive sources, not archived); threads older than the 3 listed were not searched',
  );
  const limited = await searchCodexThreads({ text: 'mango', limit: 1, bound: 3, server: fake.server });
  assert.deepEqual(limited.threads.map((thread) => thread.threadId), ['a']);
  assert.equal(limited.more, true);
});

test('a Codex thread that cannot be read is counted instead of stopping the search', async () => {
  const thread = codexThread('a', '/work', { type: 'agentMessage', text: 'pear' });
  const fake = fakeServer([thread], { listed: [{ id: 'gone', cwd: '/work' }, thread] });
  const found = await searchCodexThreads({ text: 'pear', limit: 5, server: fake.server });
  assert.deepEqual(found.threads.map((thread) => thread.threadId), ['a']);
  assert.match(found.scope, /; 1 of them could not be read$/);
});

test('with a project, a Codex search lists beyond the bound and still reads at most the bound', async () => {
  const said = (text) => ({ type: 'agentMessage', text });
  const others = Array.from({ length: 25 }, (_, index) => codexThread(`o${index}`, '/work/other', said('fig')));
  const mine = [1, 2, 3].map((index) => codexThread(`p${index}`, '/work/app', said(index === 3 ? 'fig' : 'plain')));
  const fake = fakeServer([...others, ...mine]);
  const reads = [];
  const server = (work) => fake.server((client) => work({ request: (method, params) => (method === 'thread/read' && reads.push(params.threadId), client.request(method, params)) }));
  const found = await searchCodexThreads({ text: 'fig', limit: 5, project: '/work/app', bound: 2, server });
  // The project's threads sit beyond the 25 newest; only the first two of them are read.
  assert.deepEqual(reads, ['p1', 'p2']);
  assert.deepEqual(found.threads, []);
  assert.equal(
    found.scope,
    'the 2 threads in the project folder among the 28 most recent threads the Codex app lists (interactive sources, not archived); the search reads at most 2 threads, so older ones in the project folder were not searched',
  );
  const wider = await searchCodexThreads({ text: 'fig', limit: 5, project: '/work/app', server: fake.server });
  assert.deepEqual(wider.threads.map((thread) => thread.threadId), ['p3']);
});

// --- usage ---

test('an empty or blank --text is a usage error', async () => {
  const cli = fileURLToPath(new URL('../bin/nomeat.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [cli, 'find', '--side', 'claude', '--text', '   '], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--text is empty/);
  await assert.rejects(findThreads({ side: 'claude', text: '' }), /--text is empty/);
});
