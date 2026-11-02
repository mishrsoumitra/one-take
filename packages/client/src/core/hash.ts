/**
 * SHA-256 through the platform's crypto (the browser's, or Node's in the tests), as lowercase hex:
 * what names a deck across sittings and checks every upload to the recordings folder.
 */

export async function sha256Hex(data: Uint8Array | ArrayBuffer | Blob): Promise<string> {
  const bytes =
    data instanceof Blob
      ? await data.arrayBuffer()
      : data instanceof ArrayBuffer
        ? data
        : // the digest wants an ArrayBuffer of its own: the view's whole buffer when it covers it, else a copy
          data.buffer instanceof ArrayBuffer &&
            data.byteOffset === 0 &&
            data.byteLength === data.buffer.byteLength
          ? data.buffer
          : Uint8Array.from(data).buffer;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return hex(new Uint8Array(digest));
}

/**
 * One hash for a set of files in order (a PDF, or the images of a deck): the hash of their hashes,
 * so a deck of many images never needs one buffer for all of them.
 */
export async function hashFiles(files: readonly Blob[]): Promise<string> {
  const parts: string[] = [];
  for (const file of files) parts.push(await sha256Hex(file));
  return sha256Hex(new TextEncoder().encode(parts.join('\n')));
}

function hex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}
