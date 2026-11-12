#!/usr/bin/env bash
# Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).
#
# THE loaded-run harness for the Court suite. Read docs/TEST_DETERMINISM.md.
#
# It answers one question: does a red run under CPU contention mean the CODE is
# wrong, or only that the box was busy? It does this by making the contention
# explicit, fixed and reproducible instead of letting it arrive as ambient
# noise from whatever else is on the machine.
#
#   ./scripts/determinism/loaded-run.sh                 # 3 loaded runs, full suite
#   ./scripts/determinism/loaded-run.sh --iterations 20 --files __tests__/dkg.test.ts
#   HOGS=4 ./scripts/determinism/loaded-run.sh          # lighter contention
#
# Guarantees:
#   * the hog count is N = $(nproc) + 4 busy loops, spawned here, never ambient
#   * every hog is reaped on exit — including SIGINT/SIGTERM (flare rule: a
#     wedged busy loop left running for hours is how this box reached load 60)
#   * each iteration is bounded by `timeout`, so an unkillable synchronous hang
#     cannot wedge the campaign (no in-process watchdog can preempt those)
#   * the exact command is echoed, so a soak report can cite it verbatim
#
# Exit: 0 iff every iteration succeeded.
set -uo pipefail

cd "$(dirname "$0")/../.." || exit 1

ITERATIONS=3
FILES=()
EXTRA=()
while [ $# -gt 0 ]; do
  case "$1" in
    --iterations|-n) ITERATIONS="$2"; shift 2 ;;
    --files|-f) shift; while [ $# -gt 0 ] && [ "${1#-}" = "$1" ]; do FILES+=("$1"); shift; done ;;
    --) shift; EXTRA=("$@"); break ;;
    *) EXTRA+=("$1"); shift ;;
  esac
done

CORES="$(nproc)"
HOGS="${HOGS:-$((CORES + 4))}"
ITER_TIMEOUT="${ITER_TIMEOUT:-5400}"   # per-iteration process bound (s)
LOG_DIR="${LOG_DIR:-/tmp/opencode/court-determinism}"
mkdir -p "$LOG_DIR"

# NOTE: this harness deliberately sets NO timeout knobs. The suite's ceilings
# are load-normalised per worker (`__tests__/helpers/watchdog.ts`: a measured
# load factor, not a constant), so the loaded run should NOT need — and must not
# silently get — a hand-raised budget. If a run needs `BAO_TEST_WATCHDOG_MS=…`,
# that is a finding to record, not a knob to bake in.

HOG_PIDS=()
cleanup() {
  local pid
  for pid in "${HOG_PIDS[@]:-}"; do
    [ -n "$pid" ] && kill -KILL "$pid" 2>/dev/null
  done
  HOG_PIDS=()
}
trap cleanup EXIT INT TERM

spawn_hogs() {
  local i
  for ((i = 0; i < HOGS; i += 1)); do
    # A pure CPU burn with no I/O: contention only, no filesystem interference.
    node -e 'for(;;){Math.sqrt(Math.random())}' >/dev/null 2>&1 &
    HOG_PIDS+=("$!")
    # `disown` keeps the shell from printing "Killed" for each reap, so the
    # campaign log carries only the verdicts.
    disown "$!" 2>/dev/null || true
  done
}

echo "determinism: ${CORES} cores, ${HOGS} busy loops, ${ITERATIONS} iteration(s)"
echo "determinism: logs in $LOG_DIR"
# Cite the exact command in the report/log so a soak run is reproducible.
if [ ${#FILES[@]} -gt 0 ]; then
  echo "determinism: command: npx vitest run ${FILES[*]} ${EXTRA[*]:-}"
else
  echo "determinism: command: npx vitest run ${EXTRA[*]:-}"
fi

FAILED=0
for ((iter = 1; iter <= ITERATIONS; iter += 1)); do
  spawn_hogs
  # Give the hogs a moment to reach steady state so run 1 is not special.
  sleep 2
  OUT="$LOG_DIR/run-$iter.log"
  echo "determinism: iteration $iter -> $OUT"
  if [ ${#FILES[@]} -gt 0 ]; then
    timeout --foreground "$ITER_TIMEOUT" npx vitest run "${FILES[@]}" "${EXTRA[@]}" >"$OUT" 2>&1
  else
    timeout --foreground "$ITER_TIMEOUT" npx vitest run "${EXTRA[@]}" >"$OUT" 2>&1
  fi
  RC=$?
  if [ "$RC" -ne 0 ]; then
    FAILED=$((FAILED + 1))
    echo "determinism: iteration $iter FAILED (exit $RC)"
    grep -E "^\s+×|FAIL |Tests  " "$OUT" | head -40
  else
    grep -E "Tests  |Test Files " "$OUT" | tail -2
  fi
  cleanup
done

echo "determinism: $((ITERATIONS - FAILED))/$ITERATIONS iterations green"
[ "$FAILED" -eq 0 ]
