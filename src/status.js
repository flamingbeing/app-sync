// The sync status rules, framework-free: the app renders the answer (a chip, a banner) its own way.
//
// States, most urgent first:
//   attention  N saves need the user (failed, or met a change made elsewhere); they never expire
//   at-risk    saves are waiting and the browser may clear this site's storage (persistGuard said no)
//   offline    saves are waiting and the device is offline: saved on this device only
//   saving     saves are being sent
//   stale      the listener watchdog says the server is not being heard: what shows may be old
//   unknown    nothing waiting, but the server has not confirmed this device's list yet (confirmed: false)
//   synced     nothing waiting, failed or in conflict, and the server heard
// Every write that tells the user "saved" must go through the outbox (or be counted in unsent), or this says
// "synced" while it is not.
//
// syncStatus({ online, pending, attention, unsent = 0, persisted = true, stale = false, confirmed = true, atRiskOnlyOffline = false })
//   pending: outbox saves not yet done (queue.pending()); attention: how many need the user; unsent: writes sent
//   another way and not yet acknowledged. confirmed: false until the server has answered once since the page opened
//   (a snapshot not from the cache), so the chip never says synced on the strength of the device's copy alone.
//   atRiskOnlyOffline: say at-risk only while offline (online, the saves are on their way; some browsers refuse
//   persistent storage in ordinary tabs, which would otherwise show at-risk on every save).
// -> { state, count }
/**
 * @param {{ online?: boolean, pending?: number, attention?: number, unsent?: number, persisted?: boolean, stale?: boolean, confirmed?: boolean, atRiskOnlyOffline?: boolean }} [input]
 * @returns {import('./types.js').SyncStatus}
 */
export function syncStatus({ online = true, pending = 0, attention = 0, unsent = 0, persisted = true, stale = false, confirmed = true, atRiskOnlyOffline = false } = {}) {
  const waiting = (Number(pending) || 0) + (Number(unsent) || 0);
  if (attention > 0) return { state: 'attention', count: Number(attention) };
  if (waiting > 0 && !persisted && (!atRiskOnlyOffline || !online)) return { state: 'at-risk', count: waiting };
  if (waiting > 0 && !online) return { state: 'offline', count: waiting };
  if (waiting > 0) return { state: 'saving', count: waiting };
  if (stale) return { state: 'stale', count: 0 };
  if (confirmed === false) return { state: 'unknown', count: 0 };
  return { state: 'synced', count: 0 };
}

// How many of a queue's saves need the user: failed or in conflict (queue.entries() of writes.js).
/** @param {{ state: string }[] | null | undefined} entries @returns {number} */
export const attentionCount = entries => (entries || []).filter(x => x.state === 'failed' || x.state === 'conflict').length;
