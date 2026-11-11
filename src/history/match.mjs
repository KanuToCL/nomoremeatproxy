// Searching inside messages, the same on either side: a message matches when it holds every
// word, in any order and any case. Only what the person and the assistant wrote is searched.
import { excerpt } from './render.mjs';

export const textWords = (text) => String(text ?? '').toLowerCase().split(/\s+/).filter(Boolean);

// Where an item matched, or null. `item` is a described item ({ kind, text }) of either side.
export function matchItem(item, words) {
  if (item.kind !== 'user' && item.kind !== 'assistant') return null;
  const flat = String(item.text ?? '').replace(/\s+/g, ' ').trim();
  const lower = flat.toLowerCase();
  if (!words.every((word) => lower.includes(word))) return null;
  // Lowercasing can change the length of a few characters, which shifts the excerpt slightly.
  return { by: item.kind, excerpt: excerpt(flat, Math.min(...words.map((word) => lower.indexOf(word)))) };
}

export function matchedOn({ search, text, project }) {
  const what = [search && 'title', text && 'text'].filter(Boolean).join(' and ') || 'title';
  return project ? `${what}, within the project folder` : what;
}
