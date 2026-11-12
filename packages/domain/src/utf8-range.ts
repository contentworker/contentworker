/**
 * UTF-8 without the runtime's encoders (the domain declares no runtime libraries): what a ranged
 * read of stored text (`BlobStore.getRange`) needs to cut whole characters out of a byte range.
 */

/** Bytes a UTF-8 sequence takes, from its lead byte (a stray continuation byte counts as one). */
const widthOf = (lead: number) =>
  lead < 0x80 ? 1 : lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;

/** `text` as UTF-8 bytes. */
export function encodeUtf8(text: string): Uint8Array {
  const out: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return Uint8Array.from(out);
}

/** Whole UTF-8 sequences decoded; a malformed one reads as U+FFFD, as a decoder's would. */
function decodeUtf8(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; ) {
    const lead = bytes[i] as number;
    const width = widthOf(lead);
    if (width === 1) {
      out += lead < 0x80 ? String.fromCharCode(lead) : '�';
      i += 1;
      continue;
    }
    let cp = lead & (0xff >> (width + 1));
    let ok = i + width <= bytes.length;
    for (let k = 1; ok && k < width; k++) {
      const b = bytes[i + k] as number;
      if ((b & 0xc0) !== 0x80) ok = false;
      else cp = (cp << 6) | (b & 0x3f);
    }
    out += ok && cp <= 0x10ffff ? String.fromCodePoint(cp) : '�';
    i += ok ? width : 1;
  }
  return out;
}

/**
 * A byte range of UTF-8 text decoded whole. A range can start or end inside a character (a
 * multi-byte one split by the offsets), so the start moves forward past any continuation bytes and
 * the end moves back before a character the range doesn't hold all of: the text is never half a
 * character, and the next read, from `end`, starts where this one stopped.
 *
 * `bytes` are the range's bytes as read; `offset` is the byte they start at in the object.
 */
export function decodeUtf8Range(
  bytes: Uint8Array,
  offset: number,
): { readonly text: string; readonly start: number; readonly end: number } {
  let from = 0;
  // A continuation byte (10xxxxxx) can't start a character: the one it belongs to began earlier.
  while (from < bytes.length && ((bytes[from] as number) & 0xc0) === 0x80) from += 1;
  let to = bytes.length;
  // Back from the end to the last lead byte; if its character runs past the range, drop it.
  let lead = to - 1;
  while (lead >= from && ((bytes[lead] as number) & 0xc0) === 0x80) lead -= 1;
  if (lead >= from && lead + widthOf(bytes[lead] as number) > to) to = lead;
  return { text: decodeUtf8(bytes.subarray(from, to)), start: offset + from, end: offset + to };
}
