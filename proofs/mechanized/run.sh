#!/usr/bin/env bash
# Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).
#
# One-command re-run of the mechanized verification of the BAO Court phase
# machines (proofs/mechanized). Deterministic: `quint test` scenarios are
# fixed scripts; the simulator runs are seeded (--seed 42); Apalache's
# symbolic check is exhaustive.
#
# Requirements:
#   - quint 0.33.1 on PATH (npm install -g @informalsystems/quint@0.33.1),
#     or point QUINT at the binary.
#   - Java 21+ on PATH for the Apalache steps (`quint verify`); quint
#     downloads the Apalache distribution on first use.
#
# Usage: ./run.sh            # writes/refreshes nothing; print to stdout
#        ./run.sh > quint-run.log 2>&1
#        QUINT=/path/to/quint ./run.sh

set -euo pipefail
cd "$(dirname "$0")"

QUINT="${QUINT:-quint}"

echo "# Mechanical verification run — proofs/mechanized/court.qnt"
echo "# tool: $($QUINT --version)"
echo "# date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo

echo "═══ 1/5 quint typecheck ═══"
"$QUINT" typecheck court.qnt
echo "[ok] typecheck clean"
echo

for m in voteTests confirmTests confirmQuorumTests confirmCapOneTests; do
  echo "═══ 2/5 quint test --main $m ═══"
  "$QUINT" test court.qnt --main "$m"
done
echo

echo "═══ 3/5 quint run voteSim — 10 000 seeded random runs, invariants on ═══"
"$QUINT" run court.qnt --main voteSim --invariants inv \
  --witnesses wTallyFinal wFullLedger wExpired wAborted \
  --max-samples 10000 --max-steps 60 --seed 42 2>&1 | tail -12
echo

echo "═══ 4/5 quint run confirmSim — 10 000 seeded random runs, invariants on ═══"
"$QUINT" run court.qnt --main confirmSim --invariants inv \
  --witnesses wFinal wOverturned wFlip wTwoRounds wExpired wAborted \
  --max-samples 10000 --max-steps 60 --seed 42 2>&1 | tail -12
echo

echo "═══ 5/5 quint verify (Apalache symbolic model checking, exhaustive to depth 10) ═══"
if command -v java >/dev/null 2>&1; then
  echo "--- voteSim ---"
  "$QUINT" verify court.qnt --main voteSim --invariants inv --max-steps 10 2>&1 | tail -4
  echo "--- confirmSim ---"
  "$QUINT" verify court.qnt --main confirmSim --invariants inv --max-steps 10 2>&1 | tail -4
else
  echo "[skip] java not on PATH — Apalache steps skipped (simulator runs above still executed)"
fi

echo
echo "═══ ALL CHECKS COMPLETED ═══"
