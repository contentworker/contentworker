/**
 * Shared scalar and value types for the domain core.
 * Nothing here imports any infrastructure.
 */

/** Identifier of a space, the isolation boundary inside a deployment. A space holds many environments. */
export type SpaceId = string;
/** An environment is a branch within a space (e.g. "main", "staging"). */
export type EnvironmentId = string;

/**
 * The scope every domain operation is performed within. Carrying this through
 * every use-case is what keeps spaces isolated from each other by construction.
 */
export interface Scope {
  readonly spaceId: SpaceId;
  readonly environmentId: EnvironmentId;
}

/** BCP-47 locale code, e.g. "en-US". */
export type LocaleCode = string;

/**
 * A field value keyed by locale. Non-localized fields still use this shape with
 * a single entry under the space's default locale, keeping the read/write paths
 * uniform.
 *
 * Example: { "en-US": "Hello", "de-DE": "Hallo" }
 */
export type LocalizedValue = Record<LocaleCode, unknown>;

/** The full set of field values for an entry: fieldApiId -> locale -> value. */
export type EntryFields = Record<string, LocalizedValue>;

/** Lifecycle status of an entry. */
export type EntryStatus = 'draft' | 'changed' | 'published' | 'archived';

/** Lifecycle status of a content type definition. */
export type ContentTypeStatus = 'draft' | 'published';
