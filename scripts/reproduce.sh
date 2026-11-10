#!/usr/bin/env bash
# Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).
#
# ============================================================================
# BAO COURT — ONE-COMMAND REPRODUCIBILITY CONTRACT (docs/REPRODUCIBILITY.md)
# ============================================================================
#
# From a CLEAN CLONE at the release tag, this ONE command regenerates EVERY
# artifact the protocol paper (docs/FROST_COURT_ORACLE_PAPER.md) and
# docs/CROSS_CHECK.md cite, and prints a final VERDICT block:
#
#   bash scripts/reproduce.sh                      # full contract (~17 min measured)
#   bash scripts/reproduce.sh --quick              # skip model-check + bench (~3.5 min)
#   bash scripts/reproduce.sh --full-model-check   # full exhaustive sweep (not --fast)
#
# Stages:
#   (a) clean-environment check   (b) npm ci            (c) npm test → json+junit
#   (d) typechecks ×3             (e) simulate:court    (f) model-check + digit-identical
#                                                       fixture comparison
#   (g) bench --json vs BASELINE  (h) cross-check.mjs   (i) parity/property/invariant
#                                                       suite pass-counts
#   (j) VERDICT — every artifact PASS/FAIL + stage runtimes + total
#
# Exit code: 0 = every artifact PASS; 1 = at least one FAIL; 2 = usage error.
# The script never stops at the first failure — every stage runs so the
# VERDICT is complete.
#
# Idempotent: re-running overwrites .repro-artifacts/ from scratch and leaves
# the working tree exactly as it found it (the model-check fixture is
# snapshotted before regeneration and copied back afterwards).
#
# Network: only `npm ci` needs the registry. All measurement stages are
# offline, deterministic (no wall clock in measured paths), and CPU-bound.
#
# Required: Node >= 22 (baselines are v22.x — docs/REPRODUCIBILITY.md §
# environment matrix), npm, git, bash.

set -u
cd "$(dirname "$0")/.."

QUICK=0
FULL_MC=0
for arg in "$@"; do
  case "$arg" in
    --quick) QUICK=1 ;;
    --full-model-check) FULL_MC=1 ;;
    *) echo "unknown flag: $arg (supported: --quick, --full-model-check)" >&2; exit 2 ;;
  esac
done

ART=".repro-artifacts"
FIXTURE="__fixtures__/model-check-summary.json"
mkdir -p "$ART"
rm -rf "$ART"/*
T0=$(date +%s%3N)

declare -a STAGE_ID STAGE_TITLE STAGE_STATUS STAGE_SECS
FAILURES=0

now_ms() { date +%s%3N; }
fmt_secs() { # fmt_secs <ms> — clamp negatives (wall-clock NTP steps)
  local ms=$1
  [ "$ms" -lt 0 ] && ms=0
  printf '%d.%03d' $((ms/1000)) $((ms%1000))
}

# run_logged <logfile> <cmd...> — run, tee output to logfile, echo exit code.
run_logged() {
  local log="$1"; shift
  "$@" > >(tee "$log") 2>&1
  return $?
}

register() { # register <id> <title> <status> <secs>
  STAGE_ID+=("$1"); STAGE_TITLE+=("$2"); STAGE_STATUS+=("$3"); STAGE_SECS+=("$4")
}

status_of() { # status_of <id>
  local i
  for i in "${!STAGE_ID[@]}"; do
    [ "${STAGE_ID[$i]}" = "$1" ] && { echo "${STAGE_STATUS[$i]}"; return; }
  done
  echo "—"
}

# stage <id> <title> <logfile> <cmd...> — run one registrable stage.
stage() {
  local id="$1" title="$2" log="$3"; shift 3
  printf '\n=== [%s] %s ===\n' "$id" "$title"
  local s rc e
  s=$(now_ms)
  run_logged "$log" "$@"; rc=$?
  e=$(now_ms)
  local secs; secs=$(fmt_secs $((e - s)))
  register "$id" "$title" "$([ $rc -eq 0 ] && echo PASS || echo FAIL)" "$secs"
  # sub-stages (f1/f2/g1/g2) are folded into their composite stage (f/g);
  # only top-level stages count toward FAILURES here
  case "$id" in *[0-9]*) ;; *) [ $rc -ne 0 ] && FAILURES=$((FAILURES + 1)) ;; esac
  printf -- '--- [%s] exit=%d (%ss) ---\n' "$id" "$rc" "$secs"
  return $rc
}

printf 'BAO COURT REPRODUCTION — %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf 'commit: %s  (nearest tag: %s)\n' \
  "$(git rev-parse HEAD)" "$(git describe --tags --abbrev=1 2>/dev/null || echo none)"
printf 'host: %s, cpus=%s, load: %s\n' \
  "$(uname -s -m)" "$(nproc)" "$(uptime | sed 's/.*load average/load average/')"

# --- (a) clean-environment check -------------------------------------------
printf '\n=== [a] clean-environment check ===\n'
a_start=$(now_ms)
a_ok=1
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null) || a_ok=0
if [ "${NODE_MAJOR:-0}" -lt 22 ]; then
  echo "FAIL: Node >= 22 required (baselines: v22.x); found $(node --version 2>/dev/null || echo none)"
  a_ok=0
else
  echo "node $(node --version) — OK (baselines: v22.x)"
fi
command -v npm >/dev/null || { echo "FAIL: npm not found"; a_ok=0; }
command -v git >/dev/null || { echo "FAIL: git not found"; a_ok=0; }
[ -f package-lock.json ] || { echo "FAIL: package-lock.json missing"; a_ok=0; }
if [ -n "$(git status --porcelain -- . ':!.repro-artifacts' 2>/dev/null)" ]; then
  echo "WARNING: working tree is not clean — the contract is defined from a"
  echo "         CLEAN CLONE at the release tag; numbers may not match the tag."
  echo "         (idempotent re-runs on a used tree are supported; the fixture"
  echo "         comparison is against the tree's own pre-run fixture copy)"
fi
echo "network policy: only stage (b) npm ci touches the registry; every"
echo "measurement stage below is offline and CPU-bound."
a_end=$(now_ms)
register a "clean-env check" "$([ $a_ok -eq 1 ] && echo PASS || echo FAIL)" \
  "$(fmt_secs $((a_end - a_start)))"
[ $a_ok -eq 1 ] || FAILURES=$((FAILURES + 1))

# --- (b) npm ci --------------------------------------------------------------
stage b "npm ci (only network-dependent stage)" \
  "$ART/stage-b.log" \
  npm ci --prefer-offline --no-audit --no-fund

# --- (c) full test suite → json + junit -------------------------------------
stage c "npm test (full suite) → json + junit" \
  "$ART/stage-c.log" \
  npx vitest run \
    --reporter=default \
    --reporter=json --outputFile.json="$ART/test-results.json" \
    --reporter=junit --outputFile.junit="$ART/junit.xml"

# --- (d) typechecks ×3 --------------------------------------------------------
stage d "typechecks ×3 (impl / scripts / tests)" "$ART/stage-d.log" bash -c '
  set -e
  npm run typecheck
  npm run typecheck:scripts
  npm run typecheck:tests
  echo "typecheck ×3: all green"
'

# --- (e) simulate:court -------------------------------------------------------
stage e "simulate:court (end-to-end whole-court deterministic sim)" \
  "$ART/stage-e.log" bash -c '
  set -e
  npm run simulate:court | tee .repro-artifacts/simulate.log
  grep -q "RESULT: ALL GREEN" .repro-artifacts/simulate.log \
    && echo "simulation verdict: ALL GREEN"
'

# --- (f) model-check + digit-identical fixture comparison --------------------
if [ "$QUICK" -eq 1 ]; then
  printf '\n=== [f] model-check — SKIPPED (--quick) ===\n'
  register f "model-check (skipped: --quick)" "SKIP" "0.0"
else
  printf '\n=== [f] model-check + digit-identical fixture comparison ===\n'
  f_start=$(now_ms)
  cp "$FIXTURE" "$ART/model-check-summary.expected.json"
  MCFLAG="--fast"; [ "$FULL_MC" -eq 1 ] && MCFLAG=""
  f_ok=1
  stage f1 "model-check $MCFLAG (deterministic state-space sweep)" \
    "$ART/stage-f1.log" npx tsx scripts/model-check.mjs $MCFLAG || f_ok=0
  cp "$FIXTURE" "$ART/model-check-fast-regenerated.json"
  if [ $f_ok -eq 1 ]; then
    stage f2 "fixture comparison (regenerated == committed, digit-identical)" \
      "$ART/stage-f2.log" \
      npx tsx scripts/compare-model-check-fixture.mjs \
        --expected "$ART/model-check-summary.expected.json" \
        --actual "$ART/model-check-fast-regenerated.json" || f_ok=0
  fi
  # Leave the tree exactly as found (restore the pre-run fixture bytes).
  cp "$ART/model-check-summary.expected.json" "$FIXTURE"
  f_end=$(now_ms)
  register f "model-check + fixture comparison" \
    "$([ $f_ok -eq 1 ] && echo PASS || echo FAIL)" "$(fmt_secs $((f_end - f_start)))"
  [ $f_ok -eq 1 ] || FAILURES=$((FAILURES + 1))
fi

# --- (g) bench --json vs BASELINE --------------------------------------------
if [ "$QUICK" -eq 1 ]; then
  printf '\n=== [g] bench — SKIPPED (--quick) ===\n'
  register g "bench (skipped: --quick)" "SKIP" "0.0"
else
  printf '\n=== [g] bench --json (single pass) vs BASELINE.md ===\n'
  g_start=$(now_ms)
  g_ok=1
  stage g1 "bench --json (single pass)" \
    "$ART/stage-g1.log" npx tsx bench/court.bench.mjs --json "$ART/bench.json" || g_ok=0
  if [ $g_ok -eq 1 ]; then
    stage g2 "bench vs baseline (±20% bound, FAIL at >3x)" \
      "$ART/stage-g2.log" \
      node scripts/bench-vs-baseline.mjs --bench "$ART/bench.json" || g_ok=0
  fi
  g_end=$(now_ms)
  register g "bench --json vs BASELINE" \
    "$([ $g_ok -eq 1 ] && echo PASS || echo FAIL)" "$(fmt_secs $((g_end - g_start)))"
  [ $g_ok -eq 1 ] || FAILURES=$((FAILURES + 1))
fi

# --- (h) cross-check.mjs -------------------------------------------------------
stage h "cross-check.mjs (every evidence pointer in docs/CROSS_CHECK.md)" \
  "$ART/stage-h.log" node scripts/cross-check.mjs

# --- (i) parity / property / invariant suite pass-counts ----------------------
printf '\n=== [i] contract suites (parity / property / invariant / model-checking) ===\n'
i_start=$(now_ms)
i_ok=1
if [ -f "$ART/test-results.json" ]; then
  node scripts/test-suite-summary.mjs "$ART/test-results.json" | tee "$ART/stage-i.log" || i_ok=0
else
  echo "FAIL: no test-results.json from stage (c)"
  i_ok=0
fi
i_end=$(now_ms)
register i "suite pass-counts" "$([ $i_ok -eq 1 ] && echo PASS || echo FAIL)" \
  "$(fmt_secs $((i_end - i_start)))"
[ $i_ok -eq 1 ] || FAILURES=$((FAILURES + 1))

# --- (j) VERDICT ----------------------------------------------------------------
T1=$(now_ms)
TOTAL_MS=$((T1 - T0))
TOTAL=$(fmt_secs "$TOTAL_MS")

printf '\n==================== VERDICT ====================\n'
printf ' commit: %s   node: %s   date: %s\n' \
  "$(git rev-parse --short=12 HEAD)" "$(node --version)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf ' flags: %s\n' "$([ "$QUICK" -eq 1 ] && echo --quick)$([ "$FULL_MC" -eq 1 ] && echo --full-model-check)$([ "$QUICK" -eq 0 ] && [ "$FULL_MC" -eq 0 ] && echo '(default: full contract)')"
printf '%s\n' '-------------------------------------------------'
for i in "${!STAGE_ID[@]}"; do
  printf ' [%s] %-52s %s (%ss)\n' \
    "${STAGE_ID[$i]}" "${STAGE_TITLE[$i]}" "${STAGE_STATUS[$i]}" "${STAGE_SECS[$i]}"
done
printf '%s\n' '-------------------------------------------------'
printf ' artifacts:\n'
[ "$(status_of b)" = "PASS" ] && \
  printf '   npm ci ......................... PASS (lockfile-exact install)\n'
[ "$(status_of c)" = "PASS" ] && \
  printf '   full test suite ................ PASS (json: %s/test-results.json, junit: %s/junit.xml)\n' "$ART" "$ART"
[ "$(status_of e)" = "PASS" ] && \
  printf '   simulate:court ................. PASS (ALL GREEN, escrow/LN/liquid coherent)\n'
[ "$(status_of f)" = "PASS" ] && \
  printf '   model-check fixture ............ PASS (digit-identical vs committed; stable hash: %s)\n' \
    "$(npx tsx scripts/compare-model-check-fixture.mjs --hash "$ART/model-check-summary.expected.json")"
[ "$(status_of g)" = "PASS" ] && \
  printf '   bench (--json, single pass) .... PASS (variance bound ±20%% vs BASELINE.md, FAIL >3x)\n'
[ "$(status_of h)" = "PASS" ] && \
  printf '   cross-check evidence refs ...... PASS (count in %s/stage-h.log)\n' "$ART"
[ "$(status_of i)" = "PASS" ] && \
  printf '   parity/property/invariant ...... PASS (pass-counts in %s/stage-i.log)\n' "$ART"
printf '%s\n' '-------------------------------------------------'
if [ "$FAILURES" -eq 0 ]; then
  printf ' RESULT: REPRODUCED — every artifact PASS — total %ss\n' "$TOTAL"
else
  printf ' RESULT: FAILED — %d stage(s) failed — total %ss\n' "$FAILURES" "$TOTAL"
fi
printf '=================================================\n'

if [ "$FAILURES" -eq 0 ]; then exit 0; else exit 1; fi
