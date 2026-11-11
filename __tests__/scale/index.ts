// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * THE SCALE CAMPAIGN REGISTRY — one entry per large-corpus campaign, shared by
 * the vitest FAST subset (`__tests__/scale/scaleCampaign.test.ts`, CI) and the
 * standalone FULL runner (`scripts/campaign/run-campaign.mjs`, the round's
 * artifact).
 *
 * Corpus sizes live in `corpus.ts` (`SIZES`); this module only wires the
 * campaigns, resolves the profile, and aggregates the results. A campaign's
 * reported corpus size is what ACTUALLY ran — the runner may override a size
 * (the documented split when the full corpus cannot finish inside the runtime
 * envelope) and the override is visible in the artifact.
 */

import {
  SIZES,
  sizeFor,
  type CampaignResult,
  type ProfileName,
} from './corpus';
import { runConfirmationCampaign } from './confirmationCorpus';
import { runTallyCampaign } from './tallyCorpus';
import { runMerkleCampaign } from './merkleCorpus';
import { runValidatorCampaign } from './validatorCorpus';
import { runSelectionCampaign } from './selectionCorpus';
import { runEncodingCampaign } from './encodingCorpus';

/** The campaign names, in artifact order. */
export const CORPUS_NAMES = [
  'confirmation',
  'tally',
  'merkle',
  'validator',
  'selection',
  'encoding',
] as const;

export type CorpusName = (typeof CORPUS_NAMES)[number];

/** One registered campaign. */
export interface CampaignDefinition {
  readonly name: CorpusName;
  readonly units: string;
  readonly what: string;
  readonly sizes: { readonly fast: number; readonly full: number };
  readonly run: (size: number, seed: number, chiSquareDraws: number) => CampaignResult;
}

export const CAMPAIGNS: Record<CorpusName, CampaignDefinition> = {
  confirmation: {
    name: 'confirmation',
    units: 'sequences',
    what: 'legal confirmation-machine event sequences, invariants after every transition',
    sizes: SIZES.confirmationSequences,
    run: (size, seed) => runConfirmationCampaign({ size, seed }),
  },
  tally: {
    name: 'tally',
    units: 'tallies',
    what: 'plurality tallies finalized through the vote machine vs the independent reduce oracle',
    sizes: SIZES.tallies,
    run: (size, seed) => runTallyCampaign({ size, seed }),
  },
  merkle: {
    name: 'merkle',
    units: 'batches',
    what: 'Merkle batches (n = 1..2048) with every sampled proof + tamper matrix',
    sizes: SIZES.merkleBatches,
    run: (size, seed) => runMerkleCampaign({ size, seed }),
  },
  validator: {
    name: 'validator',
    units: 'events',
    what: 'signed v2 attestation events through the accept/reject matrix',
    sizes: SIZES.attestationEvents,
    run: (size, seed) => runValidatorCampaign({ size, seed }),
  },
  selection: {
    name: 'selection',
    units: 'draws',
    what: 'jury draws (rosters 3..500, both weight modes) + weight-proportionality chi-square',
    sizes: SIZES.selectionDraws,
    run: (size, seed, chiSquareDraws) => runSelectionCampaign({ size, seed, chiSquareDraws }),
  },
  encoding: {
    name: 'encoding',
    units: 'encodings',
    what: 'canonical encodings: byte identity, re-encode, parser round-trip, injectivity',
    sizes: SIZES.encodings,
    run: (size, seed) => runEncodingCampaign({ size, seed }),
  },
};

/** Options for one campaign invocation. */
export interface CampaignRunOptions {
  readonly profile: ProfileName;
  /** Restrict the run to these campaigns (default: all). */
  readonly only?: readonly CorpusName[];
  readonly seed?: number;
  /** Per-campaign corpus-size overrides (the documented split). */
  readonly sizes?: Partial<Record<CorpusName, number>>;
  /** Chi-square trial count (default: the profile's `chiSquareDraws`). */
  readonly chiSquareDraws?: number;
  /** Progress callback (the runner prints one line per campaign). */
  readonly onStart?: (name: CorpusName, size: number) => void;
  readonly onFinish?: (result: CampaignResult) => void;
}

/** The aggregated result of one invocation. */
export interface CampaignRun {
  readonly profile: ProfileName;
  readonly seed: number;
  readonly startedAt: string;
  readonly wallMs: number;
  readonly results: readonly CampaignResult[];
  readonly failedChecks: number;
  readonly corporaRun: number;
}

/** Default campaign seed — every campaign derives its streams from it. */
export const DEFAULT_SEED = 20_261_111;

/** Resolve the corpus size for one campaign under a run's options. */
export function corpusSizeFor(
  definition: CampaignDefinition,
  options: CampaignRunOptions,
): number {
  const override = options.sizes?.[definition.name];
  if (override !== undefined) return override;
  return sizeFor(definition.sizes, options.profile);
}

/** The DECLARED corpus sizes for a profile (what the round set out to run). */
export function declaredSizes(profile: ProfileName): Record<CorpusName, number> {
  const declared = {} as Record<CorpusName, number>;
  for (const name of CORPUS_NAMES) declared[name] = sizeFor(CAMPAIGNS[name].sizes, profile);
  return declared;
}

/** Run the selected campaigns sequentially and aggregate the results. */
export function runCampaign(options: CampaignRunOptions): CampaignRun {
  const seed = options.seed ?? DEFAULT_SEED;
  const names = options.only && options.only.length > 0 ? options.only : CORPUS_NAMES;
  const chiSquareDraws = options.chiSquareDraws ?? sizeFor(SIZES.chiSquareDraws, options.profile);
  const startedAt = new Date().toISOString();
  const started = nowMs();
  const results: CampaignResult[] = [];

  for (const name of names) {
    const definition = CAMPAIGNS[name];
    const size = corpusSizeFor(definition, options);
    options.onStart?.(name, size);
    const result = definition.run(size, seed, chiSquareDraws);
    results.push(result);
    options.onFinish?.(result);
  }

  return {
    profile: options.profile,
    seed,
    startedAt,
    wallMs: nowMs() - started,
    results,
    failedChecks: results.reduce((sum, result) => sum + result.failedChecks, 0),
    corporaRun: results.length,
  };
}

function nowMs(): number {
  return performance.now();
}
