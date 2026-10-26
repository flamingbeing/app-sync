# Soak results

Generated 2026-10-26 23:03:13 SGT. Engine under test: 1.3.10, base commit `0cd4857`. Windows, Node 24.16.0, fake backends only. No browser or live Firebase tests.

Counts are distinct seeds (model: all three configurations per seed) or full-file repeats. Replay runs are additional. Flaky counts are included in the failure column.

| Suite | Seeds/repeats | Pass | Fail | Flaky |
| --- | ---: | ---: | ---: | ---: |
| model | 17950/20000 | 17597 | 353 | 0 |
| auth.model | 5000/5000 | 5000 | 0 | 0 |
| cache | 5000/5000 | 5000 | 0 | 0 |
| faults | 200/200 | 200 | 0 | 0 |
| held | 200/200 | 200 | 0 | 0 |
| writes | 200/200 | 200 | 0 | 0 |
| sync | 200/200 | 200 | 0 | 0 |
| fixes | 200/200 | 189 | 11 | 11 |

Unfinished model seed ranges: 18800-18849, 19000-20999.

Infrastructure errors in recorded runs: 0.

## Restored task missing from another device

Tests: `model (held conflicts, 0.6.3)` and `model (held conflicts with a merge collection, 0.7.1)`. Representative seed: 1158. Assertion: d1 shows tasks/t1 missing although the server holds the restored task after convergence polling. All three individual replays of 1158 failed.

Hypothesis: restoring an edit after a delete may leave its stamp below a tombstone retained by another device. The listener then suppresses the restored record. This is a hypothesis, not a confirmed code-level diagnosis.

```powershell
$env:MODEL_SEED='1158'; node --test --test-isolation=none test/model.test.mjs
```

A read-only diagnostic of seed 1158 found that the missing device retained a tombstone about 66 seconds newer than the restored server record, in both held modes. Raw diagnostic output remains in TEMP.

Failing model seeds: 1069, 1076, 1111, 1120, 1158, 1227, 1237, 1252, 1287, 1315, 1325, 1408, 1475, 1491, 1510, 1524, 1577, 1650, 1690, 1708, 1762, 1796, 1801, 1841, 1862, 1915, 1923, 1927, 1979, 2053, 2133, 2148, 2235, 2245, 2249, 2354, 2387, 2426, 2429, 2473, 2496, 2683, 2737, 2776, 2816, 2882, 3031, 3184, 3201, 3342, 3395, 3465, 3534, 3682, 3690, 3712, 3746, 3768, 3822, 3827, 3881, 3975, 3980, 4023, 4044, 4133, 4180, 4265, 4410, 4530, 4560, 4594, 4696, 4715, 4721, 4756, 4836, 4885, 4995, 5046, 5213, 5241, 5328, 5373, 5389, 5397, 5478, 5528, 5603, 5614, 5742, 5814, 5912, 5932, 5950, 6070, 6128, 6130, 6228, 6260, 6281, 6326, 6342, 6378, 6414, 6517, 6654, 6707, 6720, 6721, 6747, 6805, 6807, 6856, 6889, 6906, 6962, 6964, 6991, 7070, 7093, 7098, 7175, 7416, 7469, 7471, 7498, 7582, 7671, 7697, 7751, 7849, 7858, 7903, 7907, 7984, 8009, 8044, 8077, 8172, 8228, 8251, 8264, 8305, 8339, 8416, 8459, 8583, 8657, 8852, 8883, 8935, 8945, 8946, 8988, 8998, 9054, 9087, 9121, 9135, 9162, 9344, 9397, 9412, 9540, 9651, 9792, 9817, 9822, 9830, 9959, 9969, 9978, 9994, 10036, 10072, 10106, 10177, 10201, 10218, 10251, 10364, 10473, 10512, 10514, 10551, 10601, 10634, 10664, 10800, 10801, 10840, 10918, 11039, 11048, 11052, 11067, 11085, 11097, 11102, 11133, 11148, 11170, 11216, 11237, 11388, 11434, 11489, 11519, 11532, 11640, 11658, 11712, 11809, 11865, 11946, 11956, 11997, 12066, 12105, 12130, 12285, 12332, 12357, 12441, 12443, 12530, 12543, 12547, 12597, 12627, 12671, 12681, 12713, 12750, 12804, 12805, 12827, 12927, 12998, 12999, 13037, 13080, 13084, 13169, 13324, 13332, 13355, 13477, 13675, 13741, 13756, 13758, 13897, 13928, 13940, 13968, 13980, 14023, 14095, 14098, 14121, 14151, 14164, 14181, 14221, 14233, 14269, 14288, 14321, 14452, 14498, 14530, 14531, 14556, 14608, 14653, 14690, 14777, 14957, 14963, 14973, 15030, 15049, 15186, 15191, 15192, 15202, 15249, 15268, 15294, 15368, 15376, 15516, 15524, 15526, 15603, 15680, 15703, 15767, 15798, 15801, 15898, 16159, 16263, 16316, 16351, 16424, 16535, 16544, 16566, 16799, 16871, 16875, 16911, 17035, 17136, 17154, 17158, 17218, 17230, 17237, 17282, 17298, 17347, 17363, 17381, 17532, 17546, 17622, 17694, 17701, 17718, 17729, 17792, 17818, 17994, 18003, 18032, 18057, 18162, 18176, 18190, 18248, 18276, 18468, 18480, 18486, 18512, 18583, 18667, 18753, 18887.

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
