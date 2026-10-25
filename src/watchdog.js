// The listener watchdog's decision. Pure (test/watchdog.test.mjs); the backend adapter keeps the facts and acts on
// the answer.
//
// Why: a long-lived Firestore listener can stop delivering without any error (after the network is switched off and
// on, or a phone coming back from the background with the stream dead but not yet noticed). The page then shows an
// old value while the server, and even the SDK's own cache, hold a newer one; a fresh listener gives the right answer
// at once. Replacing a listener is cheap: a new one resumes with a resume token, so only changed documents are read.
//
// The signs of a stuck listener, all known to the page:
//  - 'cache': a listener has been showing the device's own copy (fromCache) for CACHE_MS while the browser says online;
//  - 'flagged': a document is still flagged hasPendingWrites FLAG_MS after every one of this device's writes was
//    acknowledged (the SDK clears that flag only when the listener hears the server's version, so never when stuck);
//  - 'quiet': at a moment the device has just come back (online, page shown or restored, a manual "sync now") and no
//    listener has heard the server for STALE_MS. A quiet dataset sends nothing for hours, so this is only asked at
//    those moments, never on a timer.
// At most one re-listen every THROTTLE_MS, and never while the browser says it is offline.

export const CACHE_MS = 8000;      // a listener fromCache this long while online
export const FLAG_MS = 6000;       // a document flagged pending this long after every write was acknowledged
export const STALE_MS = 10000;     // nothing heard from the server this long, at a moment the phone came back
export const THROTTLE_MS = 30000;  // at most one re-listen this often
export const ESCALATE_MS = 6000;   // still stuck this long after listening again: the connection itself is dead
export const CYCLE_THROTTLE_MS = 60000;   // at most one network restart this often

/**
 * @typedef {{ relisten: boolean, cycle: boolean, why: 'cache' | 'flagged' | 'quiet' | '' }} Decision
 * @typedef {object} Facts
 * @property {number} now
 * @property {boolean} online
 * @property {boolean} [event]
 * @property {number} [lastServerAt]
 * @property {number} [openedAt]
 * @property {number} [cacheSince]
 * @property {number} [flaggedSince]
 * @property {number} [lastRelisten]
 * @property {number} [lastCycle]
 * @property {boolean} [quiet]
 */

// Listening again is not always enough: the connection the listeners share can itself be dead (a write acknowledged,
// yet no listener, old or new, hears the server's version). Only restarting it (the SDK's network switched off and
// on) brings the data. That is safe only when every write has been acknowledged (a write sent but not acknowledged is
// sent again by a restart, and an increment sent twice counts twice). So: listen again first; if the sign is still
// there ESCALATE_MS later, and nothing is unacknowledged, restart the connection (cycle).

// s: { now, online, event (a moment the phone came back: online, visible, pageshow, Sync now), lastServerAt (the last snapshot that was not
//      fromCache, or 0), openedAt (when listening began), cacheSince (since when a listener has been fromCache, or 0), flaggedSince (since when
//      a document has been flagged with nothing in flight, or 0), lastRelisten, lastCycle (when each last happened, or 0),
//      quiet (every write this phone made has been acknowledged) }
// -> { relisten: boolean, cycle: boolean, why: 'cache' | 'flagged' | 'quiet' | '' }
/** @param {Facts} s @returns {Decision} */
export function decide(s) {
  /** @type {Decision} */
  const no = { relisten: false, cycle: false, why: '' };
  if (!s.online) return no;
  /** @type {'cache' | 'flagged' | ''} */
  const stuck = s.cacheSince && s.now - s.cacheSince >= CACHE_MS ? 'cache' : s.flaggedSince && s.now - s.flaggedSince >= FLAG_MS ? 'flagged' : '';
  if (stuck && s.lastRelisten && s.now - s.lastRelisten >= ESCALATE_MS && s.quiet && !(s.lastCycle && s.now - s.lastCycle < CYCLE_THROTTLE_MS)) return { relisten: false, cycle: true, why: stuck };
  if (s.lastRelisten && s.now - s.lastRelisten < THROTTLE_MS) return no;
  if (stuck) return { relisten: true, cycle: false, why: stuck };
  if (s.event) {
    const heard = s.lastServerAt || s.openedAt || 0;
    if (heard && s.now - heard >= STALE_MS) return { relisten: true, cycle: false, why: 'quiet' };
  }
  return no;
}

// The facts decide() needs, kept from what listeners report, and the actions taken on its answer.
// createWatchdog({ relisten, cycle, now, online, quiet }) -> { heard(snapMeta), opened(), event(), check() -> answer,
//   stale() -> true while not hearing the server at a moment that should have }
//   relisten(): start every listener again; cycle(): restart the backend's connection (e.g. disableNetwork then
//   enableNetwork); quiet(): true when every write this device made has been acknowledged.
/**
 * @param {{ relisten?: (why: string) => void, cycle?: (why: string) => void, now?: () => number, online?: () => boolean, quiet?: () => boolean }} [options]
 */
export function createWatchdog({ relisten = () => {}, cycle = () => {}, now = Date.now, online = () => typeof navigator === 'undefined' || navigator.onLine !== false, quiet = () => true } = {}) {
  let lastServerAt = 0, openedAt = now(), cacheSince = 0, flaggedSince = 0, lastRelisten = 0, lastCycle = 0, stuck = '';
  /** @param {boolean} event */
  const facts = event => ({ now: now(), online: online(), event, lastServerAt, openedAt, cacheSince, flaggedSince, lastRelisten, lastCycle, quiet: quiet() });
  /** @param {boolean} event */
  const act = event => {
    const a = decide(facts(event));
    if (a.relisten) { lastRelisten = now(); stuck = a.why; relisten(a.why); }
    else if (a.cycle) { lastCycle = now(); stuck = a.why; cycle(a.why); }
    return a;
  };
  return {
    // a snapshot's metadata: { fromCache, hasPendingWrites }
    heard({ fromCache = false, hasPendingWrites = false } = {}) {
      const t = now();
      if (fromCache) { if (!cacheSince) cacheSince = t; } else { cacheSince = 0; lastServerAt = t; stuck = ''; }
      if (hasPendingWrites && quiet()) { if (!flaggedSince) flaggedSince = t; } else flaggedSince = 0;
    },
    opened() { openedAt = now(); },
    event: () => act(true),
    check: () => act(false),
    stale: () => !!stuck,
  };
}
