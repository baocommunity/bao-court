// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * FrostAppealWatcher — listens for FROST dispute attestations (Kind 39007)
 * and routes validated override outcomes into the existing settlement flow.
 *
 * This is a minimal integration seam. Consumers register the group public key
 * for each market they care about; when a valid Kind 39007 arrives for that
 * market, the watcher calls back with the override outcome.
 *
 * The package is transport-agnostic: the host injects a nostr-tools
 * `SimplePool` (or compatible) via `config.pool`. Subscription methods
 * (`start`/`watchMarket` live-resubscribe) require it; pure event handling
 * (`handleEvent`/`handleEvents`) works without any pool.
 */

import type { Event as NostrEvent, Filter } from 'nostr-tools';
import { validateAttestationEvent } from './validator';

/**
 * Narrow structural contract for the host-injected relay pool. nostr-tools'
 * `SimplePool` satisfies it structurally, so hosts can pass a real pool
 * unchanged — but tests and alternative transports only need to provide
 * `subscribeMany`, not the full SimplePool surface.
 */
export interface FrostWatcherRelayPool {
  subscribeMany(
    relays: readonly string[],
    filter: Filter,
    handlers: { onevent(event: NostrEvent): void },
  ): { close(): void };
}

export interface FrostAppealWatcherConfig {
  readonly relays: string[];
  /**
   * Host-injected relay pool — any object satisfying
   * {@link FrostWatcherRelayPool} (nostr-tools' `SimplePool` does).
   * Required for live relay subscriptions (`start`, resubscription on
   * `watchMarket`); optional for direct event handling
   * (`handleEvent`/`handleEvents`).
   */
  readonly pool?: FrostWatcherRelayPool;
  /** Optional resolver for the FROST group pubkey of a market. When provided,
   *  the watcher can validate Kind 39007 events for markets it has not been
   *  explicitly told to watch (e.g. by reading from IndexedDB). */
  getGroupPubkey?: (marketId: string) => string | undefined | Promise<string | undefined>;
  /** When true, subscribe to all Kind 39007 events and rely on the resolver
   *  and validator to filter relevant markets. This avoids missing attestations
   *  when the watch list is maintained elsewhere. */
  watchAll?: boolean;
}

export interface FrostAppealResolution {
  readonly marketId: string;
  readonly outcome: string;
  readonly disputeEventId: string;
  readonly groupPubkey: string;
  readonly eventId: string;
}

export interface FrostAppealWatcherCallbacks {
  readonly onResolution?: (resolution: FrostAppealResolution) => void | Promise<void>;
  readonly onError?: (error: Error, event: NostrEvent) => void;
}

export class FrostAppealWatcher {
  private readonly relays: string[];
  private readonly pool?: FrostWatcherRelayPool;
  private readonly marketGroupPubkeys = new Map<string, string>();
  private readonly processedEventIds = new Set<string>();
  /** Ids mid-validation — closes the concurrent-redelivery window (dedup is
   *  recorded only after validation succeeds, so duplicate relay callbacks
   *  arriving while an async group-pubkey resolution is pending could both
   *  pass the processedEventIds check and double-fire onResolution). */
  private readonly inFlightEventIds = new Set<string>();
  private callbacks: FrostAppealWatcherCallbacks = {};
  private subscriptionCloser: (() => void) | null = null;
  private active = false;
  private watchAllMarkets: boolean;
  private getGroupPubkey?: (marketId: string) => string | undefined | Promise<string | undefined>;

  private static readonly MAX_PROCESSED_EVENTS = 10_000;

  constructor(config: FrostAppealWatcherConfig) {
    this.relays = config.relays;
    this.pool = config.pool;
    this.getGroupPubkey = config.getGroupPubkey;
    this.watchAllMarkets = config.watchAll ?? false;
  }

  /**
   * Set or replace the group-pubkey resolver. Useful when the resolver depends
   * on runtime state (e.g. an IndexedDB connection) that isn't available at
   * construction time.
   */
  setGroupPubkeyResolver(
    resolver: (marketId: string) => string | undefined | Promise<string | undefined>,
  ): void {
    this.getGroupPubkey = resolver;
  }

  /**
   * Register a market to watch. The group pubkey is the x-only public key
   * produced by the FROST DKG for that market; it is required to validate
   * Kind 39007 attestations.
   */
  watchMarket(marketId: string, groupPubkey: string): void {
    this.marketGroupPubkeys.set(marketId, groupPubkey);
    if (this.active) {
      this._resubscribe();
    }
  }

  unwatchMarket(marketId: string): void {
    this.marketGroupPubkeys.delete(marketId);
    if (this.active && this.marketGroupPubkeys.size === 0 && !this.watchAllMarkets) {
      this.stop();
    } else if (this.active) {
      this._resubscribe();
    }
  }

  /**
   * Subscribe to all Kind 39007 attestations and rely on the configured
   * resolver/validator to filter relevant markets. Useful for decentralized
   * watcher backends that do not maintain an explicit watch list.
   */
  watchAll(): void {
    this.watchAllMarkets = true;
    if (this.active) {
      this._resubscribe();
    }
  }

  /**
   * Stop the broad subscription mode. Explicitly watched markets remain active.
   */
  unwatchAll(): void {
    this.watchAllMarkets = false;
    if (this.active) {
      this._resubscribe();
    }
  }

  /**
   * Provide watcher callbacks. Can be called multiple times to update handlers.
   */
  setCallbacks(callbacks: FrostAppealWatcherCallbacks): void {
    this.callbacks = callbacks;
  }

  /**
   * Start listening for FROST attestations across all watched markets.
   */
  start(): void {
    if (this.active) return;
    this.active = true;
    this._resubscribe();
  }

  /**
   * Stop listening and clean up.
   */
  stop(): void {
    this.active = false;
    if (this.subscriptionCloser) {
      this.subscriptionCloser();
      this.subscriptionCloser = null;
    }
  }

  /**
   * Process a batch of events in order. Returns all valid resolutions.
   */
  async handleEvents(events: readonly NostrEvent[]): Promise<FrostAppealResolution[]> {
    const resolutions: FrostAppealResolution[] = [];
    for (const event of events) {
      try {
        const resolution = await this.handleEvent(event);
        if (resolution) {
          resolutions.push(resolution);
        }
      } catch (err) {
        this.callbacks.onError?.(err as Error, event);
      }
    }
    return resolutions;
  }

  /**
   * Process a single event. Resolves the group pubkey from the local watch list
   * first, then falls back to the configured resolver (which may be async and
   * read from IndexedDB). Useful for tests and queued events.
   */
  async handleEvent(event: NostrEvent): Promise<FrostAppealResolution | null> {
    if (event.kind !== 39007) return null;
    if (event.id) {
      if (this.processedEventIds.has(event.id)) return null;
      // Reserve synchronously, before any await: duplicate deliveries can race
      // while the group-pubkey resolver is pending, and both would otherwise
      // pass the processedEventIds check above.
      if (this.inFlightEventIds.has(event.id)) return null;
      this.inFlightEventIds.add(event.id);
    }
    try {
      const marketId =
        event.tags.find((t) => t[0] === 'm' || t[0] === 'market')?.[1] ??
        event.tags.find((t) => t[0] === 'e' && t[3] === 'root')?.[1];
      if (!marketId) return null;

      let groupPubkey = this.marketGroupPubkeys.get(marketId);
      if (!groupPubkey && this.getGroupPubkey) {
        const resolved = await this.getGroupPubkey(marketId);
        if (resolved) groupPubkey = resolved;
      }
      if (!groupPubkey) return null;

      const validation = validateAttestationEvent(event, groupPubkey);
      if (!validation.valid) {
        this.callbacks.onError?.(
          new Error(validation.error ?? 'Invalid FROST attestation'),
          event,
        );
        return null;
      }

      const outcome = event.tags.find((t) => t[0] === 'o' || t[0] === 'outcome')?.[1];
      if (!outcome) return null;

      const disputeEventId = event.tags.find((t) => t[0] === 'dispute')?.[1] ?? '';

      if (event.id) {
        this._recordProcessed(event.id);
      }

      return {
        marketId,
        outcome,
        disputeEventId,
        groupPubkey,
        eventId: event.id,
      };
    } finally {
      // Release the reservation whether validation succeeded, failed, or threw:
      // only genuinely processed events stay in processedEventIds, so a failed
      // delivery remains retryable exactly as before.
      if (event.id) this.inFlightEventIds.delete(event.id);
    }
  }

  private _resubscribe(): void {
    if (this.subscriptionCloser) {
      this.subscriptionCloser();
      this.subscriptionCloser = null;
    }
    if (this.marketGroupPubkeys.size === 0 && !this.watchAllMarkets) return;
    if (!this.pool) {
      throw new Error(
        'FrostAppealWatcher: live subscriptions require a host-injected SimplePool (config.pool)',
      );
    }
    const pool = this.pool;

    const marketIds = Array.from(this.marketGroupPubkeys.keys());
    const since = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
    const filter: Filter = this.watchAllMarkets
      ? { kinds: [39007], since }
      : { kinds: [39007], since, '#m': marketIds };

    const sub = pool.subscribeMany(
      this.relays,
      filter,
      {
        onevent: (event: NostrEvent) => {
          void (async () => {
            try {
              const resolution = await this.handleEvent(event);
              if (resolution) {
                await this.callbacks.onResolution?.(resolution);
              }
            } catch (err) {
              this.callbacks.onError?.(err as Error, event);
            }
          })();
        },
      },
    );

    this.subscriptionCloser = () => { sub.close(); };
  }

  private _recordProcessed(eventId: string): void {
    if (this.processedEventIds.size >= FrostAppealWatcher.MAX_PROCESSED_EVENTS) {
      const first = this.processedEventIds.keys().next().value;
      if (first !== undefined) this.processedEventIds.delete(first);
    }
    this.processedEventIds.add(eventId);
  }
}
