import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderConversation } from '../src/history/compact.mjs';

test('seeded histories reconstruct every visible item through bounded, scalar-safe pages', () => {
  let seed = 73129;
  const rand = (n) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  const scalars = ['a', '🙂', '"', '\\', '\n', 'é'];
  for (let trial = 0; trial < 40; trial += 1) {
    const turns = Array.from({ length: 1 + rand(8) }, () => ({
      items: Array.from({ length: 1 + rand(6) }, (_, item) => ({
        kind: item % 2 ? 'assistant' : 'user',
        text: Array.from({ length: rand(30) }, () => scalars[rand(scalars.length)]).join(''),
        ...(rand(7) === 0 ? { omission: 'synthetic' } : {}),
      })),
    }));
    const expected = new Map(turns.flatMap((turn, i) => turn.items.flatMap((item, j) => item.omission ? [] : [[`${i}:${j}`, item.text]])));
    const restored = new Map();
    const input = { side: 'claude', threadId: 'generated', turns };
    let cursor;
    let pages = 0;
    do {
      const result = renderConversation(input, { turns: 2, maxChars: trial % 4 === 0 ? 1 : 11, budget: 2048, cursor });
      assert.ok(Buffer.byteLength(`${JSON.stringify(result)}\n`) <= 2048);
      for (const item of result.messages) {
        const key = `${item.turn}:${item.item}`;
        assert.ok(expected.has(key));
        assert.equal(item.text.isWellFormed(), true);
        assert.equal((restored.get(key) ?? '').length, item.offset);
        if (item.totalTextUnits === 0) assert.equal(restored.has(key), false);
        restored.set(key, (restored.get(key) ?? '') + item.text);
      }
      cursor = result.nextCursor ?? result.olderCursor;
      pages += 1;
      assert.ok(pages < 10000);
    } while (cursor);
    assert.deepEqual([...restored].sort(), [...expected].sort());
  }
});
