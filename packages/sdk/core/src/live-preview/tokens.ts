/**
 * The second line against styling crossing the channel as CSS. Token props are enums the page
 * resolves from its block manifest; any value it then writes into a CSS custom property must
 * also pass this, or is dropped whole. Nothing is ever escaped into shape: a value that holds any
 * of the patterns below is not a token value, whatever else it holds.
 */

/** The only functions a token value may call. */
const ALLOWED_FUNCTIONS = new Set(['var', 'calc', 'clamp', 'min', 'max', 'rgb', 'hsl', 'oklch']);

/**
 * Refused anywhere, in any case: loading (`url(`, `@import`), script (`expression(`,
 * `javascript:`), markup (`<`, `>`), escapes (`\`, which can spell any of these one character at a
 * time, as in `u\rl(`), comments (which can split a name from its `(`), and the characters that
 * end a declaration or a block (`;`, `{`, `}`). Control characters too.
 */
const REFUSED = /url\s*\(|@import|expression\s*\(|javascript:|[<>\\;{}]|\/\*/i;

/** A name directly before `(`, with or without whitespace between: a function call. */
const CALL = /([a-z_-][a-z0-9_-]*)?\s*\(/gi;

const MAX_LENGTH = 256;

/** Whether `value` may be written into a CSS custom property. */
export function isSafeTokenValue(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAX_LENGTH) return false;
  if (REFUSED.test(value) || hasControl(value)) return false;
  for (const [, name] of value.matchAll(CALL)) {
    // A bare `(` groups inside an allowed call, as in `calc((1rem + 2px) * 2)`.
    if (name !== undefined && !ALLOWED_FUNCTIONS.has(name.toLowerCase())) return false;
  }
  return true;
}

function hasControl(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}
