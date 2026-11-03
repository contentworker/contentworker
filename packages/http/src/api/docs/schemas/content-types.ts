import {
  FIELD_GUIDANCE_LIMITS,
  MAX_FIELD_RULES,
  RULE_ACTIONS,
  RULE_OPERATORS,
} from '@contentworker/domain';
import { z } from 'zod';

/**
 * A field definition. Recursive (a component's nested fields are field
 * definitions too), so the nested shapes are described as open objects rather
 * than repeating this one: `z.lazy` would emit a `$ref` cycle the reference
 * renderer does not draw well, and the domain validates the deep shape anyway.
 */
const nestedFields = z
  .array(z.object({}).loose())
  .describe('Nested field definitions (this same shape), for a component');

const option = z
  .union([
    z.string().min(1),
    z.number(),
    z.object({
      value: z
        .union([z.string().min(1), z.number()])
        .describe('What an entry stores and is checked against'),
      label: z
        .string()
        .max(FIELD_GUIDANCE_LIMITS.optionLabel)
        .describe('What an editor picks it by'),
    }),
  ])
  .describe('An allowed value, bare or labelled, listed once');

const range = z.object({ min: z.number().optional(), max: z.number().optional() });

/** A field's validation rules. Every rule is optional; an absent rule is not enforced. */
export const fieldValidations = z
  .object({
    in: z
      .array(option)
      .optional()
      .describe(
        'Allowed values (Symbol, Text, Integer, Number). A labelled option stores its `value`',
      ),
    regexp: z
      .object({ pattern: z.string(), flags: z.string().optional() })
      .optional()
      .describe('A pattern a Symbol or Text value must match'),
    range: range.optional().describe('Inclusive bounds of an Integer or Number'),
    size: range
      .optional()
      .describe('Inclusive length of a Symbol, Text or Slug, or item count of an Array'),
    linkContentTypes: z
      .array(z.string())
      .optional()
      .describe('The content types a Link may point at'),
    messages: z
      .object({
        in: z.string().optional(),
        regexp: z.string().optional(),
        range: z.string().optional(),
        size: z.string().optional(),
      })
      .optional()
      .describe(
        `Error text a broken rule reports instead of the default, keyed by rule (at most ${FIELD_GUIDANCE_LIMITS.message} characters). Only for a rule the field declares`,
      ),
  })
  .loose();

/** A conditional rule: hide or disable the field while a sibling's value matches. */
export const fieldRule = z.object({
  action: z
    .enum(RULE_ACTIONS)
    .describe(
      '`hide`: not shown and not required. `disable`: read-only, keeping its stored value; a write that changes it is refused',
    ),
  when: z.object({
    field: z
      .string()
      .describe(
        'The sibling read: another field at the same level, or a dot path into a sibling component (`hero.style`)',
      ),
    operator: z
      .enum(RULE_OPERATORS)
      .describe('`gt` and `lt` compare a number sibling; `empty` and `notEmpty` take no value'),
    value: z
      .union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))])
      .optional()
      .describe('What the sibling is compared with: a list for `in`'),
  }),
});

export const field = z.object({
  apiId: z.string(),
  name: z.string(),
  help: z
    .string()
    .max(FIELD_GUIDANCE_LIMITS.help)
    .optional()
    .describe('How to fill the field: shown under the input in the editor and given to a model'),
  placeholder: z
    .string()
    .max(FIELD_GUIDANCE_LIMITS.placeholder)
    .optional()
    .describe('An example shown in the empty input; never stored'),
  description: z
    .string()
    .max(FIELD_GUIDANCE_LIMITS.description)
    .optional()
    .describe('What the field means, for agents and API readers'),
  type: z
    .string()
    .describe(
      'Field type: Symbol, Slug, Text, RichText, Integer, Number, Boolean, Date, Location, JSON, Link, Component or Array. RichText values are a document tree (`nodeType`/`content`), never HTML; external media is an `embed` node holding structured data',
    ),
  localized: z.boolean(),
  required: z.boolean(),
  position: z.int(),
  unique: z.boolean().optional(),
  defaultValue: z.unknown().optional(),
  validations: fieldValidations.optional(),
  rules: z
    .array(fieldRule)
    .max(MAX_FIELD_RULES)
    .optional()
    .describe(
      'Hide or disable the field while a sibling matches; any matching rule applies. Rules read the values being written, on every surface',
    ),
  linkType: z.enum(['Entry', 'Asset']).optional(),
  fields: nestedFields.optional().describe('Component: the nested field definitions'),
  items: z
    .object({
      type: z.enum(['Symbol', 'Link', 'Component']),
      linkType: z.enum(['Entry', 'Asset']).optional(),
      validations: fieldValidations.optional(),
      fields: nestedFields.optional().describe('Array of Component: the shape of every element'),
      variants: z
        .array(
          z.object({
            apiId: z.string().describe('Stored on each element as `_type`'),
            name: z.string(),
            fields: nestedFields,
          }),
        )
        .optional()
        .describe(
          'Array of Component: a blocks field. Each element is one of these shapes, stored as ' +
            '`{ "_type": <variant apiId>, "_key": <stable id, assigned on write>, ...values }`. ' +
            'Declared instead of `fields`, never with it.',
        ),
    })
    .optional()
    .describe('Array: the element definition'),
});

export const contentType = z.object({
  apiId: z.string(),
  name: z.string(),
  displayField: z.string(),
  fields: z.array(field),
  urlPattern: z
    .string()
    .optional()
    .describe('Where its entries live on the site, e.g. /blog/{slug}'),
  singleton: z
    .literal(true)
    .optional()
    .describe('Holds at most one entry, served at GET …/singletons/:apiId; absent otherwise'),
  version: z.int(),
  status: z.enum(['draft', 'published']),
});

/** A published content type's place on the site, as Delivery serves it (`GET …/routes`). */
export const deliveredRoute = z.object({
  contentType: z.string().describe('Content type apiId'),
  urlPattern: z
    .string()
    .describe('Where its entries live, e.g. /blog/{slug}: {id}, {locale} or a Slug field apiId'),
});

export const deliveredRouteList = z.object({
  items: z.array(deliveredRoute),
  total: z.int(),
});

export const contentTypeEntryCounts = z.object({
  items: z.array(
    z.object({
      contentType: z.string().describe('Content type apiId'),
      total: z.int().describe('Live entries: draft, changed and published (not the trash)'),
      draft: z.int(),
      changed: z.int().describe('Published, with unpublished edits'),
      published: z.int(),
      archived: z.int().describe('In the trash'),
    }),
  ),
});

export const fieldValuesPage = z.object({
  items: z.array(
    z.object({
      value: z.union([z.string(), z.number(), z.boolean()]),
      count: z.int().describe('Entries (not in the trash) whose current version holds the value'),
    }),
  ),
  nextCursor: z.string().optional().describe('Pass back as cursor for the next page'),
});

/** What still depends on a content type (`GET …/content-types/:apiId/dependents`). */
export const contentTypeDependents = z.object({
  contentType: z.string(),
  entries: z.object({
    live: z.int().describe('Outside the trash'),
    trashed: z.int().describe('In the trash'),
  }),
  linkedFrom: z
    .array(
      z.object({
        contentType: z.string(),
        field: z.string().describe('Path, e.g. body.cta.target'),
      }),
    )
    .describe('Other types’ fields whose links are restricted to it'),
  menus: z
    .array(z.object({ id: z.string(), handle: z.string() }))
    .describe('Menus with an item linking one of its entries'),
  redirects: z
    .array(z.object({ id: z.string(), source: z.string() }))
    .describe('Redirects made by a slug change of one of its entries'),
  urlPattern: z.string().optional().describe('Its URL pattern, served as a site route'),
});

/** A content type deleted at once, or a job deleting its entries first. */
export const contentTypeDeletion = z.object({
  deleted: z.boolean().describe('true when the type is gone; false while the job runs'),
  job: z
    .object({
      id: z.string(),
      action: z.literal('content_type_delete'),
      status: z.string(),
      totalItems: z.int(),
      config: z
        .object({
          contentType: z.string(),
          typeDeletion: z
            .object({ deleted: z.boolean(), reason: z.string().optional() })
            .optional()
            .describe(
              'What became of the type, once decided (the job completed or was stopped); ' +
                'absent until then. Also on `GET …/bulk/jobs/:id`.',
            ),
        })
        .loose()
        .optional(),
    })
    .loose()
    .optional()
    .describe('The bulk job deleting its entries; the type goes when it completes cleanly'),
});
