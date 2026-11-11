import assert from 'node:assert/strict';
import { test } from 'node:test';
import { foldTurnEvent, newTurnState } from '../src/adapters/codex.mjs';
import { parseClaudeResult } from '../src/adapters/claude.mjs';
import { claudeUsage, codexBaseline, codexUsage } from '../src/usage.mjs';
import { summarizeCalls } from '../src/stats.mjs';

// --- what Claude reports ---

test('a Claude result counts cached, newly cached and fresh input plus output as the total', () => {
  // Figures of a real one-word answer: almost everything is the fixed load written to cache.
  const usage = claudeUsage({
    total_cost_usd: 0.0116196,
    usage: { input_tokens: 2, cache_creation_input_tokens: 58087, cache_read_input_tokens: 0, output_tokens: 4, output_tokens_details: { thinking_tokens: 0 } },
  });
  // 2 + 0 + 58087 + 4
  assert.deepEqual(usage, { totalTokens: 58093, cachedInputTokens: 0, outputTokens: 4, reasoningTokens: 0, listPriceUsd: 0.0116196 });
});

test('a Claude result without usage figures yields none, and the parsed result omits the field', () => {
  assert.equal(claudeUsage({ result: 'ACK' }), null);
  const parsed = parseClaudeResult(JSON.stringify({ type: 'result', session_id: 's', result: 'ACK' }));
  assert.equal(Object.hasOwn(parsed, 'usage'), false);
});

test('a parsed Claude result carries the usage when the vendor reports it', () => {
  const stdout = JSON.stringify({ type: 'result', session_id: 's', result: 'ACK', usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 } });
  assert.deepEqual(parseClaudeResult(stdout).usage, { totalTokens: 105, cachedInputTokens: 90, outputTokens: 5, reasoningTokens: 0 });
});

// --- what Codex reports ---

const breakdown = (totalTokens, cachedInputTokens, outputTokens, reasoningOutputTokens) => ({ totalTokens, cachedInputTokens, outputTokens, reasoningOutputTokens });

test('a Codex turn in a new thread uses exactly the thread total', () => {
  const report = { total: breakdown(1200, 0, 40, 10), last: breakdown(1200, 0, 40, 10) };
  assert.deepEqual(codexUsage(codexBaseline(report), report.total), { totalTokens: 1200, cachedInputTokens: 0, outputTokens: 40, reasoningTokens: 10 });
});

test('a Codex turn in an older thread uses only the growth since just before its first report', () => {
  // The thread stood at 5000 before the turn; the turn made two model requests.
  const first = { total: breakdown(6200, 900, 240, 60), last: breakdown(1200, 900, 40, 10) };
  const second = { total: breakdown(7500, 2000, 300, 80), last: breakdown(1300, 1100, 60, 20) };
  let state = newTurnState();
  state = foldTurnEvent(state, 'thread/tokenUsage/updated', { tokenUsage: first });
  state = foldTurnEvent(state, 'thread/tokenUsage/updated', { tokenUsage: second });
  // 7500 - (6200 - 1200) = 2500; cached 2000 - (900 - 900) = 2000; output 300 - 200 = 100; reasoning 80 - 50 = 30
  assert.deepEqual(codexUsage(state.usageBefore, state.usageNow), { totalTokens: 2500, cachedInputTokens: 2000, outputTokens: 100, reasoningTokens: 30 });
});

test('a Codex turn with no usage report yields no figures', () => {
  const state = foldTurnEvent(newTurnState(), 'turn/completed', { turn: { status: 'completed' } });
  assert.equal(codexUsage(state.usageBefore, state.usageNow), null);
});

// --- the summary ---

const ROUTE = Object.freeze({ project: '/work/app', from: 'fable', peer: 'astra' });
const at = (seconds) => new Date(Date.parse('2026-11-10T12:00:00Z') + seconds * 1000).toISOString();

function exchange(requestId, startSeconds, seconds, { messageChars, replyChars, delivery, usage, route = ROUTE, recovered } = {}) {
  return [
    { at: at(startSeconds), requestId, ...route, state: 'submitting', messageChars },
    { at: at(startSeconds + seconds), requestId, ...route, state: 'answered', delivery, replyChars, usage, recovered },
  ];
}

test('calls are grouped by caller, peer and delivery, with medians of size and time', () => {
  const entries = [
    ...exchange('a', 0, 10, { messageChars: 100, replyChars: 300, delivery: 'queued' }),
    ...exchange('b', 60, 30, { messageChars: 300, replyChars: 500, delivery: 'queued' }),
    ...exchange('c', 120, 20, { messageChars: 200, replyChars: 400, delivery: 'queued' }),
    ...exchange('d', 180, 5, { messageChars: 50, replyChars: 60, delivery: 'direct', usage: { totalTokens: 9000, cachedInputTokens: 8000, outputTokens: 30 } }),
  ];
  const [queued, direct] = summarizeCalls(entries);
  assert.deepEqual(queued, { route: 'fable to astra', delivery: 'queued', calls: 3, median: { messageChars: 200, replyChars: 400, elapsedMs: 20000 }, tokens: null });
  assert.equal(direct.calls, 1);
  assert.deepEqual(direct.tokens, { calls: 1, medianTotal: 9000, medianOutput: 30, sumTotal: 9000, sumCachedInput: 8000 });
});

test('token medians cover only the calls that have figures', () => {
  const entries = [
    ...exchange('a', 0, 10, { delivery: 'headless', usage: { totalTokens: 60000, cachedInputTokens: 0, outputTokens: 10 } }),
    ...exchange('b', 60, 10, { delivery: 'headless', usage: { totalTokens: 62000, cachedInputTokens: 58000, outputTokens: 30 } }),
    ...exchange('c', 120, 10, { delivery: 'headless' }),
  ];
  const [group] = summarizeCalls(entries);
  assert.equal(group.calls, 3);
  // Median of two values is their mean: (60000 + 62000) / 2 and (10 + 30) / 2.
  assert.deepEqual(group.tokens, { calls: 2, medianTotal: 61000, medianOutput: 20, sumTotal: 122000, sumCachedInput: 58000 });
});

test('the summary can be limited to one project and to calls answered since a time', () => {
  const entries = [
    ...exchange('a', 0, 10, { delivery: 'queued' }),
    ...exchange('b', 3600, 10, { delivery: 'queued' }),
    ...exchange('c', 3700, 10, { delivery: 'queued', route: { ...ROUTE, project: '/work/other' } }),
  ];
  assert.equal(summarizeCalls(entries, { project: '/work/app' })[0].calls, 2);
  assert.equal(summarizeCalls(entries, { project: '/work/app', since: at(1800) })[0].calls, 1);
  assert.equal(summarizeCalls(entries)[0].calls, 3);
});

test('unanswered calls, recovered answers and entries from before sizes were recorded do not distort it', () => {
  const entries = [
    { at: at(0), requestId: 'open', ...ROUTE, state: 'submitting', messageChars: 999 },
    ...exchange('recovered', 10, 600, { delivery: 'queued', recovered: true }),
    ...exchange('old', 20, 15, {}),
  ];
  assert.deepEqual(summarizeCalls(entries), [
    { route: 'fable to astra', delivery: 'unrecorded', calls: 1, median: { messageChars: null, replyChars: null, elapsedMs: 15000 }, tokens: null },
  ]);
});
