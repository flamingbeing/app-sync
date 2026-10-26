# Soak results

Generated 2026-10-26 22:15:07 SGT. Engine under test: 1.3.10, base commit `0cd4857`. Windows, Node 24.16.0, fake backends only. No browser or live Firebase tests.

Counts are distinct seeds (model: all three configurations per seed) or full-file repeats. Replay runs are additional. Flaky counts are included in the failure column.

| Suite | Seeds/repeats | Pass | Fail | Flaky |
| --- | ---: | ---: | ---: | ---: |
| model | 6350/20000 | 6230 | 120 | 0 |
| auth.model | 5000/5000 | 5000 | 0 | 0 |
| cache | 5000/5000 | 5000 | 0 | 0 |
| faults | 200/200 | 200 | 0 | 0 |
| held | 200/200 | 200 | 0 | 0 |
| writes | 200/200 | 200 | 0 | 0 |
| sync | 200/200 | 200 | 0 | 0 |
| fixes | 200/200 | 189 | 11 | 11 |

Infrastructure errors in recorded runs: 0.

## Restored task missing from another device

Tests: `model (held conflicts, 0.6.3)` and `model (held conflicts with a merge collection, 0.7.1)`. Representative seed: 1158. Assertion: d1 shows tasks/t1 missing although the server holds the restored task after convergence polling. All three individual replays of 1158 failed.

Hypothesis: restoring an edit after a delete may leave its stamp below a tombstone retained by another device. The listener then suppresses the restored record. This is a hypothesis, not a confirmed code-level diagnosis.

```powershell
$env:MODEL_SEED='1158'; node --test --test-isolation=none test/model.test.mjs
```

Failing model seeds: 1069, 1076, 1111, 1120, 1158, 1227, 1237, 1252, 1287, 1315, 1325, 1408, 1475, 1491, 1510, 1524, 1577, 1650, 1690, 1708, 1762, 1796, 1801, 1841, 1862, 1915, 1923, 1927, 1979, 2053, 2133, 2148, 2235, 2245, 2249, 2354, 2387, 2426, 2429, 2473, 2496, 2683, 2737, 2776, 2816, 2882, 3031, 3184, 3201, 3342, 3395, 3465, 3534, 3682, 3690, 3712, 3746, 3768, 3822, 3827, 3881, 3975, 3980, 4023, 4044, 4133, 4180, 4265, 4410, 4530, 4560, 4594, 4696, 4715, 4721, 4756, 4836, 4885, 4995, 5046, 5213, 5241, 5328, 5373, 5389, 5397, 5478, 5528, 5603, 5614, 5742, 5814, 5912, 5932, 5950, 6070, 6128, 6130, 6228, 6260, 6281, 6326, 6342, 6378, 6414, 6517, 6654, 6707, 6720, 6721, 6747, 6805, 6807, 6856, 6889, 6906, 6962, 6964, 6991, 7175.

## Timeout/retry timing flake

Test: `a backend call that never settles times out and the save is sent again` in `test/fixes.test.mjs`. Assertion: expected queue status `synced`, observed `pending` after the 40 ms wait following retry.

Hypothesis: timer scheduling under concurrent load delays the timeout/retry path beyond the test window. A pending status at that instant does not by itself prove that the save is lost.

Failed repeat indices and three replay exit statuses:
- 3: 0, 0, 0
- 23: 0, 0, 1
- 80: 0, 1, 0
- 81: 0, 0, 0
- 106: 0, 0, 0
- 140: 0, 0, 1
- 155: 0, 0, 0
- 156: 0, 0, 0
- 174: 0, 0, 0
- 178: 0, 0, 0
- 179: 0, 0, 0

Repeat with six workers (intermittent; a single invocation may pass):

```powershell
python soak/run.py --suite fixes --fresh
```

## Run notes

`npm ci` failed at lifecycle-script spawning in the restricted Windows environment. `npm ci --ignore-scripts --cache "$env:TEMP\npm-cache" --no-audit --no-fund` completed. These suites use fake backends and do not need the skipped install scripts.

At most six Node host processes. Model batches use three isolated worker-thread realms per host; the fake SDK modifies Date.now, so model scenarios never share one realm concurrently. Individual failing-seed replays use fresh Node processes. Generated tests, raw logs and traces remain outside git in TEMP. Only soak tooling and this derived report are committed. Engine code was not changed.
