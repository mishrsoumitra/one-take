/**
 * A phrase as one file: the `.phrase` files in a recording's folder on disk.
 *
 * A segment is a plain object with typed arrays inside it: the audio versions (16-bit samples), the
 * camera's encoded frames and the film of the mouth (bytes). The file is a small JSON header, in
 * which every typed array has been replaced by a reference to a blob, followed by the blobs, each
 * starting on a four-byte boundary:
 *
 *     "OTP1"  u32 header length  header JSON  (padding)  blob 0  (padding)  blob 1 ...
 *
 * Unpacking copies each blob into a buffer of its own, so the arrays come back aligned whatever the
 * header's length. Nothing in the segment is interpreted here: a field added later rides along.
 *
 * Nothing in this file touches the browser; the tests run it in Node.
 */
import { type PhraseMeta } from '@one-take/shared';

import { segmentDuration, type Segment } from '../core/timeline.js';

const MAGIC = 'OTP1';
const VERSION = 1;
const ALIGN = 4;

type BlobType = 'i16' | 'u8';

interface BlobRef {
  $bin: number;
  $t: BlobType;
}

interface BlobEntry {
  /** Offset from the start of the blob section. */
  o: number;
  /** Length in bytes. */
  n: number;
  t: BlobType;
}

interface Header {
  v: number;
  seg: unknown;
  blobs: BlobEntry[];
}

function padded(n: number): number {
  return Math.ceil(n / ALIGN) * ALIGN;
}

/** The value with every typed array taken out into `blobs` and a reference left in its place. */
function strip(value: unknown, blobs: { bytes: Uint8Array; t: BlobType }[]): unknown {
  if (value instanceof Int16Array) {
    blobs.push({ bytes: new Uint8Array(value.buffer, value.byteOffset, value.byteLength), t: 'i16' });
    return { $bin: blobs.length - 1, $t: 'i16' } satisfies BlobRef;
  }
  if (value instanceof Uint8Array) {
    blobs.push({ bytes: value, t: 'u8' });
    return { $bin: blobs.length - 1, $t: 'u8' } satisfies BlobRef;
  }
  if (Array.isArray(value)) return value.map((v) => strip(v, blobs));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) out[k] = strip(v, blobs);
    }
    return out;
  }
  return value;
}

function isBlobRef(value: unknown): value is BlobRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as BlobRef).$bin === 'number' &&
    ((value as BlobRef).$t === 'i16' || (value as BlobRef).$t === 'u8')
  );
}

/** The value with every reference replaced by its blob, copied into a buffer of its own. */
function revive(value: unknown, bytes: Uint8Array, base: number, blobs: BlobEntry[]): unknown {
  if (isBlobRef(value)) {
    const entry = blobs[value.$bin];
    if (!entry) throw new Error(`phrase file: blob ${value.$bin} is missing`);
    const from = base + entry.o;
    if (from + entry.n > bytes.byteLength) throw new Error('phrase file: a blob runs past the end');
    const copy = bytes.slice(from, from + entry.n);
    if (entry.t === 'i16') {
      if (copy.byteLength % 2 !== 0) throw new Error('phrase file: odd number of bytes for 16-bit samples');
      return new Int16Array(copy.buffer, 0, copy.byteLength / 2);
    }
    return copy;
  }
  if (Array.isArray(value)) return value.map((v) => revive(v, bytes, base, blobs));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      out[k] = revive(v, bytes, base, blobs);
    return out;
  }
  return value;
}

/** The segment as one file. */
export function packSegment(seg: Segment): Uint8Array {
  const raw: { bytes: Uint8Array; t: BlobType }[] = [];
  const stripped = strip(seg, raw);
  const blobs: BlobEntry[] = [];
  let at = 0;
  for (const b of raw) {
    blobs.push({ o: at, n: b.bytes.byteLength, t: b.t });
    at = padded(at + b.bytes.byteLength);
  }
  const header: Header = { v: VERSION, seg: stripped, blobs };
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const base = padded(8 + headerBytes.byteLength);
  const out = new Uint8Array(base + at);
  const view = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) out[i] = MAGIC.charCodeAt(i);
  view.setUint32(4, headerBytes.byteLength, true);
  out.set(headerBytes, 8);
  raw.forEach((b, i) => {
    const entry = blobs[i];
    if (entry) out.set(b.bytes, base + entry.o);
  });
  return out;
}

/** The segment back out of a file; throws when the bytes are not a phrase file. */
export function unpackSegment(bytes: Uint8Array): Segment {
  if (bytes.byteLength < 8 || String.fromCharCode(...bytes.subarray(0, 4)) !== MAGIC) {
    throw new Error('not a One Take phrase file');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = view.getUint32(4, true);
  if (8 + headerLength > bytes.byteLength) throw new Error('phrase file: the header runs past the end');
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + headerLength))) as Partial<Header>;
  if (header.v !== VERSION || !Array.isArray(header.blobs) || typeof header.seg !== 'object' || !header.seg) {
    throw new Error('phrase file: unknown version or shape');
  }
  const base = padded(8 + headerLength);
  const seg = revive(header.seg, bytes, base, header.blobs) as Partial<Segment>;
  if (
    typeof seg.id !== 'string' ||
    typeof seg.slide !== 'number' ||
    typeof seg.sampleRate !== 'number' ||
    !(seg.pcm instanceof Int16Array)
  ) {
    throw new Error('phrase file: not a phrase');
  }
  return seg as Segment;
}

/** What the upload says about the phrase, for the recording's manifest. */
export function phraseMeta(seg: Segment): PhraseMeta {
  return {
    slide: seg.slide,
    seconds: segmentDuration(seg),
    sitting: seg.sitting ?? 1,
    kind: seg.ink ? 'ink' : 'voice',
    camera: Boolean(seg.video),
    createdAt: seg.createdAt,
  };
}
