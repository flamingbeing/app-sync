#!/usr/bin/env bash
# One unit pass for the nightly soak: every test except the model ones (tools/soak-model.sh runs those) and the two
# that need typescript, which the soak does not install.
set -eu
files=$(ls test/*.test.mjs update/test/*.test.mjs | grep -vE '/(model|auth\.model|freeze|modularity)\.test\.mjs$')
# shellcheck disable=SC2086
exec node --test $files
