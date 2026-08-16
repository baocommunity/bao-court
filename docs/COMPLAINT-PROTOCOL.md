# BAO Court DKG complaint protocol — possession binding

Status: **adopted 2026-08-15** (hardening). Applies to kind 38032 complaints
and the `IndependentDkgSession` arbitration path.

## 1. Why the binding exists (the two attacks it kills)

VSS complaint/defense protocols reveal evaluation points of the accused's
polynomial: the accused publishes `f_i(j)` (the share value for index `j`)
to prove the complained-about share was the correct one. That is safe only
if the number of points any honest participant is ever forced to reveal is
<b>below the threshold `t`</b> (only then can the polynomial not be
interpolated). Two attacks break that invariant when complaints are not
bound to possession:

1. **Group-secret extraction (critical).** An attacker files `t` false
   complaints against one honest juror naming *different victim indices*
   `1..t`. Each forces a valid public defense, revealing `f_X(1)..f_X(t)`.
   With `t` points of the degree-`(t-1)` polynomial the attacker
   interpolates `f_X` entirely — including `f_X(0)`, X's secret
   contribution to the group secret. Repeating across `t` honest jurors
   recovers the group secret and lets the attacker forge any attestation.
2. **Permanent ceremony DoS (high).** A forged complaint with a garbage
   `revealedShare` fails verification against the accused's public
   commitments, so every juror's session disqualifies the honest accused —
   fail-closed, the attempt aborts, and replacement attempts die the same
   way at zero cost.

Both attacks work because the old code accepted *any* complaint with a
matching dispute id: no proof that the victim received anything, no check
that the complainer is the victim.

## 2. The rule

> Only the recipient of an actually-received encrypted share may complain
> about it, and the kind 38032 event MUST be signed by that recipient.

Enforced at three layers:

1. **Event boundary (structural).** `parseDkgComplaintEvent` returns `null`
   unless the signed author (`event.pubkey`) equals the victim pubkey, the
   victim and accused are distinct positive indices with well-formed 64-hex
   pubkeys, and the possession anchor `['share', <kind-39003-event-id>]`
   (also mirrored in content as `encryptedShareEventId`) is present and
   64-hex. Complaints authored by the accused, a third party, or a relay are
   structurally invalid and never reach arbitration.
2. **Session admission.** `IndependentDkgSession.addComplaint` re-checks the
   roster claim (victim/accused are certified roster members with matching
   pubkeys), rejects duplicates for the same (victim, accused) pair,
   rejects complaints from disqualified complainers, bounds total complaints
   to one per directed roster pair, and — when this session IS the victim —
   requires that the accused actually delivered an encrypted share to this
   session (`encryptedShares` possession). Returns `boolean`.
3. **Resolution.** `resolveComplaints` settles each pair exactly once:
   - revealed share (or a valid defense) **verifies** against the accused's
     public commitments → complaint is **false**: the accused is
     exonerated, and the complainer is surfaced through
     `getFalseComplaints()` as slashing evidence for the bond backend;
   - revealed share **fails** verification (no defense) → accused
     **disqualified** (genuine grievance);
   - defense present but **fails** verification → the accused published a
     bogus defense → **disqualified**;
   - complaints from disqualified complainers → **void**.

## 3. Why this restores the security bound

With the binding, a dishonest coalition of `m` parties can force genuine
complaints against an honest juror for at most the shares it *actually
received* — each colluder controls exactly one victim index, so at most `m`
points of the honest polynomial are ever exposed. Under an honest majority
(`m + 1 ≤ t`), the number of exposed points is strictly below the
threshold, and polynomial recovery — and with it group-secret recovery — is
impossible. The old attack forced reveals for *victim indices the attacker
never touched*, which is exactly what the binding now forbids.

## 4. Defense disclosure policy

Accused jurors should respond to a **bound** complaint (one that references
a share they genuinely sent to the named victim) with the share value for
that victim only. There is no legitimate reason to disclose a share value
for a victim that never received one — a complaint about such a share is by
definition forged (its event cannot be victim-signed without possession) and
must be ignored, not answered. Hosts that auto-publish defenses MUST gate on
`addComplaint` having returned `true` and on `parseDkgComplaintEvent` having
accepted the event; answering unbound complaints re-opens the attack.

## 5. Reference implementation

- `types.ts` — `DkgComplaint` (requires `encryptedShareEventId`).
- `dkgMessages.ts` — `buildDkgComplaintEvent` / `parseDkgComplaintEvent`
  (author === victim, share anchor, structural rejection).
- `independentDkg.ts` — `addComplaint` (admission gates), `resolveComplaints`
  (per-pair settlement), `getComplaints`, `getFalseComplaints`,
  `getPhase` (only unresolved complaints hold the 'complaint' phase).
- `__tests__/hardening20260815.test.ts` — regression coverage.
- `__tests__/dkgMessages.test.ts` — parser binding cases.

## 6. Remaining out-of-scope items

- Slashing of false complainers is adjudicated by the bond backend
  (`getFalseComplaints`) — this module has no economic layer by design.
- Relays that lose `['share', id]` tags before delivery would make a
  complaint structurally invalid (fail-closed); hosts should treat
  complaints as the unit for relay integrity checks.
