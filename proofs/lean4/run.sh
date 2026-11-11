#!/usr/bin/env bash
# Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).
#
# One-command re-run of the Lean 4 mechanisation in proofs/lean4.
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

echo "# Lean 4 mechanisation run — proofs/lean4/SingleFinality.lean"
echo "# tool: $(lean --version 2>/dev/null || echo 'lean not on PATH')"
echo "# date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo

echo "═══ 1/2 lake build (kernel-checks every proof) ═══"
out="$(lake build 2>&1)"
printf '%s\n' "$out"
if printf '%s\n' "$out" | grep -q "uses 'sorry'"; then
  echo "[FAIL] a declaration uses 'sorry' — the mechanisation has a gap"
  exit 1
fi
echo "[ok] build clean, no 'sorry'"
echo

echo "═══ 2/2 axiom audit (no sorryAx / ofReduceBool / custom axioms) ═══"
lake env lean Axioms.lean
echo

echo "═══ ALL CHECKS COMPLETED ═══"
