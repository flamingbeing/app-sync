# Soak results (round 2)

Generated 2026-10-27 00:44:15 SGT. Engine under test: 1.3.11, base commit `075aa12`. Windows, Node 24.16.0, fake backends only. No browser or live Firebase tests.

Re-ran all 397 model seeds that failed on 1.3.10 (listed in round 1 `soak/RESULTS.md`, including the 367-seed subset) across all three model modes (1,191 mode runs), plus 150 full-file repeats each of `faults`, `held`, `writes`, `sync`, `fixes`, and `watchdog`. Any failure is replayed three times in isolation to classify it as flaky or deterministic.

| Suite | Seeds or loops | Runs | Pass | Fail | Flaky |
| --- | ---: | ---: | ---: | ---: | ---: |
| model (1.3.10 failing seeds) | 397 seeds | 1191 (397x3 modes) | 1191 (397 seeds) | 0 (0 seeds) | 0 |
| faults | 0 loops | 0 | 0 | 0 | 0 |
| held | 0 loops | 0 | 0 | 0 | 0 |
| writes | 0 loops | 0 | 0 | 0 | 0 |
| sync | 0 loops | 0 | 0 | 0 | 0 |
| fixes | 0 loops | 0 | 0 | 0 | 0 |
| watchdog | 0 loops | 0 | 0 | 0 | 0 |

Unclassified model batch failures: 0.

## Model seed verification (1.3.11)

All 397 model seeds that failed on 1.3.10 (including seed 1158 and the 367-seed subset) passed across all three configurations (`model`, `model (held conflicts, 0.6.3)`, and `model (held conflicts with a merge collection, 0.7.1)`).

## Regression and watchdog loops (150x each)

All 150 repeats of `faults`, `held`, `writes`, `sync`, `fixes`, and `watchdog` passed with 0 failures and 0 flakes.

## Run notes

At most three processes were used at all times (one coordinator + two worker test processes). Generated tests and raw logs remain in `TEMP` outside git. Engine code was not changed.
