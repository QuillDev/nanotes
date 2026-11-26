import * as Y from "yjs";

/**
 * Applies a minimal single-span text diff from `ytext.toString()` to `nextText`
 * inside one Yjs transaction. Preserves concurrent CRDT edits outside the changed span.
 * Returns true if any edit was applied.
 */
export function applyTextDiff(ytext: Y.Text, nextText: string, origin?: unknown): boolean {
  const prevText = ytext.toString();
  if (prevText === nextText) return false;

  let prefix = 0;
  const minLen = Math.min(prevText.length, nextText.length);
  while (prefix < minLen && prevText.charCodeAt(prefix) === nextText.charCodeAt(prefix)) {
    prefix += 1;
  }

  let suffix = 0;
  const maxSuffix = minLen - prefix;
  while (
    suffix < maxSuffix &&
    prevText.charCodeAt(prevText.length - 1 - suffix) === nextText.charCodeAt(nextText.length - 1 - suffix)
  ) {
    suffix += 1;
  }

  const deleteLen = prevText.length - prefix - suffix;
  const inserted = nextText.slice(prefix, nextText.length - suffix);

  const apply = () => {
    if (deleteLen > 0) ytext.delete(prefix, deleteLen);
    if (inserted.length > 0) ytext.insert(prefix, inserted);
  };

  if (ytext.doc) {
    ytext.doc.transact(apply, origin);
  } else {
    apply();
  }
  return true;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function base64ToBytes(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}
