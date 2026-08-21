// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Shared filter/dedup core for NIP-59 gift-wrap unwrapping.
 *
 * The seckey-backed unwrap path (`nip59.ts`) and the signer-backed path
 * (`courtSigner.ts`) used to copy the same rumor filter loop — dedup by rumor
 * id, kind filter, dispute filter — so filter semantics drifted (the
 * empty-disputeId hardening originally had to be applied twice). This module
 * concentrates that loop; each path keeps its own decrypt primitive and hands
 * the unwrapped rumors here.
 */

import type { Event as NostrEvent } from 'nostr-tools/pure';

/** Maximum wraps processed in one batch to prevent resource exhaustion. */
export const MAX_UNWRAP_BATCH = 10_000;

/** Filter options shared by both unwrap paths. */
export interface UnwrapFilterOptions {
  readonly kinds?: readonly number[];
  readonly disputeId?: string;
}

/**
 * Validate a kind filter — Nostr kinds are 0-65535. Malformed filters throw
 * instead of silently broadening the result set.
 */
export function assertValidUnwrapKinds(kinds: readonly number[]): void {
  for (const kind of kinds) {
    if (!Number.isSafeInteger(kind) || kind < 0 || kind > 65535) {
      throw new Error(`Invalid kind in filter: ${kind}`);
    }
  }
}

/** Reject unwrap batches above {@link MAX_UNWRAP_BATCH}. */
export function assertUnwrapBatchSize(count: number): void {
  if (count > MAX_UNWRAP_BATCH) {
    throw new Error(`unwrap batch size ${count} exceeds maximum of ${MAX_UNWRAP_BATCH}`);
  }
}

/**
 * Deduplicate unwrapped rumors by rumor id and apply the kind/dispute filter.
 *
 * An explicitly supplied filter is always active — an empty-string disputeId
 * matches nothing instead of broadening the result set.
 */
export function filterUnwrappedRumors(
  rumors: readonly (NostrEvent | null)[],
  options?: UnwrapFilterOptions,
): NostrEvent[] {
  if (options?.kinds) assertValidUnwrapKinds(options.kinds);
  const seen = new Set<string>();
  const result: NostrEvent[] = [];

  for (const rumor of rumors) {
    if (!rumor || typeof rumor.id !== 'string') continue;
    if (seen.has(rumor.id)) continue;
    seen.add(rumor.id);

    if (options?.kinds && !options.kinds.includes(rumor.kind)) continue;
    if (options?.disputeId !== undefined) {
      const disputeTag = rumor.tags.find((t) => t[0] === 'dispute');
      if (disputeTag?.[1] !== options.disputeId) continue;
    }

    result.push(rumor);
  }

  return result;
}
