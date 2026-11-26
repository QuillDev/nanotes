/** The small CBOR subset WebAuthn uses: ints, byte and text strings, arrays, maps and simple values. */

export type CborValue = number | Uint8Array | string | boolean | null | CborValue[] | Map<CborValue, CborValue>;

export class CborError extends Error {}

const MAX_DEPTH = 32;

function argument(data: Uint8Array, offset: number, info: number): [number, number] {
  if (info < 24) return [info, offset];
  const size = ({ 24: 1, 25: 2, 26: 4, 27: 8 } as Record<number, number>)[info];
  if (size === undefined) throw new CborError("indefinite or reserved CBOR length");
  if (offset + size > data.length) throw new CborError("truncated CBOR length");
  let value = 0;
  for (let i = 0; i < size; i += 1) value = value * 256 + (data[offset + i] as number);
  if (!Number.isSafeInteger(value)) throw new CborError("CBOR integer too large");
  return [value, offset + size];
}

export function decode(data: Uint8Array, offset = 0, depth = 0): [CborValue, number] {
  if (depth > MAX_DEPTH) throw new CborError("CBOR nesting too deep");
  if (offset >= data.length) throw new CborError("truncated CBOR");
  const initial = data[offset] as number;
  const major = initial >> 5;
  const info = initial & 0x1f;
  offset += 1;
  if (major === 7) {
    if (info === 20) return [false, offset];
    if (info === 21) return [true, offset];
    if (info === 22 || info === 23) return [null, offset];
    throw new CborError("unsupported CBOR simple value");
  }
  const [length, start] = argument(data, offset, info);
  if (major === 0) return [length, start];
  if (major === 1) return [-1 - length, start];
  if (major === 2 || major === 3) {
    const end = start + length;
    if (end > data.length) throw new CborError("truncated CBOR string");
    const raw = data.slice(start, end);
    return [major === 2 ? raw : new TextDecoder("utf-8", { fatal: true }).decode(raw), end];
  }
  if (major === 4) {
    const items: CborValue[] = [];
    let at = start;
    for (let i = 0; i < length; i += 1) {
      const [item, next] = decode(data, at, depth + 1);
      items.push(item);
      at = next;
    }
    return [items, at];
  }
  if (major === 5) {
    const map = new Map<CborValue, CborValue>();
    let at = start;
    for (let i = 0; i < length; i += 1) {
      const [key, afterKey] = decode(data, at, depth + 1);
      const [value, afterValue] = decode(data, afterKey, depth + 1);
      map.set(key, value);
      at = afterValue;
    }
    return [map, at];
  }
  throw new CborError(`unsupported CBOR major type ${major}`);
}

export function decodeAll(data: Uint8Array): CborValue {
  const [value, end] = decode(data);
  if (end !== data.length) throw new CborError("trailing bytes after CBOR item");
  return value;
}
