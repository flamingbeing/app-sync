# soak

`run.sh` loops the emulator suite, faults/watchdog tests, and model seeds from a chosen base (model.test.mjs has no base env, so each seed runs via `MODEL_SEED`). Logs go to `$TEMP/soak`.

    soak/run.sh emulator 40
    soak/run.sh loop test/faults.test.mjs 300
    soak/run.sh loop test/watchdog.test.mjs 300
    soak/run.sh model 1000000 2000 4
