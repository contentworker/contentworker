import {
  type ContentTypeDraft,
  type ContentTypeOptions,
  defineContentType,
} from '../content-type/content-type';
import { blockVariants, type FieldDefinition } from '../content-type/field';
import { type FieldIssue, ValidationError } from '../errors';
import { MIGRATION_SOURCE_URL_FIELD } from './migration';

/**
 * A template's proposed content model: the content type its pages become. A page is its type's
 * top-level fields (a title, a slug, a date, an author) and one blocks field for its body, whose
 * component variants are the page's block types (a hero, a text section, a gallery). Rich text in
 * a field or a block is a `RichText` field, so it is stored as a document, never as markup.
 *
 * A proposal is recorded on the template while it is authored and becomes a content type only when
 * a person approves it, so whoever writes it (an agent reading the site, an operator) never
 * changes the space's model by proposing.
 */

/**
 * Checks a proposed model and returns it as it will be created. On top of a content type's own
 * rules (`defineContentType`), a template's type:
 *
 * - holds the page's source URL in `sourceUrl` ({@link MIGRATION_SOURCE_URL_FIELD}): a `Symbol`
 *   (or `Text`) field, `unique` and not localized, which a load matches entries on. Added when the
 *   proposal leaves it out; refused when it names one of another shape.
 * - has exactly one top-level blocks field (an Array of Components with variants) for the body.
 * - has a URL pattern, so each migrated page's old path can redirect to its entry's new one.
 *
 * What only a person should decide is left out: a preview URL (where preview tokens are sent),
 * agent instructions (read by every later agent as guidance), the editor layout, and each field's
 * guidance and defaults (`help`, `description`, `placeholder`, `defaultValue`), which a proposal
 * steered by a page's text would otherwise put in front of every editor and agent.
 */
export function checkTemplateModel(
  draft: ContentTypeDraft,
  options: ContentTypeOptions = {},
): ContentTypeDraft {
  const issues: FieldIssue[] = [];
  const given = Array.isArray(draft?.fields) ? draft.fields.map(withoutGuidance) : [];
  const existing = given.find((f) => f?.apiId === MIGRATION_SOURCE_URL_FIELD);
  if (
    existing &&
    ((existing.type !== 'Symbol' && existing.type !== 'Text') ||
      existing.unique !== true ||
      existing.localized)
  ) {
    issues.push({
      field: `fields.${MIGRATION_SOURCE_URL_FIELD}`,
      message: `must be a Symbol (or Text) field, unique and not localized: it is how a migrated page finds its entry again`,
    });
  }
  const fields: FieldDefinition[] = existing
    ? [...given]
    : [
        ...given,
        {
          apiId: MIGRATION_SOURCE_URL_FIELD,
          name: 'Source URL',
          description: 'The page this entry was migrated from.',
          type: 'Symbol',
          localized: false,
          required: false,
          unique: true,
          position:
            Math.max(0, ...given.map((f) => (Number.isFinite(f?.position) ? f.position : 0))) + 1,
        },
      ];
  const blocks = fields.filter((f) => blockVariants(f) !== undefined);
  if (blocks.length !== 1) {
    issues.push({
      field: 'fields',
      message:
        blocks.length === 0
          ? 'needs one top-level blocks field (an Array of Components with variants) for the page body'
          : `has ${blocks.length} top-level blocks fields; a page body goes in exactly one`,
    });
  }
  if (typeof draft?.urlPattern !== 'string' || !draft.urlPattern.trim()) {
    issues.push({
      field: 'urlPattern',
      message: 'is needed so each migrated page can redirect to its entry, e.g. /blog/{slug}',
    });
  }
  if (issues.length > 0) throw new ValidationError(issues);
  const model: ContentTypeDraft = {
    apiId: draft.apiId,
    name: draft.name,
    displayField: draft.displayField,
    fields,
    urlPattern: draft.urlPattern,
    ...(draft.description ? { description: draft.description } : {}),
    ...(draft.group ? { group: draft.group } : {}),
    ...(draft.icon ? { icon: draft.icon } : {}),
  };
  // Every rule a content type keeps (apiIds, field shapes, nesting, the URL pattern's slugs);
  // throws a ValidationError naming the field.
  defineContentType(model, options);
  return model;
}

/** A field, and the fields nested in it, without the text and defaults a person writes. */
function withoutGuidance(field: FieldDefinition): FieldDefinition {
  if (typeof field !== 'object' || field === null) return field;
  const { help: _h, description: _d, placeholder: _p, defaultValue: _v, ...rest } = field;
  const items = rest.items;
  return {
    ...rest,
    ...(rest.fields ? { fields: rest.fields.map(withoutGuidance) } : {}),
    ...(items
      ? {
          items: {
            ...items,
            ...(items.fields ? { fields: items.fields.map(withoutGuidance) } : {}),
            ...(items.variants
              ? {
                  variants: items.variants.map((v) => ({
                    ...v,
                    fields: Array.isArray(v.fields) ? v.fields.map(withoutGuidance) : v.fields,
                  })),
                }
              : {}),
          },
        }
      : {}),
  };
}
