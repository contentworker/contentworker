/** A person's letters for a row's tile: first and last of their name, or the first of their email. */
export function initials(name: string | null | undefined, email: string): string {
  const words = name?.trim().split(/\s+/).filter(Boolean) ?? [];
  const letters = words.length ? [words[0], words.length > 1 ? words.at(-1) : undefined] : [email];
  return letters
    .map((word) => (word ? (Array.from(word)[0] ?? '') : ''))
    .join('')
    .toUpperCase();
}
