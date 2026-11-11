// Peer names are the words the owner uses: "call Astra", "spin off Sol".

export const DEFAULT_PEERS = Object.freeze({
  astra: Object.freeze({ vendor: 'codex', model: 'gpt-6-astra', effort: 'ultra' }),
  sol: Object.freeze({ vendor: 'codex', model: 'gpt-6.1-sol', effort: 'ultra' }),
  fable: Object.freeze({ vendor: 'claude', model: 'claude-fable-5-2' }),
  opus: Object.freeze({ vendor: 'claude', model: 'claude-opus-5-5', effort: 'high' }),
});

export function resolvePeer(name, { model, effort, peers = DEFAULT_PEERS } = {}) {
  const key = String(name ?? '').toLowerCase();
  const peer = Object.hasOwn(peers, key) ? peers[key] : undefined;
  if (!peer) {
    throw new Error(`unknown peer "${name}"; known peers: ${Object.keys(peers).join(', ')}`);
  }
  const level = effort ?? peer.effort;
  return { name: key, vendor: peer.vendor, model: model ?? peer.model, ...(level === undefined ? {} : { effort: level }) };
}
