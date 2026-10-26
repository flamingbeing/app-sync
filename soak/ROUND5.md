# v1.3.12 soak, round 5 — incomplete

Report completed 2026-10-27 05:44 SGT on Ubuntu with Node v22.22.1.
Checked out tag `v1.3.12` (`3e442800bcaa61a5b9887854bdd95dc75065825c`), then created branch `job/af4eddf8`; package.json reports `1.3.12`.
Engine code, tests and release files are unchanged.

The resumed job first checked its checkout at 05:44:02 SGT, after the 05:30 block admission cutoff. No test or benchmark block was started. No prior round 5 results were present in the supplied checkout, and the remote had no `job/af4eddf8` ref. Thus no prior runs can be credited. The round 4 report was retrieved from `job/06ec0bc8` for reference only; its results are not round 5 coverage.

| Suite | Seeds covered | Runs | Pass | Fail |
| --- | --- | ---: | ---: | ---: |
| model (all three modes) | None | 0 | 0 | 0 |
| auth.model | None | 0 | 0 | 0 |
| cache | None | 0 | 0 | 0 |

Zero failures means no observations, not a passing soak. There are no observed failures, expected/actual mismatches, or failure replay commands to report.

## Benchmarks

| n | Runs completed | Load (ms) | Per delta (ms) | 200 saves (ms) |
| ---: | ---: | --- | --- | --- |
| 10000 | 0 of 3 | Not measured | Not measured | Not measured |
| 1000 | 0 of 3 | Not measured | Not measured | Not measured |

Commands for a future run: `node tools/bench.mjs --n 10000 --json` and `node tools/bench.mjs --n 1000 --json`, three processes each. No benchmark numbers were copied from round 4.

## Not run

- Entire MODEL_SEED sweep, seeds 70000–100000 inclusive, in all three modes, with the requested blocks of 5000.
- Entire auth.model and cache sweeps, seeds 30000–45000 inclusive.
- All six benchmarks.

A new execution window is required to complete this coverage. Future seeded runs must invoke each test file directly under Node 22 (`node --test test/<file>`), without unsupported helper flags. No live services or real data were used, and no credentials were accessed.
