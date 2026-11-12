// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * REPLAY IS NOT EQUIVOCATION — the regression pin.
 *
 * The distributed ceremony's `--scenario=replay` has the relay duplicate a
 * seeded fraction of records and re-deliver each copy late. A duplicate is the
 * SAME signed event (a Nostr event id is sha256 over the serialised event, so
 * same id ⇒ same bytes ⇒ same signature): re-delivery is idempotency, not a
 * second claim. Accusing the signer of equivocation for it is a false
 * accusation, and in a protocol whose whole purpose is to blame correctly that
 * is a worse failure than missing one.
 *
 * What actually happened (v0.15.3, reproduced on untouched `origin/main`): the
 * coordinator's audit of the relay log compared the parsed proof-of-knowledge
 * object by REFERENCE —
 *
 *     existing.parsed.pok === parsed.pok
 *
 * — which is false for two parses of the same event, so the "collapse identical
 * signed events" branch could never fire. Every re-delivered commitment became
 * an equivocation: `equivocatingJurors:[2]`, `duplicatesIgnored:0`, the group
 * key could not be re-derived from the relay log, and three assertions failed.
 *
 * The comparison now lives in one place (`collapseSignedRecords` in
 * `courtCeremonyCore.ts`) and both directions are pinned here:
 *
 *   (a) the CAPTURED trace of the failing run → zero accusations, one collapse;
 *   (b) a GENUINE equivocation (two different commitments, same juror + round +
 *       phase) → still detected, blamed on that juror and no one else.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';

import { collapseSignedRecords, signedRecordIdentity } from '../courtCeremonyCore';
import { buildDkgCommitmentEvent } from '../events';
import { parseDkgCommitmentEvent } from '../eventsParse';

const HERE = dirname(fileURLToPath(import.meta.url));

interface TraceEvent {
  readonly id: string;
  readonly pubkey: string;
  readonly kind: number;
  readonly content: string;
  readonly tags: string[][];
}

interface TraceRecord {
  readonly seq: number;
  readonly round?: number;
  readonly phase: string;
  readonly from?: number;
  readonly injected?: boolean;
  readonly replayedSeq?: number;
  readonly event?: TraceEvent;
}

interface Trace {
  readonly capturedAt: string;
  readonly source: string;
  readonly records: TraceRecord[];
}

/** The relay's own receive log, captured from the failing `--scenario=replay` run. */
const TRACE = JSON.parse(
  readFileSync(join(HERE, '..', '__fixtures__', 'replay-wire-n3-k2.json'), 'utf8'),
) as Trace;

interface CommitmentEntry {
  key: string;
  identity: string | null;
  jurorIdx: number;
  injected: boolean;
  eventId: string;
}

/**
 * Exactly what the coordinator does with the relay log in
 * `scripts/court/distributed-ceremony.mjs`: attribute each `dkg-commit` record
 * to `(round, jurorIdx)`, collapse byte-identical signed events, and only then
 * ask whether a juror published two different commitments. Kept in step with
 * the harness by hand — the harness's own assertion
 * ("collapsed EVERY re-delivered commitment") fires on every replay run.
 */
function coordinatorCommitmentView(records: readonly TraceRecord[]): {
  collapsed: ReturnType<typeof collapseSignedRecords>;
  entries: CommitmentEntry[];
  unparsed: number;
  distinctJurors: number[];
  replayed: number;
} {
  const entries: CommitmentEntry[] = [];
  let unparsed = 0;
  for (const record of records) {
    if (record.phase !== 'dkg-commit' || !record.event) continue;
    const parsed = parseDkgCommitmentEvent(record.event);
    if (!parsed) {
      unparsed += 1;
      continue;
    }
    entries.push({
      key: `dkg-commit:${record.round ?? 0}:${parsed.jurorIdx}`,
      identity: signedRecordIdentity(record.event),
      jurorIdx: parsed.jurorIdx,
      injected: Boolean(record.injected),
      eventId: record.event.id,
    });
  }
  const collapsed = collapseSignedRecords(entries);
  return {
    collapsed,
    entries,
    unparsed,
    distinctJurors: [...collapsed.distinct.keys()].map(
      (key) => entries.find((e) => e.key === key)!.jurorIdx,
    ),
    replayed: entries.filter((e) => e.injected).length,
  };
}

/** Build two (or more) genuinely different, signed DKG commitments from one juror. */
function signedCommitment(
  seckey: Uint8Array,
  jurorIdx: number,
  variant: number,
): TraceEvent {
  const template = buildDkgCommitmentEvent({
    disputeId: 'd'.repeat(64),
    jurorIdx,
    jurorPubkey: getPublicKey(seckey),
    threshold: 2,
    vssCommits: [
      `02${variant.toString(16).padStart(2, '0')}${'1'.repeat(62)}`,
      `03${variant.toString(16).padStart(2, '0')}${'2'.repeat(62)}`,
    ],
    pok: { nonce: `03${'a'.repeat(64)}`, response: `${variant.toString(16).padStart(2, '0')}${'b'.repeat(62)}` },
    phaseNonce: `${variant.toString(16).padStart(2, '0')}${'c'.repeat(62)}`,
  });
  return finalizeEvent(template, seckey) as unknown as TraceEvent;
}

const record = (event: TraceEvent, round = 1): TraceRecord => ({
  seq: 0,
  round,
  phase: 'dkg-commit',
  event,
});

describe('replay is not equivocation', () => {
  it('(a) the CAPTURED replay trace produces ZERO equivocations and collapses the duplicate', () => {
    const view = coordinatorCommitmentView(TRACE.records);

    // The relay really did duplicate a commitment and deliver it late.
    expect(view.replayed).toBe(1);
    const injected = view.entries.filter((e) => e.injected);
    expect(injected).toHaveLength(1);
    const original = view.entries.find((e) => e.eventId === injected[0]!.eventId && !e.injected);
    expect(original).toBeDefined();

    // …and it is the SAME signed event: same id, same bytes, same signature.
    expect(injected[0]!.identity).toBe(original!.identity);

    // The false accusation is gone.
    expect(view.collapsed.equivocations).toEqual([]);
    expect(view.collapsed.duplicates).toBe(1);
    expect(view.collapsed.unattributable).toBe(0);
    expect(view.unparsed).toBe(0);

    // One DISTINCT commitment per juror — the three seats, no more, no less.
    expect(view.collapsed.distinct.size).toBe(3);
    expect([...view.distinctJurors].sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  it('(a2) the pre-fix comparison is what fired: two parses of ONE event are never `===`', () => {
    // This is the defect, isolated: the identity of the event is equal, the
    // payload is structurally equal, but the parsed `pok` objects are two
    // distinct references — so the old `existing.parsed.pok === parsed.pok`
    // conjunction was false for a byte-identical re-delivery, which turned the
    // "duplicate" branch off and the "equivocation" branch on.
    const commits = TRACE.records.filter((r) => r.phase === 'dkg-commit' && r.event);
    const copyEvent = commits.find((r) => r.injected)!;
    const originalEvent = commits.find((r) => r.seq === copyEvent.replayedSeq)!;

    expect(copyEvent.event!.id).toBe(originalEvent.event!.id);

    const a = parseDkgCommitmentEvent(originalEvent.event!)!;
    const b = parseDkgCommitmentEvent(copyEvent.event!)!;
    expect(a.pok).not.toBe(b.pok); // reference identity: the old predicate
    expect(a.pok).toEqual(b.pok); // value identity: what the collapse uses
    expect(a.vssCommits).toEqual(b.vssCommits);
    expect(signedRecordIdentity(originalEvent.event)).toBe(signedRecordIdentity(copyEvent.event));
  });

  it('(a3) the trace is order-independent: any arrival order yields zero accusations', () => {
    const commits = TRACE.records.filter((r) => r.phase === 'dkg-commit' && r.event);
    const reversed = coordinatorCommitmentView([...commits].reverse());
    expect(reversed.collapsed.equivocations).toEqual([]);
    expect(reversed.collapsed.distinct.size).toBe(3);
    // Whichever copy arrives first is the representative; the other is the
    // collapse. Neither is blamed.
    expect(reversed.collapsed.duplicates).toBe(1);
  });

  it('(b) a GENUINE equivocation is still detected and blamed on the right juror', () => {
    const seckeys = [generateSecretKey(), generateSecretKey(), generateSecretKey()];
    const honest1 = signedCommitment(seckeys[0]!, 1, 0x11);
    const first = signedCommitment(seckeys[1]!, 2, 0x22);
    const conflicting = signedCommitment(seckeys[1]!, 2, 0x33); // same juror, different commitment
    const honest3 = signedCommitment(seckeys[2]!, 3, 0x44);

    expect(first.id).not.toBe(conflicting.id);

    const view = coordinatorCommitmentView([
      record(honest1),
      record(first),
      record(honest3),
      record(conflicting),
    ]);

    expect(view.collapsed.equivocations).toHaveLength(1);
    expect(view.collapsed.equivocations[0]!.key).toBe('dkg-commit:1:2');
    expect(view.collapsed.duplicates).toBe(0);
    // Blame names juror 2 and ONLY juror 2 — the honest seats are untouched.
    const blamed = view.collapsed.equivocations.map(
      (e) => view.entries.find((entry) => entry.key === e.key)!.jurorIdx,
    );
    expect(blamed).toEqual([2]);
    expect(view.collapsed.distinct.size).toBe(3);
  });

  it('(b2) replay ALONGSIDE a real equivocation: the replay collapses, the equivocation is still blamed', () => {
    const seckeys = [generateSecretKey(), generateSecretKey(), generateSecretKey()];
    const honest1 = signedCommitment(seckeys[0]!, 1, 0x11);
    const first = signedCommitment(seckeys[1]!, 2, 0x22);
    const conflicting = signedCommitment(seckeys[1]!, 2, 0x33);
    const honest3 = signedCommitment(seckeys[2]!, 3, 0x44);

    const view = coordinatorCommitmentView([
      record(honest1),
      record(first),
      { ...record(first), injected: true, replayedSeq: 2 }, // relay re-delivery
      record(honest3),
      record(conflicting),
    ]);

    // The re-delivery is collapsed, never counted as a claim…
    expect(view.collapsed.duplicates).toBe(1);
    // …and the genuine second commitment is still caught, blamed on juror 2.
    expect(view.collapsed.equivocations).toHaveLength(1);
    expect(view.collapsed.equivocations[0]!.key).toBe('dkg-commit:1:2');
    expect(view.collapsed.distinct.size).toBe(3);
  });

  it('(b3) the same juror in a DIFFERENT round is a different claim, not equivocation', () => {
    const seckey = generateSecretKey();
    const round1 = signedCommitment(seckey, 2, 0x22);
    const round2 = signedCommitment(seckey, 2, 0x33);

    const view = coordinatorCommitmentView([record(round1, 1), record(round2, 2)]);
    expect(view.collapsed.equivocations).toEqual([]);
    expect(view.collapsed.distinct.size).toBe(2);
  });

  it('signedRecordIdentity: event id first, canonical payload hash as the fallback', () => {
    const id = 'e'.repeat(64);
    expect(signedRecordIdentity({ id })).toBe(`id:${id}`);
    expect(signedRecordIdentity({ id: id.toUpperCase() })).toBe(`id:${id}`);
    // No event: the canonical payload hash, independent of key order.
    expect(signedRecordIdentity(undefined, { a: 1, b: 2 })).toBe(
      signedRecordIdentity(undefined, { b: 2, a: 1 }),
    );
    expect(signedRecordIdentity(undefined, { a: 1, b: 2 })).not.toBe(
      signedRecordIdentity(undefined, { a: 1, b: 3 }),
    );
    // A record with neither an id nor a payload cannot be attributed at all.
    expect(signedRecordIdentity(undefined)).toBeNull();
    expect(signedRecordIdentity({ id: 'not-an-id' }, undefined)).toBeNull();
    expect(collapseSignedRecords([{ key: 'k', identity: null }]).unattributable).toBe(1);
  });
});
