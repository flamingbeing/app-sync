# Status

## Now
- 0.1.0 released: engine, write queue, stores, outbox, watchdog, status rules, storage guard, Firestore adapter.

## Waiting on the owner
- Nothing.

## Next (in order)
1. Serve each tag unchanged at its own versioned address (the Worker here replaces the template's example).
2. Server-timestamp mode (a field set by the server, enforced by rules) for new apps.
3. A multi-device soak test (offline devices, same-record edits, skewed clocks) in real browsers.

## Recently done
- 2026-10-24: repo created; 0.1.0 extracted with five fixes (see CHANGELOG).

## Decisions (dated, one line each)
- 2026-10-24: own repo, public, no private pair; versions are immutable and apps pin one.
- 2026-10-24: client timestamps kept in 0.1.0 for compatibility; a server-timestamp mode comes later as opt-in.
- 2026-10-24: Apache License 2.0.
