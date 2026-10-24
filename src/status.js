// The sync status rules, framework-free: the app renders the answer (a chip, a banner) its own way.
//
// States, most urgent first:
//   attention  N saves need the user (failed, or met a change made elsewhere); they never expire
//   at-risk    saves are waiting and the browser may clear this site's storage (persistGuard said no)
//   offline    saves are waiting and the device is offline: saved on this device only
//   saving     saves are being sent
//   stale      the listener watchdog says the server is not being heard: what shows may be old
//   synced     nothing waiting, failed or in conflict, and the server heard
// Every write that tells the user "saved" must go through the outbox (or be counted in unsent), or this says
// "synced" while it is not.
//
// syncStatus({ online, pending, attention, unsent = 0, persisted = true, stale = false })
//   pending: outbox saves not yet done (queue.pending()); attention: how many need the user; unsent: writes sent
//   another way and not yet acknowledged.
// -> { state, count }
export function syncStatus({ online = true, pending = 0, attention = 0, unsent = 0, persisted = true, stale = false } = {}) {
  const waiting = (Number(pending) || 0) + (Number(unsent) || 0);
  if (attention > 0) return { state: 'attention', count: Number(attention) };
  if (waiting > 0 && !persisted) return { state: 'at-risk', count: waiting };
  if (waiting > 0 && !online) return { state: 'offline', count: waiting };
  if (waiting > 0) return { state: 'saving', count: waiting };
  if (stale) return { state: 'stale', count: 0 };
  return { state: 'synced', count: 0 };
}

// How many of a queue's saves need the user: failed or in conflict (queue.entries() of writes.js).
export const attentionCount = entries => (entries || []).filter(x => x.state === 'failed' || x.state === 'conflict').length;
