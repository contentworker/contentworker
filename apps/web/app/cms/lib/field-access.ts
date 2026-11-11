import type { ContentType, EntryFields } from '@contentworker/domain';
import type { PrincipalInfo } from './management';

/**
 * What the signed-in person's role lets them do with a content type's fields, as the api resolves
 * their grants (`fieldRules` on the space's `auth/me`). The admin decides nothing here: it reads
 * the names the server sends and leaves those fields be, so it never offers an edit the save would
 * refuse. Field rules name top-level fields only; nothing inside a block or a component is ruled
 * on its own.
 */
export interface FieldAccess {
  /** Fields the role may not read: not drawn, not judged, not sent (the save keeps them). */
  readonly hidden: ReadonlySet<string>;
  /** Fields it may read but not change: drawn read-only, not sent (the save keeps them). */
  readonly readOnly: ReadonlySet<string>;
}

export const OPEN_FIELDS: FieldAccess = { hidden: new Set(), readOnly: new Set() };

/** Why a field its role makes read-only can't be changed, under the field. */
export const READ_ONLY_BY_ROLE = 'Your role can’t change this field';

/**
 * The person's field access on `contentType`: its own grant's rules, else every other type's.
 * Open until the access is read (the server still refuses a write it doesn't allow).
 */
export function fieldAccessFor(
  access: PrincipalInfo | undefined,
  contentType: string,
): FieldAccess {
  const rules = access?.fieldRules;
  if (!rules) return OPEN_FIELDS;
  // Own keys only: a type named `constructor` mustn't read the object's prototype.
  const held = Object.hasOwn(rules.types, contentType) ? rules.types[contentType] : rules.others;
  if (!held || (held.deniedFields.length === 0 && held.readOnlyFields.length === 0)) {
    return OPEN_FIELDS;
  }
  return { hidden: new Set(held.deniedFields), readOnly: new Set(held.readOnlyFields) };
}

/** The type as this person sees it: without the fields their role hides. */
export function withoutHiddenFields(type: ContentType, access: FieldAccess): ContentType {
  if (access.hidden.size === 0) return type;
  return { ...type, fields: type.fields.filter((f) => !access.hidden.has(f.apiId)) };
}

/**
 * What a save sends: the fields without those the role hides or makes read-only. An update keeps
 * what they hold (the api lays the stored values over them), and a create leaves them to their
 * defaults, so leaving them out never clears one, where sending one is a refusal.
 */
export function writableFields(fields: EntryFields, access: FieldAccess): EntryFields {
  if (access.hidden.size === 0 && access.readOnly.size === 0) return fields;
  return Object.fromEntries(
    Object.entries(fields).filter(
      ([apiId]) => !access.hidden.has(apiId) && !access.readOnly.has(apiId),
    ),
  );
}
