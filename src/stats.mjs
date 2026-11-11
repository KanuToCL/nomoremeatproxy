// What calls cost, summarised from ledger entries: message and reply sizes, time to answer,
// and token use where the vendor reported it. Grouped by caller, peer and way of delivery.
const known = (values) => values.filter(Number.isFinite);
const sum = (values) => known(values).reduce((total, value) => total + value, 0);

function median(values) {
  const sorted = known(values).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

// One row per answered call. A recovered answer is skipped: it was produced by an earlier attempt.
function answeredCalls(entries, { project, since }) {
  const sent = new Map();
  const calls = [];
  for (const entry of entries) {
    if (entry.state === 'submitting') sent.set(entry.requestId, entry);
    if (entry.state !== 'answered' || entry.recovered) continue;
    const start = sent.get(entry.requestId);
    if (!start || (project && start.project !== project) || (since && entry.at < since)) continue;
    calls.push({
      route: `${start.from} to ${start.peer}`,
      delivery: entry.delivery ?? 'unrecorded',
      messageChars: start.messageChars,
      replyChars: entry.replyChars,
      elapsedMs: Date.parse(entry.at) - Date.parse(start.at),
      usage: entry.usage ?? null,
    });
  }
  return calls;
}

function summarizeGroup(calls) {
  const measured = calls.filter((call) => call.usage).map((call) => call.usage);
  const tokens = measured.length
    ? {
        calls: measured.length,
        medianTotal: median(measured.map((usage) => usage.totalTokens)),
        medianOutput: median(measured.map((usage) => usage.outputTokens)),
        sumTotal: sum(measured.map((usage) => usage.totalTokens)),
        sumCachedInput: sum(measured.map((usage) => usage.cachedInputTokens)),
      }
    : null;
  return {
    route: calls[0].route,
    delivery: calls[0].delivery,
    calls: calls.length,
    median: {
      messageChars: median(calls.map((call) => call.messageChars)),
      replyChars: median(calls.map((call) => call.replyChars)),
      elapsedMs: median(calls.map((call) => call.elapsedMs)),
    },
    tokens,
  };
}

export function summarizeCalls(entries, { project, since } = {}) {
  const groups = new Map();
  for (const call of answeredCalls(entries, { project, since })) {
    const key = `${call.route}\n${call.delivery}`;
    groups.set(key, [...(groups.get(key) ?? []), call]);
  }
  return [...groups.values()].map(summarizeGroup);
}
