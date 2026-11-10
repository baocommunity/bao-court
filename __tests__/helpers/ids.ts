// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Deterministic hex-id factories for the Court test suite.
 *
 * Court ids are 64-char lowercase hex strings (32-byte values: session
 * hashes, proposal hashes, event ids, txids, salts). Tests need SYNTHETIC
 * ids that are readable in failure output — `hexId('a')` is `aaaa…`, so a
 * diff between `hexId('1')` and `hexId('2')` is legible. Always build ids
 * through these factories; hand-rolled `.repeat(64)` copies are how
 * inconsistent fixture ids (63-char, uppercase, wrong length) sneak in.
 */

/** Deterministic 32-byte lowercase hex id from a single hex char (or a short seed repeated to 64). */
export const hexId = (c: string): string => c.repeat(64);

/** Left-padded id: `padHexId('c10')` = `c1000…` (64 chars) — readable per-index event ids. */
export const padHexId = (prefix: string): string => prefix.padEnd(64, '0');

/** Generalized filler: repeats `c` (any length) up to exactly 64 chars. */
export const repeatHexId = (c: string): string => c.repeat(Math.ceil(64 / c.length)).slice(0, 64);

/** Id from a small integer: `byteHexId(0xb0)` = `b0b0…` — readable per-index salts/events. */
export const byteHexId = (n: number): string => n.toString(16).padStart(2, '0').repeat(32);
