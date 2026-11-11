// Read-only orientation. No vendor commands, write probes, listener claims or messages.
import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';
import { defaultStateDir, openLedger } from './ledger.mjs';
import { openMailbox } from './mailbox.mjs';
import { DEFAULT_PEERS } from './peers.mjs';

export function stateAccess(dir) {
  let existing = path.resolve(dir);
  let exists = true;
  for (;;) {
    try {
      const stat = statSync(existing);
      if (!stat.isDirectory()) return { exists, writable: false, checked: existing, reason: 'not a directory' };
      accessSync(existing, constants.W_OK | constants.X_OK);
      return { exists, writable: true, checked: existing };
    } catch (error) {
      if (error.code !== 'ENOENT') return { exists, writable: false, checked: existing, reason: error.code ?? 'unknown' };
      exists = false;
      const parent = path.dirname(existing);
      if (parent === existing) return { exists, writable: false, checked: existing, reason: 'no existing parent' };
      existing = parent;
    }
  }
}

export function orient({ cwd = process.cwd(), from, stateDir = defaultStateDir() } = {}) {
  const project = path.resolve(cwd);
  const location = path.resolve(stateDir);
  const ledger = openLedger(location, { readOnly: true });
  const mailbox = openMailbox(location);
  const routes = new Map();
  for (const entry of ledger.entries()) {
    if (entry.project === project && typeof entry.from === 'string' && entry.from && Object.hasOwn(DEFAULT_PEERS, entry.peer) && (!from || entry.from === from || entry.peer === from)) {
      routes.set(JSON.stringify([entry.from, entry.peer]), { project, from: entry.from, peer: entry.peer });
    }
  }
  if (from) for (const peer of Object.keys(DEFAULT_PEERS)) {
    if (peer === from) continue;
    routes.set(JSON.stringify([from, peer]), { project, from, peer });
    if (Object.hasOwn(DEFAULT_PEERS, from)) routes.set(JSON.stringify([peer, from]), { project, from: peer, peer: from });
  }
  const listeners = Object.entries(DEFAULT_PEERS).filter(([, peer]) => peer.vendor === 'claude').map(([peer]) => ({
    peer, registration: mailbox.listener({ project, peer }),
  }));
  const sortedRoutes = [...routes.values()].sort((a, b) => Number(Object.hasOwn(DEFAULT_PEERS, b.from)) - Number(Object.hasOwn(DEFAULT_PEERS, a.from)) || a.from.localeCompare(b.from) || a.peer.localeCompare(b.peer));
  const vendor = DEFAULT_PEERS[from]?.vendor;
  return {
    project,
    projectResolution: 'absolute lexical path from --cwd or the current directory; no symlink canonicalization',
    state: {
      location,
      access: stateAccess(location),
      note: 'Advisory filesystem permission check only; no write attempted. Sandboxes or ACLs may still refuse writes. Both assistants must use this same location.',
    },
    routes: sortedRoutes.slice(0, 20).map((route) => ({
      from: route.from, peer: route.peer,
      role: !from ? 'project route' : route.from === from ? 'outgoing' : 'incoming',
      standing: ledger.standingThread(route),
      fallback: ledger.lastThread(route),
    })),
    routesOmitted: Math.max(0, sortedRoutes.length - 20),
    listeners,
    routing: 'An unpinned Claude call may use a registered listener unless that peer is waiting for this caller; otherwise the standing thread, then the last eligible answer, then a new chat. Explicit --thread and --new bypass this default.',
    listenerNote: 'Registration/heartbeat freshness only, including held listen --once claims; delivery and end-to-end reachability not tested.',
    nextSteps: {
      caller: `Use find --side ${vendor === 'codex' ? 'claude' : vendor === 'claude' ? 'codex' : '<codex|claude>'} --project --cwd ${JSON.stringify(project)} to locate chats, then read --side <side> --thread <id>. Inspect standing --to <peer> --from ${from ? JSON.stringify(from) : '<caller>'} --cwd ${JSON.stringify(project)} before changing a route.`,
      listener: `${vendor === 'codex' ? 'Codex callers do not run listen; the receiving Claude Desktop chat does.' : vendor === 'claude' ? 'As a Claude peer, listen in the exact intended Desktop chat.' : 'Caller side unknown; only a Claude Desktop chat runs listen.'} Run listen --as <peer> --thread <this exact chat id> --once --cwd <project>, then restart after output; reply by request-id. This report does not start it.`,
      owner: 'Run npm run doctor from the bridge installation for installation/sign-in checks. Only a separately authorized real call and reply can test delivery.',
    },
  };
}
