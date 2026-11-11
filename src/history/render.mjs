// Shared shaping for thread history, whichever side it came from.

export function clip(text, maxChars) {
  const value = String(text ?? '');
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n[cut: ${value.length - maxChars} more characters; raise --max-chars to read them]`;
}

export function firstLine(text) {
  const line = String(text ?? '').split('\n').find((candidate) => candidate.trim());
  return line ? line.trim() : '';
}

export const lastTurns = (turns, count) => turns.slice(Math.max(0, turns.length - count));

export const clipItems = (items, maxChars) => items.map((item) => ({ ...item, text: clip(item.text, maxChars) }));

// One line of about `size` characters around position `at`, with ... where it was cut.
export function excerpt(text, at, size = 160) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  const start = Math.max(0, Math.min(at - Math.floor(size / 4), flat.length - size));
  return `${start > 0 ? '...' : ''}${flat.slice(start, start + size)}${start + size < flat.length ? '...' : ''}`;
}
