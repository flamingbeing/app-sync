# v1.3.12 extended soak, round 4

Completed 2026-10-27 02:42:37 SGT on Ubuntu, Node v22.22.1. All requested tests passed.
Tag `v1.3.12` resolves to `3e442800bcaa61a5b9887854bdd95dc75065825c`; `package.json` is version 1.3.12.
Engine, original tests, benchmark and release files are unchanged. `npm ci` completed successfully.

| Suite | Seeds (inclusive) | Runs | Pass | Fail |
| --- | --- | ---: | ---: | ---: |
| model | 20000–35000 plus 1158 | 45006 | 45006 | 0 |
| auth.model | 5000–12000 | 7001 | 7001 | 0 |
| cache | 5000–12000 | 7001 | 7001 | 0 |

Model counts are seed/mode runs: normal, held conflicts, and held conflicts with a merge collection.
All 584 completed blocks and their logs were checked: exact seed coverage without duplicates, successful exit codes, no failed seeds or TAP failures, and all model modes present. Cache totals exclude its repeated unseeded unit cases.
No failing seeds, mismatches, flaky results or failure replays. Nothing remains in the requested coverage.

## Benchmarks

Commands: `node tools/bench.mjs --n 10000 --json` and `node tools/bench.mjs --n 1000 --json`, three separate processes each after the soak, sequentially.
Timings below are milliseconds: first load / mean per delta (200 deltas) / total for 200 saves.
Fake server, listeners and memory storage only; these measure engine work, not real Firestore or browser storage.

- n=10000: 73.4 / 34.27 / 3330.9; 63.5 / 36 / 3482.7; 53.1 / 33.27 / 3335.4.
- n=1000: 11.9 / 2.74 / 337.2; 10.9 / 2.54 / 330.6; 11.8 / 3.19 / 333.4.

## Execution notes

Recovered round 1 tooling and adapted its configuration to four Node hosts, with three isolated model worker realms per host. Generated tests change seed selection and import URLs only; assertions and engine behavior are unchanged. Raw logs, generated tests and JSON results stayed in TEMP outside git. No live backend or site was used.
The first invocation rejected auth/cache and single-seed model blocks because Node 22 does not support `--test-isolation=none`. Those attempts executed no tests, were excluded, and every affected block was rerun successfully by invoking Node directly. Completed threaded model blocks were retained. No engine failure was hidden by this retry.
The first model phase completed in 2381.3 seconds; the continuation and six benchmarks finished about 43 minutes after startup, before the admission and exit deadlines.
