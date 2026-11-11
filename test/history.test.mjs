import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { describeClaudeBlock, findClaudeSessions, foldClaudeRecords, readClaudeSession } from '../src/history/claude.mjs';
import { describeCodexItem, renderCodexThread, summarizeCodexThread, threadsInFolder } from '../src/history/codex.mjs';
import { sameFolder } from '../src/history/folder.mjs';
import { findThreads, readThread } from '../src/history/index.mjs';
import { clip, firstLine } from '../src/history/render.mjs';

// --- shared shaping ---

test('clip keeps short text and marks what it cut from long text', () => {
  assert.equal(clip('abc', 5), 'abc');
  assert.equal(clip('abcdefgh', 5), 'abcde\n[cut: 3 more characters; raise --max-chars to read them]');
});

test('firstLine skips leading blank lines', () => {
  assert.equal(firstLine('\n  \n  Deploy the site  \nmore'), 'Deploy the site');
});

// --- Codex ---

test('Codex items are described by what happened', () => {
  assert.deepEqual(describeCodexItem({ type: 'userMessage', content: [{ type: 'text', text: 'hi' }, { type: 'image' }] }), { kind: 'user', text: 'hi' });
  assert.deepEqual(describeCodexItem({ type: 'agentMessage', text: 'done' }), { kind: 'assistant', text: 'done' });
  assert.deepEqual(describeCodexItem({ type: 'commandExecution', command: 'npm test', exitCode: 1 }), { kind: 'command', text: 'npm test (exit 1)' });
  assert.deepEqual(describeCodexItem({ type: 'fileChange', changes: [{ path: 'a.js' }, { path: 'b.js' }] }), { kind: 'file-change', text: 'a.js\nb.js' });
  assert.deepEqual(describeCodexItem({ type: 'imageView', path: 'x.png' }), { kind: 'imageView', text: '' });
});

test('a command still running has no exit code in its description', () => {
  assert.deepEqual(describeCodexItem({ type: 'commandExecution', command: 'npm run dev', exitCode: null }), { kind: 'command', text: 'npm run dev' });
});

test('Codex private reasoning is not surfaced', () => {
  assert.equal(describeCodexItem({ type: 'reasoning', summary: ['thinking'] }), null);
});

test('a Codex thread falls back to its first message when it has no name', () => {
  // 1794321336 s after the Unix epoch is 2026-11-10T14:35:36Z.
  const summary = summarizeCodexThread({ id: 't1', name: null, preview: 'Move the site\nto Vercel', updatedAt: 1794321336, cwd: '/work' });
  assert.deepEqual(summary, { threadId: 't1', title: 'Move the site', updatedAt: '2026-11-10T14:35:36.000Z', cwd: '/work' });
});

test('the newest Codex turn shown as interrupted is worded as possibly still running; older ones are not', () => {
  // Seen live: read from outside, a running turn says `interrupted` until it completes.
  const turn = (status) => ({ startedAt: 1794321336, status, items: [] });
  const statuses = (all) => renderCodexThread({ id: 't1', turns: all }, { turns: 5, maxChars: 100 }).turns.map((entry) => entry.status);
  assert.deepEqual(statuses([turn('interrupted'), turn('completed'), turn('interrupted')]), ['interrupted', 'completed', 'interrupted, or still running']);
  assert.deepEqual(statuses([turn('completed'), turn('inProgress')]), ['completed', 'inProgress']);
});

test('reading a Codex thread returns only the last turns asked for, clipped', () => {
  const turn = (text) => ({ startedAt: 1794321336, status: 'completed', items: [{ type: 'agentMessage', text }, { type: 'reasoning' }] });
  const rendered = renderCodexThread({ id: 't1', name: 'Site', updatedAt: 1794321336, turns: [turn('one'), turn('two'), turn('abcdefgh')] }, { turns: 2, maxChars: 5 });
  assert.equal(rendered.turnsTotal, 3);
  assert.deepEqual(rendered.turns.map((entry) => entry.items.length), [1, 1]);
  assert.equal(rendered.turns[0].items[0].text, 'two');
  assert.match(rendered.turns[1].items[0].text, /^abcde\n\[cut: 3 more/);
});

// --- Claude ---

const user = (content, extra = {}) => ({ type: 'user', timestamp: '2026-11-10T10:00:00Z', cwd: '/work', message: { content }, ...extra });
const assistant = (content, extra = {}) => ({ type: 'assistant', timestamp: '2026-11-10T10:00:05Z', message: { content }, ...extra });

test('Claude tool use is described with its command or file', () => {
  assert.deepEqual(describeClaudeBlock({ type: 'tool_use', name: 'Bash', input: { command: 'git status' } }), { kind: 'tool', text: 'Bash: git status' });
  assert.deepEqual(describeClaudeBlock({ type: 'tool_use', name: 'Edit', input: { file_path: 'a.js' } }), { kind: 'tool', text: 'Edit: a.js' });
  assert.deepEqual(describeClaudeBlock({ type: 'tool_use', name: 'TodoList', input: {} }), { kind: 'tool', text: 'TodoList' });
  assert.equal(describeClaudeBlock({ type: 'thinking', thinking: 'private' }), null);
});

test('a Claude session splits into turns at what the user typed', () => {
  const session = foldClaudeRecords([
    user('first question'),
    assistant([{ type: 'thinking', thinking: 'x' }, { type: 'tool_use', name: 'Bash', input: { command: 'ls' } }]),
    user([{ type: 'tool_result', content: 'files' }]),
    assistant([{ type: 'text', text: 'answer one' }]),
    user([{ type: 'text', text: 'second question' }], { timestamp: '2026-11-10T11:00:00Z' }),
    assistant([{ type: 'text', text: 'answer two' }], { timestamp: '2026-11-10T11:00:09Z' }),
  ]);
  assert.equal(session.turns.length, 2);
  assert.deepEqual(session.turns[0].items, [
    { kind: 'user', text: 'first question' },
    { kind: 'tool', text: 'Bash: ls' },
    { kind: 'assistant', text: 'answer one' },
  ]);
  assert.equal(session.turns[1].items[0].text, 'second question');
  assert.equal(session.updatedAt, '2026-11-10T11:00:09Z');
  assert.equal(session.cwd, '/work');
});

test('injected and side-conversation records do not start turns', () => {
  const session = foldClaudeRecords([
    user('injected', { isMeta: true }),
    user('subagent prompt', { isSidechain: true }),
    assistant([{ type: 'text', text: 'orphan' }]),
  ]);
  assert.deepEqual(session.turns, []);
});

test('the last custom title wins, and the first prompt is the fallback', () => {
  const titled = foldClaudeRecords([user('hello there'), { type: 'custom-title', customTitle: 'Draft' }, { type: 'custom-title', customTitle: 'Final' }]);
  assert.equal(titled.title, 'Final');
  assert.equal(foldClaudeRecords([user('hello there\nmore')]).title, 'hello there');
});

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';

function projectsDirWith(sessions) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nomeat-claude-'));
  mkdirSync(path.join(dir, 'project-x'));
  for (const [id, records] of Object.entries(sessions)) {
    writeFileSync(path.join(dir, 'project-x', `${id}.jsonl`), `${records.map((record) => JSON.stringify(record)).join('\n')}\n{"torn`);
  }
  writeFileSync(path.join(dir, 'project-x', 'notes.jsonl'), '{}');
  return dir;
}

test('finding Claude sessions matches titles without regard to case, newest first', () => {
  const projectsDir = projectsDirWith({
    [ID_A]: [user('Deploy the SITE'), assistant([{ type: 'text', text: 'ok' }], { timestamp: '2026-11-09T09:00:00Z' })],
    [ID_B]: [user('site cleanup', { timestamp: '2026-11-10T12:00:00Z' })],
  });
  const found = findClaudeSessions({ search: 'site', limit: 5, projectsDir });
  assert.deepEqual(found.threads.map((thread) => thread.threadId), [ID_B, ID_A]);
  assert.equal(found.matchedOn, 'title');
  assert.equal(found.scope, '2 Claude Code session files on this machine');
  assert.equal(found.more, false);
});

test('limiting to a project folder finds a chat whose title does not mention the project', () => {
  const projectsDir = projectsDirWith({
    [ID_A]: [user('ChatGPT and Claude interoperability', { cwd: '/work/app' })],
    [ID_B]: [user('Bridge notes for app', { cwd: '/work/other' })],
  });
  // The folder may be written with a trailing slash by one tool and without by another.
  const found = findClaudeSessions({ search: '', limit: 5, project: '/work/app/', projectsDir });
  assert.deepEqual(found.threads.map((thread) => thread.threadId), [ID_A]);
  assert.equal(found.matchedOn, 'title, within the project folder');
  assert.deepEqual(findClaudeSessions({ search: 'bridge', limit: 5, project: '/work/app', projectsDir }).threads, []);
});

test('two spellings of one folder compare equal: either slash, a trailing slash, and letter case on Windows only', () => {
  assert.equal(sameFolder('D:\\Work\\App', 'd:/work/app/', 'win32'), true);
  assert.equal(sameFolder('/work/App', '/work/app', 'linux'), false);
  assert.equal(sameFolder('/work/app/', '/work/app', 'linux'), true);
  assert.equal(sameFolder('/work/app', '/work/app-two', 'linux'), false);
  // Outside Windows a backslash is part of a name, not a separator.
  assert.equal(sameFolder('/work/a\\b', '/work/a/b', 'linux'), false);
  assert.equal(sameFolder('/work/a\\b/', '/work/a\\b', 'linux'), true);
  // A thread with no recorded folder belongs to no project.
  assert.equal(sameFolder(null, '/work/app', 'linux'), false);
});

test('Codex threads are limited to a folder only when one is asked for', () => {
  const threads = [{ threadId: 'a', cwd: '/work/app' }, { threadId: 'b', cwd: '/work/other' }, { threadId: 'c', cwd: null }];
  assert.deepEqual(threadsInFolder(threads, '/work/app').map((thread) => thread.threadId), ['a']);
  assert.equal(threadsInFolder(threads, undefined).length, 3);
});

test('a search that matches more than the limit says so', () => {
  const projectsDir = projectsDirWith({ [ID_A]: [user('site one')], [ID_B]: [user('site two')] });
  const found = findClaudeSessions({ search: 'site', limit: 1, projectsDir });
  assert.equal(found.threads.length, 1);
  assert.equal(found.more, true);
});

test('reading a Claude session accepts the id as the desktop app shows it', () => {
  const projectsDir = projectsDirWith({ [ID_A]: [user('one'), user('two'), user('three')] });
  const session = readClaudeSession({ threadId: `local_${ID_A}`, turns: 2, maxChars: 100, projectsDir });
  assert.equal(session.threadId, ID_A);
  assert.equal(session.turnsTotal, 3);
  assert.deepEqual(session.turns.map((turn) => turn.items[0].text), ['two', 'three']);
});

test('reading rejects an id that is not a session id, and one that does not exist', () => {
  const projectsDir = projectsDirWith({});
  assert.throws(() => readClaudeSession({ threadId: '../secrets', turns: 1, maxChars: 10, projectsDir }), /invalid Claude session id/);
  assert.throws(() => readClaudeSession({ threadId: ID_A, turns: 1, maxChars: 10, projectsDir }), /no Claude session/);
});

// --- side selection ---

test('an unknown side is rejected by name', async () => {
  await assert.rejects(findThreads({ side: 'gemini' }), /--side must be one of: codex, claude/);
  await assert.rejects(readThread({ side: 'claude' }), /--thread is required/);
});
