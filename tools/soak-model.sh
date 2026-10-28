#!/usr/bin/env bash
# Nightly soak (app-devkit soak.yml `model-command`): a new range of model seeds each night, split over parallel
# processes because the model runs mostly wait on timers. SOAK_SEED_N is days-since-2020 x 10, so x1000 gives every
# night its own 10000 seeds (about 30 min on a 4-core runner; 30000 would be 90).
# A failing seed is printed with its replay line (MODEL_SEED=<n> node --test ...).
set -u
total=${MODEL_TOTAL:-10000}; shards=${MODEL_SHARDS:-16}
per=$(( total / shards )); base=$(( ${SOAK_SEED_N:?} * 1000 ))
pids=(); bad=0
for ((i = 0; i < shards; i++)); do
  MODEL_SEED_START=$(( base + i * per )) MODEL_SEEDS=$per node --test test/model.test.mjs test/auth.model.test.mjs \
    > "model-shard-$i.log" 2>&1 &
  pids+=($!)
done
for i in "${!pids[@]}"; do
  wait "${pids[$i]}" || { bad=1; echo "::group::shard $i failed"; grep -E 'seed [0-9]+|failing seeds|replay' "model-shard-$i.log" | head -40; echo "::endgroup::"; }
done
echo "model seeds $base .. $(( base + total - 1 )): $([ $bad = 0 ] && echo ok || echo FAILED)"
exit $bad
