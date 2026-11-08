/**
 * The last check before a value is written into a CSS custom property.
 *
 * Token props are enums: the admin sends a token name and the frontend
 * resolves it from the block manifest, so no CSS crosses the channel. This is
 * the second line, for any value that does reach a stylesheet: it rejects the
 * whole value rather than escaping part of it, because a partly escaped value
 * is a value nobody reviewed.
 */

/** The only CSS functions a token value may call. */
export const TOKEN_VALUE_FUNCTIONS: readonly string[] = [
  'var',
  'calc',
  'clamp',
  'min',
  'max',
  'rgb',
  'rgba',
  'hsl',
  'hsla',
  'oklch',
];

const MAX_LENGTH = 256;

/**
 * Whether `value` is safe to write into a custom property: no `url(` or other
 * fetching function, no `@import`, no `expression(` or `javascript:`, no angle
 * brackets, backslashes (CSS escapes can spell any of those), quotes,
 * semicolons or braces (which end a declaration or a rule), no comments, and
 * no function call outside {@link TOKEN_VALUE_FUNCTIONS}.
 */
export function isSafeTokenValue(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_LENGTH) return false;
  // Control characters (newlines included) and the characters that escape,
  // quote, comment or end a declaration. Escapes go first: `u\rl(` is `url(`.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point.
  if (/[\u0000-\u001f\u007f\\<>"'`;{}@!]|\/\*|\*\//.test(value)) return false;
  const lower = value.toLowerCase();
  if (lower.includes('javascript:') || lower.includes('expression')) return false;
  // Every function call, wherever it sits, must be on the allowlist. A bare
  // parenthesis is grouping inside `calc`, not a call.
  for (const match of lower.matchAll(/([a-z0-9_-]*)\s*\(/g)) {
    const name = match[1] ?? '';
    if (name !== '' && !TOKEN_VALUE_FUNCTIONS.includes(name)) return false;
  }
  return true;
}
