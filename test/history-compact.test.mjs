import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claudeConversation, foldClaudeRecords } from '../src/history/claude.mjs';
import { codexConversation, renderCodexThread } from '../src/history/codex.mjs';
import { renderConversation, validateCompactOptions } from '../src/history/compact.mjs';

// Sections: classification/compatibility / budget and pagination / cursor validation.
const user = (text, extra = {}) => ({ type: 'user', message: { content: text }, ...extra });
const source = (turns) => ({ side: 'claude', threadId: 'fixture', turns });
const turn = (...items) => ({ items });
const text = (value, kind = 'user') => ({ kind, text: value });
const bytes = (result) => Buffer.byteLength(`${JSON.stringify(result)}\n`);

test('compact defaults reach conversation behind synthetic/compaction turns, with explicit counts', () => {
  const records = [user('question'), { type: 'assistant', message: { content: [{ type: 'text', text: 'answer' }, { type: 'tool_use', name: 'Read', input: { file_path: 'x' } }] } },
    user('summary', { isCompactSummary: true }), user('notification', { origin: { kind: 'task-notification' } }),
    user('<command-name>/compact</command-name>'), user('<local-command-stdout>Compacted context</local-command-stdout>')];
  const result = renderConversation(source(claudeConversation(records)), { turns: 1 });
  assert.deepEqual(result.messages.map(item => item.text), ['question', 'answer']);
  assert.deepEqual(result.omitted.filtered, { tools: { items: 1, textUnits: 7 }, context: { items: 1, textUnits: 7 }, synthetic: { items: 3, textUnits: 111 } });
  // Legacy folding still exposes exactly what it did before the compact CLI was added.
  assert.equal(foldClaudeRecords(records).turns.length, 5);
  assert.equal(foldClaudeRecords(records).turns[1].items[0].text, 'summary');
});

test('ordinary prose mentioning envelopes stays visible; tool opt-in never reveals reasoning', () => {
  const records = [user('Discuss <task-notification> and /compact here.'), { type: 'assistant', message: { content: [
    { type: 'tool_use', name: 'Read', input: {} }, { type: 'thinking', thinking: 'private' }, { type: 'text', text: 'done' },
  ] } }, user([{ type: 'tool_result', content: 'tool output' }])];
  const compact = source(claudeConversation(records));
  assert.deepEqual(renderConversation(compact).messages.map(item => item.kind), ['user', 'assistant']);
  const tools = renderConversation(compact, { tools: true });
  assert.deepEqual(tools.messages.map(item => item.kind), ['user', 'tool', 'assistant', 'tool-result']);
  assert.equal(JSON.stringify(tools).includes('private"'), false);
  assert.deepEqual(tools.omitted.filtered.privateOrUnsupported, { items: 1, textUnits: 0 });
});

test('damaged Claude content blocks are counted and do not discard adjacent conversation', () => {
  const input = source(claudeConversation([user([null, { type: 'text', text: 'still visible' }, 4])]));
  const result = renderConversation(input);
  assert.equal(result.messages[0].text, 'still visible');
  assert.equal(result.omitted.filtered.privateOrUnsupported.items, 2);
});

test('Codex compact tool filtering leaves the legacy renderer unchanged', () => {
  const thread = { id: 'thread', turns: [{ items: [{ type: 'userMessage', content: [{ type: 'text', text: 'hi' }] }, { type: 'commandExecution', command: 'echo hi' }, { type: 'reasoning' }, { type: 'agentMessage', text: 'done' }] }] };
  assert.deepEqual(renderConversation(codexConversation(thread)).messages.map(item => item.text), ['hi', 'done']);
  assert.deepEqual(renderCodexThread(thread, { turns: 2, maxChars: 4000 }).turns[0].items.map(item => item.kind), ['user', 'command', 'assistant']);
});

test('whole serialized output is bounded and cursor pages recover long escaped Unicode text losslessly', () => {
  const original = '🙂\\"\n'.repeat(1200);
  const input = source([turn(text(original), text('last', 'assistant'))]);
  let cursor;
  let restored = '';
  let pages = 0;
  do {
    const result = renderConversation(input, { budget: 2048, maxChars: 5000, cursor });
    assert.ok(bytes(result) <= 2048, `${bytes(result)} bytes`);
    assert.ok(result.messages.length > 0);
    for (const item of result.messages) assert.equal(item.text.isWellFormed(), true);
    restored += result.messages.map(item => item.text).join('');
    cursor = result.nextCursor;
    pages += 1;
    assert.ok(pages < 100);
  } while (cursor);
  assert.equal(restored, `${original}last`);
  assert.ok(pages > 1);
});

test('a one-unit fragment preserves supplementary Unicode scalars and chronology', () => {
  const input = source([{ startedAt: '2026-01-01T00:00:00Z', items: [text('🙂x')] }]);
  const first = renderConversation(input, { maxChars: 1 });
  assert.equal(first.messages[0].text, '🙂');
  assert.equal(first.messages[0].startedAt, '2026-01-01T00:00:00Z');
  assert.equal(renderConversation(input, { cursor: first.nextCursor }).messages[0].text, 'x');
  const cursor = JSON.parse(Buffer.from(first.nextCursor, 'base64url').toString());
  cursor.offset = 1;
  assert.throws(() => renderConversation(input, { cursor: Buffer.from(JSON.stringify(cursor)).toString('base64url') }), /scalar boundary/);
});

test('many tiny and empty messages cannot overflow the envelope budget or lose entries', () => {
  const input = source([turn(...Array.from({ length: 100 }, (_, i) => text(i % 2 ? '' : 'x')))]);
  let cursor;
  const seen = [];
  do {
    const result = renderConversation(input, { budget: 2048, cursor });
    assert.ok(bytes(result) <= 2048);
    seen.push(...result.messages.map(item => item.item));
    cursor = result.nextCursor;
  } while (cursor);
  assert.deepEqual(seen, Array.from({ length: 100 }, (_, i) => i));
});

test('fragment limits, window and before/after omission counts are exact', () => {
  const input = source([turn(text('old')), turn(text('abcdef'), text('tool', 'tool'))]);
  const first = renderConversation(input, { turns: 1, maxChars: 2 });
  assert.equal(first.messages[0].text, 'ab');
  assert.deepEqual(first.omitted.outsideWindow, { items: 1, textUnits: 3, olderTurns: 1, newerTurns: 0 });
  assert.deepEqual(first.omitted.afterPage, { items: 1, textUnits: 4 });
  assert.equal(first.omitted.splitItems, 1);
  const second = renderConversation(input, { maxChars: 2, cursor: first.nextCursor });
  assert.equal(second.messages[0].text, 'cd');
  assert.deepEqual(second.omitted.beforePage, { items: 1, textUnits: 2 });
  assert.deepEqual(second.omitted.afterPage, { items: 1, textUnits: 2 });
});

test('empty or hidden-only history completes explicitly without a cursor', () => {
  assert.equal(renderConversation(source([])).nextCursor, null);
  const result = renderConversation(source([turn({ ...text('hidden'), omission: 'synthetic' })]));
  assert.deepEqual(result.messages, []);
  assert.equal(result.omitted.filtered.synthetic.items, 1);
  assert.equal(result.nextCursor, null);
});

test('cursor stays on its snapshot when new turns append, and rejects history edits', () => {
  const input = source([turn(text('abcd'))]);
  const cursor = renderConversation(input, { maxChars: 2 }).nextCursor;
  input.turns.push(turn(text('new')));
  const next = renderConversation(input, { cursor });
  assert.equal(next.messages[0].text, 'cd');
  assert.equal(next.omitted.outsideWindow.newerTurns, 1);
  input.turns[0].items[0].text = 'changed';
  assert.throws(() => renderConversation(input, { cursor }), /history changed/);
});

test('older cursors traverse preceding windows without gaps or duplicates, after finishing fragments', () => {
  const input = source([turn(text('first')), turn({ ...text('hidden'), omission: 'synthetic' }),
    turn(text('second')), turn(text('third')), turn(text('fourth')), turn(text('fifth'))]);
  let options = { turns: 2, maxChars: 2, budget: 2048 };
  const windows = [];
  do {
    const messages = [];
    let result;
    do {
      result = renderConversation(input, options);
      assert.ok(bytes(result) <= 2048);
      messages.push(...result.messages);
      if (result.nextCursor) assert.equal(result.olderCursor, null);
      options = { ...options, cursor: result.nextCursor };
    } while (result.nextCursor);
    windows.push(messages.map(item => item.text).join(''));
    options = { ...options, cursor: result.olderCursor };
  } while (options.cursor);
  assert.deepEqual(windows, ['fourthfifth', 'secondthird', 'first']);
});

test('outside cursor inputs reject malformed, wrong-scope and unsafe positions', () => {
  const input = source([turn(text('abcd'))]);
  const cursor = renderConversation(input, { maxChars: 2 }).nextCursor;
  assert.throws(() => renderConversation({ ...input, threadId: 'other' }, { cursor }), /another thread/);
  assert.throws(() => renderConversation(input, { cursor, tools: true }), /--tools/);
  const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString());
  for (const changed of [{ index: -1 }, { offset: 99 }, { start: 9 }, { end: 99 }, { snapshotEnd: -1 }, { snapshotEnd: 0 }, { snapshotEnd: 99 }, { snapshotEnd: 0.5 }, { snapshotEnd: Number.MAX_SAFE_INTEGER + 1 }, { offset: 0.5 }, { index: Number.MAX_SAFE_INTEGER + 1 }, { v: 1 }, { extra: true }]) {
    const bad = Buffer.from(JSON.stringify({ ...decoded, ...changed })).toString('base64url');
    assert.throws(() => renderConversation(input, { cursor: bad }), /cursor|history changed/);
  }
  for (const bad of ['', '../x', 'e30', 'a'.repeat(2049)]) assert.throws(() => validateCompactOptions({ cursor: bad }), /cursor/);
  for (const budget of [0, 2047, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => validateCompactOptions({ budget }), /budget/);
});
