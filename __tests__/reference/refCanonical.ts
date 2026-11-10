// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * INDEPENDENT reference implementation of the Court canonical serializer
 * (differential-parity round 8 — see __tests__/differentialParity.test.ts).
 *
 * Deliberately DIFFERENT implementation strategy from the production
 * `CanonicalWriter` (courtSession.ts):
 *
 *   production : chunk-push writer; DataView.setUint32/setBigUint64
 *                primitives; TextEncoder for text; @noble hexToBytes;
 *                finish() folds chunk lengths and copies into one buffer.
 *   reference  : flat `number[]` byte accumulator; manual big-endian
 *                arithmetic (shift/mask and BigInt shifts); Node Buffer
 *                for UTF-8; its own hex codec; finish() materialises the
 *                accumulator directly.
 *
 * The reference also ships a recursive-descent PARSER over the same grammar —
 * the production has no parser at all — so prefix-freeness and round-tripping
 * are tested independently of the writer that produced the bytes.
 *
 * Any byte disagreement between the two is either an implementation bug or an
 * under-specified contract; the differential suite fails loudly on either.
 */

/** Own hex codec (independent of @noble/hashes utils). */
export function refBytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes[i]!.toString(16).padStart(2, '0');
  }
  return hex;
}

export function refHexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new RangeError(`refHexToBytes: odd-length hex (${hex.length})`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    const hi = Number.parseInt(hex[2 * i]!, 16);
    const lo = Number.parseInt(hex[2 * i + 1]!, 16);
    if (Number.isNaN(hi) || Number.isNaN(lo)) {
      throw new RangeError(`refHexToBytes: non-hex character at ${2 * i}`);
    }
    out[i] = hi * 16 + lo;
  }
  return out;
}

/**
 * Reference writer: same encoding CONTRACT as CanonicalWriter
 * (u8; u32 big-endian; u64 big-endian over safe non-negative integers;
 * length-prefixed bytes/text/hex) reached through a different code path.
 */
export class RefCanonicalWriter {
  private readonly out: number[] = [];

  u8(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > 0xff) {
      throw new RangeError('ref u8 field must be an integer in [0, 255]');
    }
    this.out.push(value);
  }

  u32(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
      throw new RangeError('ref u32 field must be an integer in [0, 4294967295]');
    }
    this.out.push(
      (value >>> 24) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 8) & 0xff,
      value & 0xff,
    );
  }

  u64(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError('ref u64 field must be a safe non-negative integer');
    }
    const big = BigInt(value);
    for (let shift = 56; shift >= 0; shift -= 8) {
      this.out.push(Number((big >> BigInt(shift)) & 0xffn));
    }
  }

  bytes(value: Uint8Array): void {
    this.u32(value.length);
    for (let i = 0; i < value.length; i += 1) this.out.push(value[i]!);
  }

  text(value: string): void {
    this.bytes(Buffer.from(value, 'utf8'));
  }

  hex(value: string): void {
    // Memoised decode: differential loops re-decode the same hash strings
    // thousands of times; the cache only grows for test-sized inputs.
    let bytes = refHexCache.get(value);
    if (bytes === undefined) {
      bytes = refHexToBytes(value);
      if (refHexCache.size < 65_536) refHexCache.set(value, bytes);
    }
    this.bytes(bytes);
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.out);
  }
}

const refHexCache = new Map<string, Uint8Array>();

/** Field grammar understood by the reference parser. */
export type RefFieldKind = 'u8' | 'u32' | 'u64' | 'text' | 'hex' | 'bytes';

export interface RefParseResult {
  /** Decoded field values, in schema order (text/hex as strings, bytes as Uint8Array). */
  readonly values: unknown[];
  /** Total bytes consumed — must equal the encoded length for a full parse. */
  readonly consumed: number;
}

/**
 * Independent recursive-descent parser for the CanonicalWriter grammar.
 * Strictly bounds-checked: any truncation or over-long length prefix throws,
 * so an ambiguous (non-prefix-free) encoding can never round-trip cleanly.
 */
export function refParseCanonical(
  schema: readonly RefFieldKind[],
  buffer: Uint8Array,
): RefParseResult {
  let offset = 0;
  const need = (count: number): void => {
    if (offset + count > buffer.length) {
      throw new RangeError(
        `refParse: need ${count} byte(s) at offset ${offset}, buffer has ${buffer.length - offset}`,
      );
    }
  };
  const readU32 = (): number => {
    need(4);
    // Manual big-endian assembly — unsigned by construction (products, not signed shifts).
    const value =
      buffer[offset]! * 2 ** 24 +
      buffer[offset + 1]! * 2 ** 16 +
      buffer[offset + 2]! * 2 ** 8 +
      buffer[offset + 3]!;
    offset += 4;
    return value;
  };
  const readBytes = (): Uint8Array => {
    const length = readU32();
    need(length);
    const slice = buffer.slice(offset, offset + length);
    offset += length;
    return slice;
  };

  const values: unknown[] = [];
  for (const kind of schema) {
    switch (kind) {
      case 'u8': {
        need(1);
        values.push(buffer[offset]!);
        offset += 1;
        break;
      }
      case 'u32':
        values.push(readU32());
        break;
      case 'u64': {
        let value = 0n;
        for (let i = 0; i < 8; i += 1) {
          need(1);
          value = (value << 8n) | BigInt(buffer[offset]!);
          offset += 1;
        }
        if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new RangeError('refParse: u64 exceeds Number.MAX_SAFE_INTEGER');
        }
        values.push(Number(value));
        break;
      }
      case 'text':
        values.push(Buffer.from(readBytes()).toString('utf8'));
        break;
      case 'hex':
        values.push(refBytesToHex(readBytes()));
        break;
      case 'bytes':
        values.push(readBytes());
        break;
      default:
        throw new RangeError(`refParse: unknown field kind ${String(kind)}`);
    }
  }
  return { values, consumed: offset };
}
