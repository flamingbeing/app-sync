# Soak tests

Test only, with made-up data and fake backends. Run from the repository root with Node 22 and Python 3.
Set `TEMP` to a writable directory outside this checkout; raw logs and JSON counts stay there.
`npm ci --cache "$TEMP/npm-cache"` avoids a read-only default npm cache.

```sh
python3 soak/run.py faults --count 300 --minutes 20
python3 soak/run.py watchdog --count 300 --minutes 35
python3 soak/run.py model --base 1000000 --count 20000 --workers 4 --minutes 85
```

The model runner runs one `MODEL_SEED` per process, including all three model modes. Its base and count
select a contiguous range; the time limit can end the range early. Four model workers plus one faults
worker and one watchdog worker use at most six Node processes. Run files directly to avoid the extra
child process created by `node --test`. Each process has a 180-second limit; code 124 means a timeout,
not an assertion failure. `results.json` records completed attempts and exit codes.

The recovered `run.sh` remains available for the original commands; prefer `run.py` for bounded runs,
counts, and meaningful exit codes. The emulator mode needs Java 11+, local emulator configuration,
and the demo project only. Do not use live backends. The mixed-version consumer spec requires its
app-starter fixtures and an emulator; it is not standalone in this checkout.

Reproduce the repeated-drop/restore failure without random timing:

```sh
node soak/tombstone.test.mjs
```

Replay a seeded model failure and inspect deletion markers (diagnostic logs outside git):

```sh
MODEL_SEED=1000022 node --test test/model.test.mjs
MODEL_SEED=1000022 node soak/probe-model.mjs > "$TEMP/probe.log" 2>&1
```

The diagnostic wrapper loads the existing model with additional logging; it does not edit the engine
or original test. Hypothesis: once a record is absent, a second local drop replaces its known deletion
boundary with the local clock. A newer restore can then remain hidden on that device.
