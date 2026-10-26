#!/usr/bin/env bash
# Compatibility entry point. Raw evidence stays in TEMP, outside git.
set -eu
case "${1:-}" in
  model) exec python3 soak/run.py model --base "$2" --count "$3" --workers "${4:-4}" ;;
  loop)
    case "$2" in
      test/faults.test.mjs) suite=faults ;;
      test/watchdog.test.mjs) suite=watchdog ;;
      *) echo 'loop supports only the fake-backend faults and watchdog suites' >&2; exit 2 ;;
    esac
    exec python3 soak/run.py "$suite" --count "$3" ;;
  emulator)
    java -version
    log="${TEMP:?set TEMP outside the checkout}/soak/emulator"
    mkdir -p "$log"
    pass=0; fail=0
    for ((i=1; i<=$2; i++)); do
      if npm run test:emulator >"$log/$i.log" 2>&1; then
        pass=$((pass+1))
      else
        fail=$((fail+1)); echo "emulator run $i FAILED"
      fi
    done
    echo "emulator pass=$pass fail=$fail"
    test "$fail" -eq 0 ;;
  *) echo 'usage: bash soak/run.sh model BASE COUNT [WORKERS] | loop FILE COUNT | emulator COUNT' >&2; exit 2 ;;
esac
