/**
 * Taxonomy — controlled vocabulary for tagging content. A `ConceptScheme` is a
 * named vocabulary (e.g. "Topics"); a `Concept` is a term within a scheme that
 * may nest under a broader concept (a hierarchy). `Tag`s are flat, free labels.
 *
 * Entries carry `EntryMetadata` associating them with tags and concepts — cross
 * cutting editorial metadata that lives outside the content-type field schema,
 * is delivered with the entry, and is filterable.
 */

export interface ConceptScheme {
  readonly id: string;
  readonly name: string;
}

export interface Concept {
  readonly id: string;
  readonly schemeId: string;
  readonly prefLabel: string;
  /** The broader (parent) concept, or null at the top of the hierarchy. */
  readonly broaderId: string | null;
}

export interface Tag {
  readonly id: string;
  readonly name: string;
}

/** The taxonomy associations attached to an entry. */
export interface EntryMetadata {
  readonly tags: readonly string[];
  readonly concepts: readonly string[];
}

export const EMPTY_METADATA: EntryMetadata = { tags: [], concepts: [] };

/**
 * Validates that setting `broaderId` on `conceptId` would not create a cycle,
 * given the existing parent links. `parentOf` returns a concept's current
 * broader id (or null). Throws nothing — returns true when the link is safe.
 */
export function isAcyclicBroader(
  conceptId: string,
  broaderId: string | null,
  parentOf: (id: string) => string | null,
): boolean {
  if (broaderId === null) return true;
  if (broaderId === conceptId) return false;
  const seen = new Set<string>([conceptId]);
  let current: string | null = broaderId;
  while (current) {
    if (seen.has(current)) return false;
    seen.add(current);
    current = parentOf(current);
  }
  return true;
}
