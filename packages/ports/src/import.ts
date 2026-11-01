/**
 * Reading content out of somewhere else.
 *
 * A source's only job is to turn a payload into flat, neutral records. It does
 * not know about content types, locales, or this platform's shapes — mapping
 * those is the import pipeline's job, and keeping the two apart is what lets a
 * new source be a parser rather than a migration.
 */

/** One thing found in the source, before it means anything here. */
export interface SourceRecord {
  /**
   * The record's identity in the system it came from.
   *
   * Carried so a re-run recognises what it already imported instead of
   * duplicating it — the single most common way a migration goes wrong.
   */
  readonly externalId: string;
  /** Source-shaped values, keyed by whatever the source calls its fields. */
  readonly values: Readonly<Record<string, unknown>>;
  /** What the source considers this to be ("post", "page", a sheet name). */
  readonly kind?: string;
}

export interface SourceReadResult {
  readonly records: readonly SourceRecord[];
  /**
   * Every field name seen, in the order the source presents them.
   *
   * This is what a mapping screen offers, so it must include fields that are
   * empty in the sample — a column that is blank in the first ten rows is
   * still a column.
   */
  readonly fields: readonly string[];
  /**
   * What the source could not read. Named rather than dropped: an import that
   * silently skips a malformed row is how content disappears.
   */
  readonly warnings: readonly string[];
}

/**
 * A reader for one external format.
 *
 * Kept a port rather than a plain function because a source is not always a
 * parser: pulling from a live API is the same seam with I/O behind it.
 */
export interface ImportSource {
  /** Stable identifier, e.g. `csv`, `json`. */
  readonly id: string;
  /** Human-facing name for a chooser. */
  readonly name: string;
  read(payload: string, options?: Readonly<Record<string, unknown>>): Promise<SourceReadResult>;
}
