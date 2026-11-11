// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * CAMPAIGN 6 — canonical-encoding sweep at scale.
 *
 * Generates random field mixes for the Court canonical serializer
 * (`CanonicalWriter`, `courtSession.ts`) and checks, per encoding:
 *
 *   E1  BYTE IDENTITY with the independent reference writer
 *       (`__tests__/reference/refCanonical.ts`: flat byte accumulator,
 *       hand-rolled big-endian arithmetic, Node Buffer UTF-8);
 *   E2  RE-ENCODE IDENTITY: a second, fresh write of the same fields produces
 *       the identical bytes (no hidden writer state);
 *   E3  ROUND-TRIP through the INDEPENDENT recursive-descent parser: decoded
 *       values equal the inputs and `consumed === length` (a non-prefix-free
 *       encoding could not round-trip cleanly);
 *   E4  INJECTIVITY spot-checks: mutating one field value (text, hex, u32,
 *       u64, bytes) changes the encoding, and two same-schema encodings are
 *       never a prefix of one another;
 *   E5  FAIL-CLOSED boundaries: u8/u32/u64 out-of-range and negative values
 *       throw the module's typed `CourtSessionValidationError` on BOTH writers,
 *       and the boundary values themselves (0, 255, 0xFFFFFFFF,
 *       Number.MAX_SAFE_INTEGER, empty payloads) encode and round-trip.
 *
 * The field mix covers unicode (astral, combining, RTL, CJK), the empty string,
 * 255-byte payloads, and hex/bytes payloads of length 0..32.
 */

import { CanonicalWriter, CourtSessionValidationError } from '../../courtSession';
import {
  RefCanonicalWriter,
  refBytesToHex,
  refParseCanonical,
  refHexToBytes,
  type RefFieldKind,
} from '../reference/refCanonical';
import { childRng, int } from '../helpers/rng';
import { CampaignReporter, nowMs, type CampaignResult } from './corpus';

/** One generated field value in schema order. */
type FieldValue =
  | { readonly kind: 'u8'; readonly value: number }
  | { readonly kind: 'u32'; readonly value: number }
  | { readonly kind: 'u64'; readonly value: number }
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'hex'; readonly value: string }
  | { readonly kind: 'bytes'; readonly value: Uint8Array };

/** Text pool: ASCII, empty, astral, combining, RTL, CJK, and a boundary length. */
const TEXT_POOL = [
  '', 'YES', 'NO', 'a', 'é', '😀', 'e\u0301', 'שלום', '日本語テキスト', '\uFFFF', '\u{10FFFF}',
  'x'.repeat(64), 'y'.repeat(255), 'mixed 123 !@#$%^&*() é😀',
] as const;

const HEX_DIGITS = '0123456789abcdef';

/** Write a field mix with the production writer. */
function writeCanonical(fields: readonly FieldValue[]): Uint8Array {
  const writer = new CanonicalWriter();
  for (const field of fields) {
    switch (field.kind) {
      case 'u8': writer.u8(field.value); break;
      case 'u32': writer.u32(field.value); break;
      case 'u64': writer.u64(field.value); break;
      case 'text': writer.text(field.value); break;
      case 'hex': writer.hex(field.value); break;
      case 'bytes': writer.bytes(field.value); break;
      default: throw new Error(`unknown field kind ${String((field as { kind?: unknown }).kind)}`);
    }
  }
  return writer.finish();
}

/** Write the same mix with the independent reference writer. */
function writeReference(fields: readonly FieldValue[]): Uint8Array {
  const writer = new RefCanonicalWriter();
  for (const field of fields) {
    switch (field.kind) {
      case 'u8': writer.u8(field.value); break;
      case 'u32': writer.u32(field.value); break;
      case 'u64': writer.u64(field.value); break;
      case 'text': writer.text(field.value); break;
      case 'hex': writer.hex(field.value); break;
      case 'bytes': writer.bytes(field.value); break;
      default: throw new Error(`unknown field kind ${String((field as { kind?: unknown }).kind)}`);
    }
  }
  return writer.finish();
}

/** Generate one field mix from stream `r`. */
function generate(r: () => number): FieldValue[] {
  const length = int(r, 1, 8);
  const fields: FieldValue[] = [];
  for (let index = 0; index < length; index += 1) {
    switch (int(r, 0, 5)) {
      case 0:
        fields.push({ kind: 'u8', value: r() < 0.3 ? pickBoundary(r, 255) : int(r, 0, 255) });
        break;
      case 1:
        fields.push({ kind: 'u32', value: r() < 0.3 ? pickBoundary(r, 0xffff_ffff) : int(r, 0, 0xffff_ffff) });
        break;
      case 2:
        fields.push({ kind: 'u64', value: r() < 0.3 ? pickBoundary(r, Number.MAX_SAFE_INTEGER) : int(r, 0, Number.MAX_SAFE_INTEGER) });
        break;
      case 3:
        fields.push({ kind: 'text', value: TEXT_POOL[int(r, 0, TEXT_POOL.length - 1)]! });
        break;
      case 4: {
        // 0..32 BYTES of hex payload (two hex chars per byte).
        const bytes = int(r, 0, 32);
        let hex = '';
        for (let i = 0; i < bytes * 2; i += 1) hex += HEX_DIGITS[Math.floor(r() * 16)];
        fields.push({ kind: 'hex', value: hex });
        break;
      }
      default: {
        const bytes = int(r, 0, 32);
        const value = new Uint8Array(bytes);
        for (let i = 0; i < bytes; i += 1) value[i] = Math.floor(r() * 256);
        fields.push({ kind: 'bytes', value });
        break;
      }
    }
  }
  return fields;
}

function pickBoundary(r: () => number, max: number): number {
  return r() < 0.5 ? 0 : max;
}

/** The parser schema for a mix (production kind names are the reference kinds). */
function schemaOf(fields: readonly FieldValue[]): RefFieldKind[] {
  return fields.map((field) => field.kind);
}

/** True when `prefix` is a byte-prefix of `value` (used for the prefix-freeness check). */
function isPrefix(prefix: Uint8Array, value: Uint8Array): boolean {
  if (prefix.length > value.length) return false;
  for (let i = 0; i < prefix.length; i += 1) if (prefix[i] !== value[i]) return false;
  return true;
}

/**
 * Run the encoding campaign.
 *
 * @param opts.size number of encodings
 * @param opts.seed campaign seed
 */
export function runEncodingCampaign(opts: { readonly size: number; readonly seed?: number }): CampaignResult {
  const seed = opts.seed ?? 20_261_111;
  const started = nowMs();
  const reporter = new CampaignReporter('encoding', 'encodings', opts.size, seed);
  const r = childRng(seed, 'encoding-campaign');

  const metrics = {
    totalBytes: 0,
    maxBytes: 0,
    roundTrips: 0,
    injectivityMutations: 0,
    prefixComparisons: 0,
    boundaryRejections: 0,
    unicodeEncodings: 0,
    emptyPayloadEncodings: 0,
  };

  const boundaryProbes: Array<{ name: string; write: (writer: CanonicalWriter) => void; refWrite: (writer: RefCanonicalWriter) => void }> = [
    { name: 'u8-256', write: (w) => w.u8(256), refWrite: (w) => w.u8(256) },
    { name: 'u8-negative', write: (w) => w.u8(-1), refWrite: (w) => w.u8(-1) },
    { name: 'u8-fraction', write: (w) => w.u8(1.5), refWrite: (w) => w.u8(1.5) },
    { name: 'u32-negative', write: (w) => w.u32(-1), refWrite: (w) => w.u32(-1) },
    { name: 'u32-overflow', write: (w) => w.u32(0x1_0000_0000), refWrite: (w) => w.u32(0x1_0000_0000) },
    { name: 'u32-fraction', write: (w) => w.u32(2.5), refWrite: (w) => w.u32(2.5) },
    { name: 'u64-negative', write: (w) => w.u64(-1), refWrite: (w) => w.u64(-1) },
    { name: 'u64-unsafe', write: (w) => w.u64(Number.MAX_SAFE_INTEGER + 2), refWrite: (w) => w.u64(Number.MAX_SAFE_INTEGER + 2) },
    { name: 'u64-fraction', write: (w) => w.u64(3.5), refWrite: (w) => w.u64(3.5) },
  ];

  for (let index = 0; index < opts.size; index += 1) {
    const fields = generate(r);
    const label = `encoding#${index}`;

    let bytes: Uint8Array;
    let reference: Uint8Array;
    try {
      bytes = writeCanonical(fields);
      reference = writeReference(fields);
    } catch (err) {
      reporter.fail(label, `a generated field mix threw: ${describe(err)}`);
      continue;
    }

    // E1 — byte identity with the independent writer.
    reporter.equalStrings(label, [refBytesToHex(bytes)], [refBytesToHex(reference)], 'E1: production and reference encodings must be byte-identical');

    // E2 — re-encode identity.
    const again = writeCanonical(fields);
    reporter.equalStrings(label, [refBytesToHex(bytes)], [refBytesToHex(again)], 'E2: re-encoding the same fields must produce identical bytes');

    // E3 — independent parser round-trip.
    const schema = schemaOf(fields);
    try {
      const parsed = refParseCanonical(schema, bytes);
      reporter.equals(label, parsed.consumed, bytes.length, 'E3: the parser must consume exactly the encoded bytes');
      const decodedOk = fields.every((field, position) => {
        const decoded = parsed.values[position];
        switch (field.kind) {
          case 'u8':
          case 'u32':
          case 'u64':
            return Object.is(decoded, field.value);
          case 'text':
            return decoded === field.value;
          case 'hex':
            return decoded === field.value;
          case 'bytes': {
            const value = decoded as Uint8Array;
            return value.length === field.value.length && field.value.every((byte, i) => value[i] === byte);
          }
          default:
            return false;
        }
      });
      reporter.ok(label, decodedOk, 'E3: decoded values must equal the encoded field values');
      metrics.roundTrips += 1;
    } catch (err) {
      reporter.fail(label, `E3: independent parse threw: ${describe(err)}`);
    }

    // E4 — injectivity: flip one field and require different bytes.
    if (index % 10 === 0) {
      const mutated = mutateOneField(fields, index, r);
      if (mutated !== null) {
        const mutatedBytes = writeCanonical(mutated);
        reporter.ok(
          label,
          refBytesToHex(bytes) !== refBytesToHex(mutatedBytes),
          'E4: a single mutated field must change the encoding (injectivity)',
        );
        metrics.injectivityMutations += 1;
      }
      // Prefix-freeness across two mixes of the SAME schema.
      const sibling = regenerateWithSchema(schema, r);
      const siblingBytes = writeCanonical(sibling);
      // Length prefixes make the grammar prefix-free per schema: two distinct
      // same-schema encodings can never shadow one another.
      if (refBytesToHex(bytes) !== refBytesToHex(siblingBytes)) {
        reporter.ok(
          label,
          !isPrefix(bytes, siblingBytes) && !isPrefix(siblingBytes, bytes),
          'E4: two distinct same-schema encodings must not be prefixes of one another',
        );
      }
      metrics.prefixComparisons += 1;
    }

    metrics.totalBytes += bytes.length;
    metrics.maxBytes = Math.max(metrics.maxBytes, bytes.length);
    if (fields.some((field) => field.kind === 'text' && /[^\x00-\x7f]/.test(field.value))) metrics.unicodeEncodings += 1;
    if (fields.some((field) => (field.kind === 'hex' || field.kind === 'bytes' || field.kind === 'text') && fieldLength(field) === 0)) {
      metrics.emptyPayloadEncodings += 1;
    }
  }

  // E5 — fail-closed boundaries on both writers.
  for (const probe of boundaryProbes) {
    let productionThrew = false;
    try {
      probe.write(new CanonicalWriter());
    } catch (err) {
      productionThrew = err instanceof CourtSessionValidationError;
    }
    reporter.ok(`boundary/${probe.name}`, productionThrew, `E5: ${probe.name} must throw CourtSessionValidationError on the production writer`);
    let referenceThrew = false;
    try {
      probe.refWrite(new RefCanonicalWriter());
    } catch {
      referenceThrew = true;
    }
    reporter.ok(`boundary/${probe.name}`, referenceThrew, `E5: ${probe.name} must throw on the reference writer`);
    metrics.boundaryRejections += 1;
  }

  const wallMs = nowMs() - started;
  return reporter.finish(
    wallMs,
    {
      ...metrics,
      meanBytes: Math.round((metrics.totalBytes / Math.max(1, opts.size)) * 100) / 100,
      encodingsPerSecond: Math.round((opts.size / Math.max(1, wallMs)) * 1000),
    },
    [
      'field mixes of 1..8 fields over u8/u32/u64/text/hex/bytes with boundary and unicode values',
      'injectivity + prefix-freeness checks on every 10th encoding',
      `fail-closed boundary probes: ${boundaryProbes.length} (both writers)`,
    ],
  );
}

/** Length of a payload-carrying field (used for the empty-payload metric). */
function fieldLength(field: FieldValue): number {
  switch (field.kind) {
    case 'text': return new TextEncoder().encode(field.value).length;
    case 'hex': return refHexToBytes(field.value).length;
    case 'bytes': return field.value.length;
    default: return 1;
  }
}

/** Mutate exactly one field (returns `null` when no mutation is possible). */
function mutateOneField(fields: readonly FieldValue[], index: number, r: () => number): FieldValue[] | null {
  if (fields.length === 0) return null;
  const position = index % fields.length;
  const copy = [...fields];
  const field = fields[position]!;
  switch (field.kind) {
    case 'u8':
      copy[position] = { kind: 'u8', value: (field.value + 1) % 256 };
      return copy;
    case 'u32':
      copy[position] = { kind: 'u32', value: field.value === 0xffff_ffff ? 0 : field.value + 1 };
      return copy;
    case 'u64':
      copy[position] = { kind: 'u64', value: field.value === Number.MAX_SAFE_INTEGER ? 0 : field.value + 1 };
      return copy;
    case 'text':
      copy[position] = { kind: 'text', value: `${field.value}${TEXT_POOL[int(r, 1, TEXT_POOL.length - 1)]!}` };
      return copy;
    case 'hex': {
      const original = refHexToBytes(field.value);
      const bytes = new Uint8Array(original.length + 1);
      bytes.set(original, 0);
      bytes[bytes.length - 1] = 0xff;
      copy[position] = { kind: 'hex', value: refBytesToHex(bytes) };
      return copy;
    }
    case 'bytes': {
      const value = new Uint8Array(field.value.length + 1);
      value.set(field.value, 0);
      value[value.length - 1] = 0xff;
      copy[position] = { kind: 'bytes', value };
      return copy;
    }
    default:
      return null;
  }
}

/** Regenerate a mix with the SAME schema but different values. */
function regenerateWithSchema(schema: readonly RefFieldKind[], r: () => number): FieldValue[] {
  return schema.map((kind): FieldValue => {
    switch (kind) {
      case 'u8': return { kind: 'u8', value: int(r, 0, 255) };
      case 'u32': return { kind: 'u32', value: int(r, 0, 0xffff_ffff) };
      case 'u64': return { kind: 'u64', value: int(r, 0, Number.MAX_SAFE_INTEGER) };
      case 'text': return { kind: 'text', value: TEXT_POOL[int(r, 0, TEXT_POOL.length - 1)]! };
      case 'hex': {
        const bytes = int(r, 0, 32);
        let hex = '';
        for (let i = 0; i < bytes * 2; i += 1) hex += HEX_DIGITS[Math.floor(r() * 16)];
        return { kind: 'hex', value: hex };
      }
      default: {
        const bytes = int(r, 0, 32);
        const value = new Uint8Array(bytes);
        for (let i = 0; i < bytes; i += 1) value[i] = Math.floor(r() * 256);
        return { kind: 'bytes', value };
      }
    }
  });
}

function describe(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
