// Compact conversation pages. Sections: validation/cursors / selection / byte-budgeted pages.
// The legacy renderers remain unchanged; only the CLI opts into this view.
import { createHash } from 'node:crypto';
import { shownStatus } from './codex.mjs';

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const size = (value) => Buffer.byteLength(JSON.stringify(value)) + 1; // includes CLI newline
const stats = (items) => ({ items: items.length, textUnits: items.reduce((sum, item) => sum + item.text.length, 0) });
const integer = (n) => Number.isSafeInteger(n) && n >= 0;
const splitsScalar = (value, at) => at > 0 && at < value.length &&
  value.charCodeAt(at - 1) >= 0xd800 && value.charCodeAt(at - 1) <= 0xdbff &&
  value.charCodeAt(at) >= 0xdc00 && value.charCodeAt(at) <= 0xdfff;

export function validateCompactOptions({ turns = 2, maxChars = 4000, budget = 16000, cursor } = {}) {
  for (const [name, value] of Object.entries({ turns, 'max-chars': maxChars, budget })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`--${name} must be a positive safe integer`);
  }
  if (budget < 2048) throw new Error('--budget must be at least 2048 UTF-8 bytes');
  if (cursor !== undefined && (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]{1,2048}$/.test(cursor))) throw new Error('invalid read cursor');
  if (cursor !== undefined) decodeCursor(cursor);
}

function decodeCursor(cursor) {
  try {
    const page = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!page || Object.keys(page).sort().join(',') !== 'end,hash,index,offset,scope,snapshotEnd,start,tools,v' ||
        page.v !== 2 || typeof page.tools !== 'boolean' || !/^[a-f0-9]{64}$/.test(page.scope) ||
        !/^[a-f0-9]{64}$/.test(page.hash) || ![page.start, page.end, page.snapshotEnd, page.index, page.offset].every(integer)) throw new Error();
    return page;
  } catch {
    throw new Error('invalid read cursor');
  }
}

function reason(item, tools) {
  if (item.omission) return item.omission;
  if (item.kind === 'user' || item.kind === 'assistant') return null;
  return tools ? null : 'tools';
}

export function renderConversation(source, { turns = 2, maxChars = 4000, budget = 16000, tools = false, cursor } = {}) {
  validateCompactOptions({ turns, maxChars, budget, cursor });
  const scope = hash([source.side, source.threadId]);
  const all = source.turns ?? [];
  let page = cursor ? decodeCursor(cursor) : null;
  if (page && (page.scope !== scope || page.tools !== tools)) throw new Error('read cursor belongs to another thread, side or --tools view');
  const end = page?.end ?? all.length;
  const snapshotEnd = page?.snapshotEnd ?? all.length;
  if (end > snapshotEnd) throw new Error('invalid read cursor snapshot');
  if (snapshotEnd > all.length) throw new Error('history changed; restart read without --cursor');
  // Hidden-only turns do not consume --turns, so notifications cannot crowd out discussion.
  const visible = all.slice(0, end).flatMap((turn, index) => turn.items.some(item => !reason(item, tools)) ? [index] : []);
  const start = page?.start ?? visible[Math.max(0, visible.length - turns)] ?? 0;
  if (start > end) throw new Error('invalid read cursor window');
  const window = all.slice(start, end);
  const digest = hash(window);
  if (page && page.hash !== digest) throw new Error('history changed; restart read without --cursor');
  const entries = [];
  const filtered = {};
  window.forEach((turn, turnIndex) => turn.items.forEach((item, itemIndex) => {
    const omitted = reason(item, tools);
    if (omitted) {
      const count = filtered[omitted] ??= { items: 0, textUnits: 0 };
      count.items += 1;
      count.textUnits += item.text.length;
    } else entries.push({ turn: start + turnIndex, item: itemIndex, startedAt: turn.startedAt ?? null,
      // Raw statuses stay in the digest; presentation uses the saved whole-thread newest
      // turn, not this window's end or a newer append, so cursors remain stable.
      status: source.side === 'codex' ? shownStatus(turn.status, start + turnIndex === snapshotEnd - 1) : turn.status ?? null,
      kind: item.kind, text: item.text });
  }));
  const index = page?.index ?? 0;
  const offset = page?.offset ?? 0;
  if (index > entries.length || (index === entries.length ? offset !== 0 : offset > entries[index].text.length)) throw new Error('invalid read cursor position');
  if (index < entries.length && splitsScalar(entries[index].text, offset)) throw new Error('invalid read cursor scalar boundary');
  const outside = [...all.slice(0, start), ...all.slice(end)].flatMap(turn => turn.items);
  const before = stats(entries.slice(0, index));
  before.textUnits += offset;
  if (offset > 0) before.items += 1;
  const olderVisible = visible.filter(i => i < start);
  const count = visible.filter(i => i >= start).length;
  const olderStart = olderVisible[Math.max(0, olderVisible.length - count)] ?? 0;
  const olderCursor = olderVisible.length === 0 ? null : Buffer.from(JSON.stringify({
    v: 2, scope, hash: hash(all.slice(olderStart, start)), tools, snapshotEnd,
    start: olderStart, end: start, index: 0, offset: 0,
  })).toString('base64url');
  const messages = [];
  const resultAt = (nextIndex, nextOffset) => {
    const remaining = stats(entries.slice(nextIndex));
    remaining.textUnits -= nextOffset;
    const more = nextIndex < entries.length;
    return {
      side: source.side, threadId: source.threadId, view: tools ? 'conversation+tools' : 'conversation',
      window: { startTurn: start, endTurn: end, conversationTurns: visible.filter(i => i >= start).length },
      budget: { bytes: budget, unit: 'UTF-8 serialized JSON including newline' },
      messages,
      omitted: {
        outsideWindow: { ...stats(outside), olderTurns: start, newerTurns: all.length - end },
        filtered, beforePage: before, afterPage: remaining,
        splitItems: messages.filter(item => item.offset > 0 || item.text.length < item.totalTextUnits).length,
      },
      nextCursor: more ? Buffer.from(JSON.stringify({ v: 2, scope, hash: digest, tools, snapshotEnd, start, end, index: nextIndex, offset: nextOffset })).toString('base64url') : null,
      olderCursor: more ? null : olderCursor,
    };
  };
  let nextIndex = index;
  let nextOffset = offset;
  const result = resultAt(nextIndex, nextOffset);
  if (size(result) > budget) throw new Error(`--budget too small for page metadata; need at least ${size(result)} UTF-8 bytes`);
  while (nextIndex < entries.length) {
    const entry = entries[nextIndex];
    let available = Math.min(maxChars, entry.text.length - nextOffset);
    if (splitsScalar(entry.text, nextOffset + available)) available -= 1;
    // Limit: --max-chars=1 needs two UTF-16 units for one supplementary Unicode scalar.
    if (available === 0 && nextOffset < entry.text.length) available = 2;
    const boundaries = [0];
    for (let i = 0; i < available;) {
      i += entry.text.codePointAt(nextOffset + i) > 0xffff ? 2 : 1;
      boundaries.push(i);
    }
    const fragment = { ...entry, text: '', offset: nextOffset, totalTextUnits: entry.text.length };
    messages.push(fragment);
    const candidateAt = (length) => {
      fragment.text = entry.text.slice(nextOffset, nextOffset + length);
      const complete = nextOffset + length === entry.text.length;
      return resultAt(complete ? nextIndex + 1 : nextIndex, complete ? 0 : nextOffset + length);
    };
    let low = size(candidateAt(available)) <= budget ? boundaries.length - 1 : 0;
    let high = low === boundaries.length - 1 ? low : Math.max(0, boundaries.length - 2);
    // Measure the serialized envelope, not just text: escaping and metadata count too.
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (size(candidateAt(boundaries[mid])) <= budget) low = mid;
      else high = mid - 1;
    }
    const length = boundaries[low];
    const candidate = candidateAt(length);
    if (size(candidate) > budget || (length === 0 && available > 0)) {
      const minimum = size(candidateAt(boundaries[1] ?? 0));
      messages.pop();
      if (messages.length === 0) throw new Error(`--budget too small for the next fragment; need at least ${minimum} UTF-8 bytes`);
      break;
    }
    nextOffset += length;
    if (nextOffset === entry.text.length) { nextIndex += 1; nextOffset = 0; }
    if (nextOffset > 0) break;
  }
  return resultAt(nextIndex, nextOffset);
}
