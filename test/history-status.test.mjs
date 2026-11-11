import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claudeConversation } from '../src/history/claude.mjs';
import { codexConversation, renderCodexThread } from '../src/history/codex.mjs';
import { renderConversation } from '../src/history/compact.mjs';

const turn = (status, text = 'answer') => ({ status, items: [{ type: 'agentMessage', text }] });
const bytes = result => Buffer.byteLength(`${JSON.stringify(result)}\n`);

test('compact and raw preserve statuses, qualifying only the newest interrupted Codex turn', () => {
  const thread = { id: 'status-fixture', turns: [turn('interrupted'), turn('completed'), turn('inProgress'), turn('failed'), turn(null), turn(undefined), turn('interrupted')] };
  const expected = ['interrupted', 'completed', 'inProgress', 'failed', null, null, 'interrupted, or still running'];
  assert.deepEqual(renderConversation(codexConversation(thread), { turns: 7 }).messages.map(item => item.status), expected);
  assert.deepEqual(renderCodexThread(thread, { turns: 7, maxChars: 4000 }).turns.map(item => item.status), expected);
});

test('fragment status stays on its snapshot after append, and older-window interrupted turns stay plain', () => {
  const thread = { id: 'status-fixture', turns: [turn('interrupted', 'old'), turn('interrupted', 'abcdefgh')] };
  let result = renderConversation(codexConversation(thread), { turns: 1, maxChars: 2, budget: 2048 });
  const firstCursor = result.nextCursor;
  thread.turns.push(turn('completed', 'new'));
  let restored = '';
  do {
    assert.ok(bytes(result) <= 2048);
    assert.equal(result.messages[0].status, 'interrupted, or still running');
    restored += result.messages[0].text;
    if (!result.nextCursor) break;
    result = renderConversation(codexConversation(thread), { cursor: result.nextCursor, maxChars: 2, budget: 2048 });
    assert.equal(result.omitted.outsideWindow.newerTurns, 1);
  } while (result);
  assert.equal(restored, 'abcdefgh');
  const older = renderConversation(codexConversation(thread), { cursor: result.olderCursor, budget: 2048 });
  assert.equal(older.messages[0].status, 'interrupted');
  assert.equal(older.messages[0].text, 'old');
  assert.ok(bytes(older) <= 2048);
  assert.deepEqual(renderConversation(codexConversation(thread), { turns: 3 }).messages.map(item => item.status), ['interrupted', 'interrupted', 'completed']);
  thread.turns[1].status = 'completed';
  assert.throws(() => renderConversation(codexConversation(thread), { cursor: firstCursor }), /history changed/);
});

test('a hidden newest Codex turn does not make the previous visible interrupted turn ambiguous', () => {
  const thread = { id: 'status-fixture', turns: [turn('interrupted'), { status: 'interrupted', items: [{ type: 'commandExecution', command: 'echo fixture' }] }] };
  const result = renderConversation(codexConversation(thread), { turns: 1 });
  assert.equal(result.messages[0].status, 'interrupted');
  assert.equal(result.omitted.filtered.tools.items, 1);
});

test('Claude fragments expose nullable status while raw control envelopes stay filtered', () => {
  for (const kind of ['task-notification', 'peer']) {
    const turns = claudeConversation([
      { type: 'user', origin: { kind }, message: { content: 'control envelope' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Quoted request and answer' }] } },
    ]);
    const source = { side: 'claude', threadId: 'status-fixture', turns };
    let cursor;
    let restored = '';
    do {
      const result = renderConversation(source, { maxChars: 3, budget: 2048, cursor });
      assert.equal(result.omitted.filtered.synthetic.items, 1);
      assert.ok(bytes(result) <= 2048);
      for (const item of result.messages) {
        assert.equal(item.kind, 'assistant');
        assert.equal(item.status, null);
        restored += item.text;
      }
      cursor = result.nextCursor;
    } while (cursor);
    assert.equal(restored, 'Quoted request and answer');
  }
});
