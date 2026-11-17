# The bond gate against a hostile verifier

**Status:** implemented and tested in v0.17.1 (`bondCheckGate.ts`,
`scripts/court/bondCheckRunner.mjs`, `__tests__/bondGateHostile.test.ts`).
**Scope:** one sentence of threat model, the attack table, the gate's
guarantees, and the two gaps that are real (one fixed, one residual).

---

## 1. The threat model, in one paragraph

**The checker is untrusted.** `BAO_COURT_BOND_CHECK_CMD` is a command line an
operator pastes into an environment, and the gate exists precisely because the
thing it measures (a coin on a chain) is outside this repository. So the gate
must stay correct when the checker lies, cheats, leaks or refuses to stop —
that is what an attacker who controls the box does, and it is also what an
honest-but-broken adapter does by accident. Nothing the command PROVES is
trusted: the gate decides what an answer may mean (one JSON object, a `proofRef`
equal to the one it asked about, a `rail`/`network` that agrees, a bond value at
or above the floor it set, an exit code of 0), it never lets a value reach a
shell, it bounds the answer at 8 MiB and the run at `--bond-check-timeout-ms`,
it gives the command no inherited secrets, and it kills the command's whole
process group when the verdict is in. The unavoidable residue — the gate cannot
see a chain, and it cannot sandbox a process that runs as the operator — is
listed as **[R1](#r1-the-value-floor-is-the-checkers-word-when-it-omits-valuesats)**
and **[R2](#r2-a-checker-that-creates-its-own-session-escapes-the-group-kill)**
below rather than papered over.

Everything below is asserted by `__tests__/bondGateHostile.test.ts` (43 tests):
the parser and the roster decision from `bondCheckGate.ts`, and the spawn /
quote / timeout / environment code from `scripts/court/bondCheckRunner.mjs` —
the same module the ceremony runs, not a copy of it.

---

## 2. The attack table

### 2.1 Lying success — "I proved it" about a bond nobody paid

| attack (from a hostile command) | the gate's answer | test |
|---|---|---|
| `{"ok":true}` for a **different** `proofRef` | `BOND_PROOF_MISMATCH` — the identity it proved is not the identity it was asked about (compared case- and space-insensitively on `bondIdentity`) | "refuses ok:true for a DIFFERENT proofRef" |
| `{"ok":true}` with **no** `proofRef` | `BOND_CHECK_MALFORMED` — "I proved it" must name what it proved | "refuses ok:true with NO proofRef" |
| `{"ok":true,"sources":[]}` | `BOND_CHECK_MALFORMED` — zero agreeing sources is not a proof | "refuses ok:true with an EMPTY sources list" |
| `{"ok":true,…,"rail":"onchain"}` (or a foreign `network`) | `BOND_RAIL_MISMATCH` — an answer for another rail/network is refused even when the outpoint matches | "refuses an ok:true that echoes a FOREIGN rail or network" |
| `{"ok":true,…,"valueSats":999}` against `--bond-sats=1000` | `BOND_VALUE_BELOW_REQUIRED` (a **decision**, not retried); the roster records `BOND_CHECK_REFUSED` and can fall below threshold | "refuses ok:true for a bond worth LESS than the ceremony requires" |
| `"valueSats":"1000"` (a string) | `BOND_CHECK_MALFORMED` | "refuses a non-numeric bond value and accepts exactly the floor" |
| `ok:true` **twice** in one invocation | `BOND_CHECK_MALFORMED` — exactly one object, before parsing | "refuses TWO ok:true answers in one invocation" |

### 2.2 Truncation and stream games — the answer is a shape, not a hint

| attack | the gate's answer | test |
|---|---|---|
| output that ends mid-JSON | `BOND_CHECK_MALFORMED` (first/last non-space characters must be `{`/`}`, and `JSON.parse` must agree) | "refuses truncated mid-JSON" |
| two concatenated objects | `BOND_CHECK_MALFORMED` | "refuses two concatenated objects" |
| a JSON **array** of objects | `BOND_CHECK_MALFORMED` | "refuses a JSON ARRAY of answers" |
| a bare `true` / a log line before the verdict | `BOND_CHECK_MALFORMED` | "refuses a bare string", "refuses a log line before the verdict" |
| the answer on **stderr only** | `BOND_CHECK_MALFORMED` — stdout and stderr are separate streams and only stdout is ever parsed; the stderr tail is kept for the artifact | "reads STDOUT only" |
| valid `ok:true` body, **exit 3** | `BOND_CHECK_FAILED` — **the exit code wins** | "THE EXIT CODE WINS: … non-zero exit" |
| valid `ok:true` body, process **signalled** | `BOND_CHECK_FAILED` — a signal death is not exit 0 | "THE EXIT CODE WINS over a valid body killed by a SIGNAL" |
| valid object **followed by 100 MB of whitespace** | `BOND_CHECK_MALFORMED` at the first byte over `BOND_CHECK_MAX_OUTPUT_BYTES` (8 MiB), and the writer is killed | "refuses an ok:true followed by 100 MB of whitespace — and kills the writer" |

### 2.3 Hangs and timeouts — the budget is a ceiling, not a suggestion

| attack | the gate's answer | test |
|---|---|---|
| sleeps forever | `BOND_CHECK_TIMEOUT`, and the process group is gone (`kill(pid, 0)` throws) | "gives up on a command that never answers" |
| writes 4 KiB then hangs | `BOND_CHECK_TIMEOUT`; the partial body never contributes a `proofRef` | "keeps partial output out of the verdict" |
| **ignores SIGTERM** and keeps running | `BOND_CHECK_TIMEOUT` after `timeout + grace`: SIGTERM at the deadline, SIGKILL 250 ms later, and the promise settles **without waiting for the process** | "does not wait for a checker that IGNORES SIGTERM" |
| closes stdout but stays running | same: the gate waits on the *process*, not on the pipe, and the pipe closing is not a verdict | "does not wait on a checker that CLOSES stdout" |
| leaves a backgrounded child behind after saying `ok:true` | the answer is accepted, and the **group is killed the moment the direct child exits** — not when stdout closes, which a backgrounded child can hold open — so the survivor cannot act after the verdict | "kills a checker that leaves a backgrounded child behind" |

### 2.4 Injection through the request

Every value is validated (`rail`/`network` enumerations, `proofRef`
`[!-~]{1,512}` — no whitespace, `juror-pubkey` 64 lowercase hex) and then
single-quoted for the `/bin/sh -c` the command line requires. The tests put a
**sentinel** in the payload: the file can only appear if the shell ever treats a
value as syntax.

| payload (as `proofRef`) | result | sentinel |
|---|---|---|
| `…;id>/tmp/pwned-semicolon` | arrives as ONE argv word (`--proof=…;id>…`), verdict `BOND_INJECTION_PROBE` from the stub | absent |
| `…$(id>/tmp/pwned-subshell)` | same; `$(` is literal | absent |
| `` …`id>/tmp/pwned-backtick` `` | same; backticks are literal | absent |
| `…;id>/tmp/pwned-paren;:` | same | absent |
| `…$HOME` | literal `$HOME` reaches the command (no expansion) | n/a |
| `…>/tmp/pwned-redirect` | literal; no redirect happens | absent |
| `--bond-sats=0`, `--rail=onchain` (flag-shaped values) | delivered inside `--proof=…`, never parsed as a second flag | n/a |
| `…; touch /tmp/pwned-space` (**with** a space) | refused **before spawn** — the `proofRef` grammar has no whitespace, so the command is never started | absent |
| `…\ntouch /tmp/pwned-newline` (**newline**) | refused before spawn (`BOND_CHECK_MALFORMED`, "cannot be expressed as inert argv") — a *typed refusal*, never a harness crash | absent |
| `--juror-pubkey=--help` / `-aaaa…` | refused by `buildBondCheckArgs` before spawn (`/64 lowercase hex/`) | absent |
| a **1 MiB** `proofRef` | refused twice over: `parseCourtBondRef` (≤512) and `buildBondCheckArgs`; `BOND_CHECK_MALFORMED`, nothing executed | absent |

The last three rows are the **fixed** gap: before this round
`runBondCheck` called `buildBondCheckArgs` *outside* any `try`, so a roster
entry that could not be expressed as inert argv threw out of the harness and
took the whole ceremony down (a crash, not a refusal, and a crash is not
fail-closed reasoning you can audit). It is now a typed refusal.

### 2.5 Environment leakage — the checker is not handed the ceremony's secrets

| probe | before | after |
|---|---|---|
| `env` inside the command | **inherited everything**: `BAO_COURT_*` (including the gate's own command line), relay tokens, `*_PRIVKEY`, `*_MNEMONIC`, cloud credentials | allowlist only: `PATH`, `HOME`, `TMPDIR`/`TMP`/`TEMP`, `LANG`/`LC_*`, `TZ`, `SSH_AUTH_SOCK`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`/`SSL_CERT_DIR` |
| extra variables a host genuinely needs | passed implicitly | passed **by name** through `BAO_COURT_BOND_CHECK_ENV=NAME,NAME` — the operator opts in, so the ceremony's secrets stay home unless deliberately named |
| the check command line itself | visible as `BAO_COURT_BOND_CHECK_CMD` | not passed (the harness already embeds it in argv) |

Test: "passes an ALLOWLIST, never the parent environment" — a canary
`BAO_COURT_CANARY_SECRET`, `MNEMONIC`, `SMJ_ORACLE_PRIVKEY` and
`AWS_SECRET_ACCESS_KEY` are placed in the parent environment; the child dumps
its own environment; no key and no value survives.

### 2.6 Ordering and replay

| attack | the gate's answer | test |
|---|---|---|
| the **same bond** presented for seat 1 and seat 2 while the command says `ok:true` for both | first claimant seated; seat 2 `BOND_REUSED_ACROSS_SEATS` (`duplicateOf:1`); with `--threshold` unmet the run stops `ROSTER_BELOW_THRESHOLD`, no key, no signature | "re-verifies ONE BOND, ONE SEAT when the hostile command says ok:true for both seats" |
| the same outpoint on a **different rail/network** | a different identity — not a duplicate | "re-verifies the duplicate rule for a RAIL/network change" |
| the same outpoint re-typed in UPPER CASE | the same identity — re-typing a txid does not buy a seat | "treats a bond identity case-insensitively" |
| `ok:true` only on the **second** invocation for the same seat | a **decision** (`BOND_SPENT`, `BOND_PROOF_MISMATCH`, `BOND_CHECK_MALFORMED`, `BOND_RAIL_MISMATCH`, a value refusal) is asked **exactly once**; only a *transient* failure (`BOND_CHECK_FAILED`, `BOND_CHECK_TIMEOUT`, `BOND_UNVERIFIABLE`) is re-asked, and a second-attempt success is recorded as `attempts:2` | "does not re-ask a DECISION", "does not re-ask a MALFORMED answer either", "re-asks ONLY a transient failure" |

---

## 3. The gate's guarantees

1. **A seat needs a positive, specific, named proof.** Exit 0 **and** one JSON
   object **and** `ok:true` **and** a `proofRef` equal to the requested bond
   identity **and** at least one source **and** (when stated) a value at or above
   the floor. Anything else is a refusal with a typed code.
2. **The checker's word is never the last word on identity.** The gate compares
   the answer with the request it made, and re-checks the identity in the roster
   decision, so a caller that forgets cannot seat a juror either.
3. **No value reaches a shell.** Enumerated rails/networks, a whitespace-free
   identifier grammar, hex-only keys, and single-quoting for the required
   `/bin/sh -c`; an inexpressible request is refused, never executed and never a
   crash.
4. **The answer is bounded**: 8 MiB of stdout (a refusal, not a transport
   error), a bounded stderr tail that is never parsed.
5. **The run is bounded**: the child is its own process group; SIGTERM at the
   deadline, SIGKILL after a 250 ms grace, and the verdict settles without
   waiting for the process. Measured: a 200/300/600 ms budget settles at
   237/308/607 ms when the checker dies on SIGTERM (i.e. at the deadline), and at
   ≈deadline + grace (604 ms for a 300 ms budget) when it ignores SIGTERM. The
   old `spawnSync` path took **5,006 ms** for a 600 ms budget against a checker
   that ignores SIGTERM, and **never returned** against a trap-and-loop one.
6. **No orphans**: the group is killed when the direct child exits *and* again
   when the verdict settles — never merely when stdout closes, which a
   backgrounded child can hold open. A checker cannot keep scanning, keep
   exfiltrating or hold a lock after it was answered.
7. **No ambient secrets**: default-deny environment, name-based opt-in.
8. **Fail closed, never open**: every unknown — no verdict, a crash, a timeout,
   junk, a contradiction, a value below the floor — excludes the juror; if the
   survivors cannot reach the threshold the ceremony emits no key and no
   signature.

---

## 4. Gaps

### R1 — the value floor is the checker's word when it omits `valueSats`

**What is fixed:** when the answer states a `valueSats`, the gate enforces
`valueSats >= --bond-sats` itself (`BOND_VALUE_BELOW_REQUIRED`), so a checker
that honestly reports a small bond cannot seat it.

**What remains:** the gate has no chain access, so a checker that simply omits
`valueSats` is admitted on its `ok:true` alone. The artifact records
`valueSats:null` for those checks and `timedOut`/`attempts` beside it, so the
omission is visible rather than assumed.

**Repro:** run the ceremony with `--bond-sats=1000` and a command that prints
`{"ok":true,"proofRef":"<the bond>","sources":["a"]}` — the seat is granted.

**Recommendation (structural, not a gate fix):** make the floor a property of
the *proof*, not of the answer — the host's verifier should sign or otherwise
attest `(proofRef, valueSats, height)` with a key the ceremony pins, so the gate
verifies an attestation instead of trusting a float. Until then, a deployment
that depends on the floor should pin `BAO_COURT_BOND_CHECK_CMD` to a checker
whose value logic it audits, and the artifact should be read with
`valueSats:null` meaning "unverified floor".

### R2 — a checker that creates its own session escapes the group kill

**What is bounded:** the group kill covers everything that stays in the
process group, including children the command backgrounds and `unref()`s.

**What remains:** a command that calls `setsid`/`daemon(3)` (or
double-forks into a new session) leaves the group and survives. No
`kill(-pgid)` can reach it.

**Repro:** `BAO_COURT_BOND_CHECK_CMD="setsid sh -c 'sleep 600'"` — the check
times out at its budget and the sleeper lives on.

**Recommendation:** treat this as a boundary, not a bug: the gate is not a
sandbox — the checker runs with the operator's privileges and can read the
filesystem, so a truly hostile *command* is out of scope for any in-process
defence. Deploy it as a dedicated unprivileged user with
`ProtectSystem`/`PrivateTmp` and a `KillMode=control-group` unit (systemd
kills the **cgroup**, which does cover `setsid`), and keep the command line
operator-controlled and reviewed. That is the same posture as the court signer
(`docs/FROST-COURT-SIGNER.md`): loopback-only, token-gated, and never trusted
to be honest about its own inputs.

---

## 5. Where the code lives

| piece | file |
|---|---|
| parser, identity, roster decision (browser-safe) | `bondCheckGate.ts` |
| spawn, quoting, timeout, group kill, output cap, environment scrub, retry | `scripts/court/bondCheckRunner.mjs` |
| harness wiring (one check per juror, before the DKG) | `scripts/court/distributed-ceremony.mjs` |
| the ceremony's own contract + artifacts | `docs/MULTI_PROCESS_CEREMONY.md` §"The bond gate" |
| these attacks as tests | `__tests__/bondGateHostile.test.ts` |
