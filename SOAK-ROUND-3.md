# Unit soak round 3: app-sync 1.3.11

Completed 2026-10-27 01:20 SGT on Windows with Node v24.16.0.
Tested main commit d719d87 (engine release commit a3d25ed), package version 1.3.11.
No engine or test changes. No Firebase project, browser, site, install, or npm script was used.

## Primary runs

Each file ran 150 times sequentially, with a fresh Node process per run:
`node --test --test-isolation=none test/<file>.test.mjs`.

| File | Runs | Pass | Fail | Flaky / real |
| --- | ---: | ---: | ---: | --- |
| test/faults.test.mjs | 150 | 150 | 0 | 0 / 0 |
| test/held.test.mjs | 150 | 150 | 0 | 0 / 0 |
| test/writes.test.mjs | 150 | 150 | 0 | 0 / 0 |
| test/sync.test.mjs | 150 | 150 | 0 | 0 / 0 |
| test/fixes.test.mjs | 150 | 113 | 37 | 37 / 0 |
| test/watchdog.test.mjs | 150 | 150 | 0 | 0 / 0 |

Not everything passed. The sole distinct failure was the test below. All other tests passed, including the 1.3.11 restored-record regression.

## Failure and replays

Test: `a backend call that never settles times out and the save is sent again`.
Declared at `test/fixes.test.mjs:69`; assertion at `test/fixes.test.mjs:79:10`:
expected `synced`, received `pending`.

Primary failure rate: **37/150 (24.7%)**. The supplied earlier 1.3.10 result was 11/200 (5.5%); these are separate observations, not a controlled version comparison.

Every failed primary file run was immediately replayed three times in fresh processes: 111 full-file replays, 82 passed and 29 failed. Each of the 37 primary failures then received three fresh-process replays of only the failing test: 111 isolated replays, 96 passed and 15 failed (13.5%). Every group of three isolated replays had at least one pass. All replay failures had the same assertion. Classification: timing flake, no consistently failing regression identified.

Full-file replay:

```powershell
node --test --test-isolation=none test/fixes.test.mjs
```

Isolated replay:

```powershell
node --test --test-isolation=none '--test-name-pattern=^a backend call that never settles times out and the save is sent again$' test/fixes.test.mjs
```

## Timing explanation from the source

The test sets `sendTimeout: 30` ms and replaces queue delays with 5 ms for the save's nominal 180 ms wait, and 10 ms for every other delay, including retry backoff. After `save()` returns, it waits 60 ms, verifies pending, flips `hang` to false, calls `kick()` without awaiting it, waits 40 ms, then expects synced.

The queue automatically retries while `hang` remains true. A retry may therefore already be awaiting another never-settling backend promise when `hang` flips. Changing that flag does not settle that existing promise. `kick()` clears retry wait markers and rescans; `drain()` returns the existing running task rather than replacing its in-flight call (`src/writes.js:159`, `:239`). Recovery must then wait for that call's remaining 30 ms timeout plus the injected 10 ms retry delay (`src/writes.js:90`, `:203`). The test's 40 ms observation window has no scheduling margin against that timer chain. Windows timer scheduling can let the assertion observe pending before the successful retry. This is a source-based explanation; no runtime timer tracing or modified test was used.

## Scope and evidence

Raw per-process logs, primary/replay CSV records, isolated-replay CSV records, and the PowerShell loop were written only under TEMP, outside git. Only this summary and repository testing/status notes are committed. Raw TEMP evidence is ephemeral.

Fetching the earlier soak branch was attempted once but failed with Git HTTPS transport error `SEC_E_NO_CREDENTIALS`; no credentials were sought. The existing clean main checkout supplied all tests. No push was run.
