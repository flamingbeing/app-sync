#!/usr/bin/env bash
# Soak runner for app-sync (test only, no live backends). Run from the repo root.
# Usage: soak/run.sh emulator N | loop <file> N | model BASE COUNT [PROCS]
# Logs go to ${TEMP:-/tmp}/soak, never into git.
set -u
LOG=${TEMP:-/tmp}/soak; mkdir -p "$LOG"
case "$1" in
  emulator) # needs Java 11+
    pass=0; fail=0
    for i in $(seq 1 "$2"); do
      if npm run test:emulator >"$LOG/emu-$i.log" 2>&1; then pass=$((pass+1)); else fail=$((fail+1)); echo "emulator run $i FAILED (see $LOG/emu-$i.log)"; fi
    done; echo "emulator pass=$pass fail=$fail" ;;
  loop) # soak/run.sh loop test/faults.test.mjs 300
    pass=0; fail=0
    for i in $(seq 1 "$3"); do
      if node --test "$2" >"$LOG/$(basename "$2")-$i.log" 2>&1; then pass=$((pass+1)); rm -f "$LOG/$(basename "$2")-$i.log"; else fail=$((fail+1)); echo "$2 run $i FAILED"; fi
    done; echo "$2 pass=$pass fail=$fail" ;;
  model) # seeds BASE..BASE+COUNT-1, split over PROCS workers, one MODEL_SEED per run
    base=$2; count=$3; procs=${4:-4}
    seq "$base" $((base+count-1)) | xargs -P "$procs" -I{} sh -c \
      'MODEL_SEED={} node --test test/model.test.mjs >"'"$LOG"'/model-{}.log" 2>&1 && rm -f "'"$LOG"'/model-{}.log" || echo "seed {} FAILED"' ;;
esac
