import { ConflictError, ValidationError } from '../errors.js';
import type { ContentTypeStatus } from '../types.js';
import {
  type FieldDefinition,
  isValidApiId,
  MAX_COMPONENT_DEPTH,
  UNIQUE_FIELD_TYPES,
  unsafeRegexReason,
} from './field.js';

/**
 * A content type: the schema for a class of entries. Definitions are versioned
 * and environment-scoped (carried by the repository, not the entity itself).
 */
export interface ContentType {
  readonly apiId: string;
  readonly name: string;
  /** apiId of the field used as the entry's display title. */
  readonly displayField: string;
  readonly fields: readonly FieldDefinition[];
  readonly version: number;
  readonly status: ContentTypeStatus;
}

export interface ContentTypeDraft {
  apiId: string;
  name: string;
  displayField: string;
  fields: FieldDefinition[];
}

/**
 * Validates a content type definition for internal consistency and returns a
 * normalized `ContentType` at version 1, status "draft". Throws on invalid
 * input so callers never persist a malformed schema.
 */
export function defineContentType(draft: ContentTypeDraft): ContentType {
  if (!isValidApiId(draft.apiId)) {
    throw new ValidationError([
      { field: 'apiId', message: `Invalid content type apiId "${draft.apiId}"` },
    ]);
  }
  assertFieldsValid(draft.fields, draft.displayField);
  return {
    apiId: draft.apiId,
    name: draft.name,
    displayField: draft.displayField,
    fields: [...draft.fields].sort((a, b) => a.position - b.position),
    version: 1,
    status: 'draft',
  };
}

/** Produces the next version of a content type from an edited field set. */
export function reviseContentType(
  current: ContentType,
  changes: Partial<Pick<ContentTypeDraft, 'name' | 'displayField' | 'fields'>>,
): ContentType {
  const fields = changes.fields ?? [...current.fields];
  const displayField = changes.displayField ?? current.displayField;
  assertFieldsValid(fields, displayField);
  return {
    ...current,
    name: changes.name ?? current.name,
    displayField,
    fields: [...fields].sort((a, b) => a.position - b.position),
    version: current.version + 1,
    status: 'draft',
  };
}

function assertFieldsValid(fields: readonly FieldDefinition[], displayField: string): void {
  const seen = assertFieldSetValid(fields, '', 0);
  if (fields.length > 0 && !seen.has(displayField)) {
    throw new ValidationError([
      { field: 'displayField', message: `displayField "${displayField}" is not a defined field` },
    ]);
  }
}

/**
 * Checks one level of field definitions, recursing into components.
 *
 * `path` prefixes every message so an author editing a deep group is told which
 * field is wrong, not merely that something is. `depth` counts components
 * entered so far; 0 is the content type's own field list.
 */
function assertFieldSetValid(
  fields: readonly FieldDefinition[],
  path: string,
  depth: number,
): Set<string> {
  const seen = new Set<string>();
  const at = (f: FieldDefinition) => (path ? `${path}.${f.apiId}` : f.apiId);

  for (const f of fields) {
    const where = at(f);
    if (!isValidApiId(f.apiId)) {
      throw new ValidationError([{ field: where, message: `Invalid field apiId "${f.apiId}"` }]);
    }
    if (seen.has(f.apiId)) {
      throw new ConflictError(`Duplicate field apiId "${where}"`);
    }
    seen.add(f.apiId);
    const rx = f.validations?.regexp;
    if (rx) {
      const reason = unsafeRegexReason(rx.pattern, rx.flags);
      if (reason) throw new ValidationError([{ field: where, message: reason }]);
    }
    // Refuse `unique` where it cannot mean anything, rather than accepting the
    // declaration and quietly never enforcing it.
    if (f.unique && !UNIQUE_FIELD_TYPES.includes(f.type)) {
      throw new ValidationError([{ field: where, message: `A ${f.type} field cannot be unique` }]);
    }

    if (depth > 0) assertNestedFieldAllowed(f, where);

    const isComponent = f.type === 'Component' || f.items?.type === 'Component';
    if (!isComponent) {
      // Declaring a shape on a field that is not a component means the author
      // expected nesting they will not get. Checked on both places it could be
      // written, so neither is silently dropped.
      if (f.fields || f.items?.fields) {
        throw new ValidationError([
          { field: where, message: `A ${f.type} field cannot define nested fields` },
        ]);
      }
      continue;
    }

    const nested = f.type === 'Component' ? f.fields : f.items?.fields;
    if (!nested || nested.length === 0) {
      throw new ValidationError([
        { field: where, message: 'A component must define at least one field' },
      ]);
    }
    if (depth + 1 > MAX_COMPONENT_DEPTH) {
      throw new ValidationError([
        {
          field: where,
          message: `Components may nest ${MAX_COMPONENT_DEPTH} deep at most. Model anything deeper as its own content type and link to it.`,
        },
      ]);
    }
    assertFieldSetValid(nested, where, depth + 1);
  }
  return seen;
}

/** The attributes a nested field may not carry. See COMPONENT_NESTED_RULES. */
function assertNestedFieldAllowed(f: FieldDefinition, where: string): void {
  if (f.localized) {
    throw new ValidationError([
      {
        field: where,
        message:
          'A field inside a component cannot be localized on its own; ' +
          'localize the component field that holds it.',
      },
    ]);
  }
  if (f.unique) {
    throw new ValidationError([
      { field: where, message: 'A field inside a component cannot be unique' },
    ]);
  }
  if (f.type === 'Slug') {
    throw new ValidationError([
      {
        field: where,
        message:
          'A Slug cannot live inside a component: slugs are normalized from the ' +
          "entry's top-level fields, so a nested one would never be normalized.",
      },
    ]);
  }
}
