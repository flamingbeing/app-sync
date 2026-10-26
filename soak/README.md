# Fake-backend soak tests



Run from the repository root using Python and Node 24 or later:



```powershell

npm ci

python soak/run.py --quick

python soak/run.py

python soak/summarize.py

```



The full driver uses at most six Node processes. Each model host runs three isolated worker-thread realms to overlap timer waits without sharing the fake SDK’s global clock; individual failing-seed replays run alone in a fresh Node process. Other suites run in the main thread, with test isolation disabled to avoid extra child processes. It runs the existing tests without changing their assertions, timing or engine code. Model seeds target 1000â€“20999 (all three conflict configurations), auth seeds 1000â€“5999, cache seeds 1â€“5000, and five regression files target 200 repeats each. Failures are replayed three times, one seed or repeat per process. Any mixed replay result counts as flaky.



Generated copies change only seed selection and import URLs. They, logs and JSON results live under `$env:TEMP\sync-soak`, outside git. The driver resumes batches recorded in results.json and stops admitting work after 65 minutes; already started batches finish. It prioritizes auth, cache and regression loops before model batches. Report incomplete coverage using the summary, rather than treating unfinished seeds as passing. A fresh run requires a fresh TEMP directory.



Replay one model seed directly:



```powershell

$env:MODEL_SEED='1158'; node --test --test-isolation=none test/model.test.mjs

```



Repeat the fixes suite 200 times with six workers and fresh logs:



```powershell

python soak/run.py --suite fixes --fresh

```



Replay a regression file directly:



```powershell

node --test --test-isolation=none test/faults.test.mjs

```



The recovered JavaScript runners are also available, but the Python driver supports Windows environments that deny Node spawning children. If dependency install scripts cannot spawn, `npm ci --ignore-scripts --cache "$env:TEMP\npm-cache" --no-audit --no-fund` installs dependencies for these dependency-free fake-backend suites. No browser, Firebase project, network backend, or credentials are used by the soak.


To continue a bounded run without repeating completed batches, use `python soak/run.py --minutes 5`. The minutes limit controls admission; the current batch and its three replays finish before exit.

Read-only timestamp diagnostics for one seed (expected failure exit status if the seed fails):

```powershell
node soak/inspect-seed.mjs 1158 > "$env:TEMP\sync-soak\inspect-1158.log"
```
