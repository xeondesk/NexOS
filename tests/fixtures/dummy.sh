#!/bin/bash
# Supervised dummy service used by the supervisor smoke test.
set -u
i=0
while :; do
  echo "dummy tick $i"
  i=$((i + 1))
  sleep 1
done
