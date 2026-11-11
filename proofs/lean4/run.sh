#!/usr/bin/env bash
# Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).
#
# One-command re-run of the Lean 4 mechanisation in proofs/lean4.
#
# Three modules are built and kernel-checked:
#   SingleFinality   — one verdict per case, one epoch message per epoch
#   LadderBound      — the sign-based ladder bound (E[π](d) < 0 ↔ d < flipRound)
#   EscalationLedger — per-round bond consumption + one-hash-one-index
#
# Requirements (one time, ~2 min, ~1.2 GB in ~/.elan):
#   curl -sSfL https://elan.lean-lang.org/elan-init.sh | sh -s -- -y \
#     --default-toolchain leanprover/lean4:v4.14.0
# The toolchain is pinned by ./lean-toolchain, so elan will also fetch it
# automatically on first `lake build` if a different default is installed.
#
# Usage: ./run.sh                    # full check, writes lean-run.log
#        ./run.sh | tee lean-run.log

set -euo pipefail
cd "$(dirname "$0")"

export PATH="${HOME}/.elan/bin:${PATH}"

echo "# Lean 4 mechanisation run — proofs/lean4/{SingleFinality,LadderBound,EscalationLedger}.lean"
echo "# tool: $(lean --version 2>/dev/null || echo 'lean not on PATH')"
echo "# date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo

echo "═══ 1/3 lake build (kernel-checks every proof) ═══"
out="$(lake build 2>&1)"
printf '%s\n' "$out"
if printf '%s\n' "$out" | grep -q "uses 'sorry'"; then
  echo "[FAIL] a declaration uses 'sorry' — the mechanisation has a gap"
  exit 1
fi
echo "[ok] build clean, no 'sorry'"
echo

echo "═══ 2/3 no 'sorry' in the sources (belt and braces) ═══"
for f in ./*.lean; do
  if perl -0pe 's{/\-.*?\-/}{}gs; s{--[^\n]*}{}g' "$f" | grep -qE '\b(sorry|admit)\b'; then
    echo "[FAIL] $f still contains sorry/admit outside a comment"
    exit 1
  fi
done
echo "[ok] sources contain no 'sorry' / 'admit'"
echo

echo "═══ 3/3 axiom audit (no sorryAx / ofReduceBool / custom axioms) ═══"
lake env lean Axioms.lean
echo

echo "═══ ALL CHECKS COMPLETED ═══"
